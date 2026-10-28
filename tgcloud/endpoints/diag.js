// endpoints/diag.js — диагностика бота «изнутри» серверов Telegram. Запускается вручную workflow «Diagnostics»
// (tgcloud run endpoints/diag). Только для владельца. Отчёт не содержит текстов переписки, id чатов и имён репозиториев:
// workflow выводит его в лог Actions, а репозиторий публичный.

import { db, api, fetch, EndpointError } from 'sdk';
import { desc, eq, sql } from 'sdk/db';
import * as T from '../schema.js';
import { OWNER_IDS, CLAUDEHUB_API_KEY, GH_PAT, SELF_REPO, EXA_API_KEY } from '../lib/secrets.js';
import { API_BASE } from '../lib/config.js';
import { parseIdList } from '../lib/util.js';
import { timeout } from '../lib/timer.js';
import { createLlm } from '../lib/llm.js';
import { ping } from '../lib/store.js';
import { app } from '../lib/deps.js';

const MAX_PROBE_MS = 60000; // чтобы сама диагностика не повисла, если сервис молчит

async function probe(name, run) {
  const t0 = Date.now();
  let timer;
  try {
    const guard = new Promise((_, rej) => {
      if (typeof setTimeout === 'function') timer = setTimeout(() => rej(new Error('нет ответа за ' + MAX_PROBE_MS / 1000 + ' с')), MAX_PROBE_MS);
    });
    const r = await Promise.race([run(), guard]);
    return { name, ok: true, ms: Date.now() - t0, ...r };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function (input, ctx) {
  const uid = ctx?.initData?.user?.id;
  if (!parseIdList(OWNER_IDS).includes(uid)) throw new EndpointError('Только для владельца', { code: 'FORBIDDEN' });

  const now = Math.floor(Date.now() / 1000);
  const owner = parseIdList(OWNER_IDS)[0];

  // журнал: что и когда происходило (payload — только у ошибок и замеров ИИ)
  const rows = await db.select().from(T.journal).orderBy(desc(T.journal.id)).limit(80).all();
  const KEEP = new Set(['error', 'llm', 'llm_fail', 'group_cap', 'code_secret_blocked']);
  const journal = rows.map((r) => ({
    ago_s: now - r.ts,
    type: r.type,
    chat: r.chatId == null ? '-' : r.chatId === owner ? 'owner' : 'other',
    ...(KEEP.has(r.type) && r.payload ? { data: JSON.parse(JSON.stringify(r.payload, (k, v) => (typeof v === 'string' ? v.slice(0, 200) : v))) } : {}),
  }));

  // апдейты, которые начали обрабатываться и не закончили: признак зависшего или убитого платформой вызова
  const stuck = await db.select().from(T.updates).where(eq(T.updates.status, 'run')).orderBy(desc(T.updates.ts)).limit(20).all();

  const probes = [
    await probe('ClaudeHub /v1/models', async () => {
      const r = await fetch(API_BASE + '/v1/models');
      return { status: r.status };
    }),
    await probe('ClaudeHub чат (1 токен)', async () => {
      const r = await fetch(API_BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + CLAUDEHUB_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4.5', messages: [{ role: 'user', content: 'ок' }], max_tokens: 1 }),
      });
      return { status: r.status };
    }),
    // может ли токен бота запускать workflow в репозитории бота (нужно для /code через Actions); mode=ping ничего не делает
    await probe('Запуск codejob.yml токеном бота', async () => {
      if (!GH_PAT || !SELF_REPO) return { status: 0, note: 'нет GH_PAT или имени репозитория' };
      const h = { Authorization: 'Bearer ' + GH_PAT, Accept: 'application/vnd.github+json', 'User-Agent': 'diag', 'Content-Type': 'application/json' };
      const repo = await (await fetch('https://api.github.com/repos/' + SELF_REPO, { headers: h })).json();
      const r = await fetch(`https://api.github.com/repos/${SELF_REPO}/actions/workflows/codejob.yml/dispatches`, { method: 'POST', headers: h, body: JSON.stringify({ ref: repo.default_branch ?? 'main', inputs: { job: 'diagping', mode: 'ping' } }) });
      return { status: r.status, note: r.ok ? '' : String((await r.text()).slice(0, 150)) };
    }),
    await probe('GitHub API', async () => {
      const r = await fetch('https://api.github.com/zen', { headers: { 'User-Agent': 'diag' } });
      return { status: r.status };
    }),
  ];

  // последние апдейты (любого статуса): доходят ли сообщения до бота и чем заканчиваются
  const recent = await db.select().from(T.updates).orderBy(desc(T.updates.updateId)).limit(12).all();
  // вебхук: ждёт ли Telegram доставки и какая последняя ошибка доставки (не текст переписки)
  let webhook;
  try {
    const w = await api.getWebhookInfo();
    webhook = { pending: w.pending_update_count, last_error_age_s: w.last_error_date ? now - w.last_error_date : null, last_error: String(w.last_error_message ?? '').slice(0, 200), max_conn: w.max_connections };
  } catch (e) {
    webhook = { error: String(e?.message ?? e).slice(0, 150) };
  }
  // запись в БД работает?
  let dbWrite;
  try {
    await db.insert(T.journal).values({ type: 'diag', chatId: null, payload: null, ts: now }).run();
    dbWrite = 'ok';
  } catch (e) {
    dbWrite = String(e?.message ?? e).slice(0, 150);
  }

  // что умеет среда выполнения (нужно для работы с файлами)
  const env = {
    DecompressionStream: typeof DecompressionStream,
    CompressionStream: typeof CompressionStream,
    TextDecoder: typeof TextDecoder,
    TextEncoder: typeof TextEncoder,
    atob: typeof atob,
    btoa: typeof btoa,
    Blob: typeof Blob,
    setTimeout: typeof setTimeout,
    setInterval: typeof setInterval,
    AbortController: typeof AbortController,
    AbortSignal_timeout: typeof AbortSignal !== 'undefined' ? typeof AbortSignal.timeout : 'no AbortSignal',
    scheduler: typeof scheduler,
    Atomics_waitAsync: typeof Atomics !== 'undefined' ? typeof Atomics.waitAsync : 'no Atomics',
    queueMicrotask: typeof queueMicrotask,
    performance: typeof performance,
    MessageChannel: typeof MessageChannel,
  };

  // Есть ли в среде хоть какой-то таймер: AbortSignal.timeout обрывает долгий запрос сам, без setTimeout
  const timers = await probe('AbortSignal.timeout обрывает запрос', async () => {
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return { note: 'нет AbortSignal.timeout' };
    const t = Date.now();
    try {
      await fetch('https://httpbin.org/delay/4', { signal: AbortSignal.timeout(500) });
      return { aborted: false, took_ms: Date.now() - t, note: 'запрос дошёл до конца, таймер не сработал (или сервис недоступен)' };
    } catch (e) {
      return { aborted: true, took_ms: Date.now() - t, note: String(e?.name ?? '') + ' ' + String(e?.message ?? e).slice(0, 80) };
    }
  });

  // Atomics.waitAsync как таймер: обычных таймеров в среде нет. Проверяем без риска зависнуть: ждём не await'ом, а опросом БД (до 3 с)
  const atomicsTimer = await probe('Atomics.waitAsync как таймер', async () => {
    if (typeof SharedArrayBuffer === 'undefined') return { note: 'нет SharedArrayBuffer' };
    const out = {};
    const poll = async (flag, limitMs) => {
      const t = Date.now();
      let n = 0;
      while (!flag.done && Date.now() - t < limitMs) {
        await db.get(sql`SELECT 1 AS x`);
        n++;
      }
      return n;
    };
    // 1) таймер 200 мс
    {
      const ia = new Int32Array(new SharedArrayBuffer(4));
      const flag = { done: false };
      const t = Date.now();
      const r = Atomics.waitAsync(ia, 0, 0, 200);
      out.sync_result = r.async ? 'async' : String(r.value);
      Promise.resolve(r.async ? r.value : r.value).then((v) => Object.assign(flag, { done: true, v: String(v), ms: Date.now() - t }));
      out.polls1 = await poll(flag, 3000);
      out.timer200 = flag.done ? { fired: true, result: flag.v, ms: flag.ms } : { fired: false };
    }
    // 2) notify будит ожидание
    {
      const ia = new Int32Array(new SharedArrayBuffer(4));
      const flag = { done: false };
      const t = Date.now();
      const r = Atomics.waitAsync(ia, 0, 0, 60000);
      Promise.resolve(r.value).then((v) => Object.assign(flag, { done: true, v: String(v), ms: Date.now() - t }));
      Atomics.notify(ia, 0);
      out.polls2 = await poll(flag, 3000);
      out.notify = flag.done ? { woke: true, result: flag.v, ms: flag.ms } : { woke: false };
    }
    return out;
  });

  // Боевая проверка срока: медленный запрос (httpbin отвечает через 4 с) — кто успеет раньше, срок в 1 с или ответ?
  const slowFetch = () => fetch('https://httpbin.org/delay/4').then(() => 'fetch', () => 'fetch_err');
  const deadlineProbe = await probe('Срок против зависшего запроса', async () => {
    const out = {};
    // A) только Atomics-таймер
    {
      const t0 = Date.now();
      const t = timeout(1000);
      const w = await Promise.race([slowFetch(), t.promise.then(() => 'timer')]);
      t.cancel();
      out.A_timer_only = { winner: w, ms: Date.now() - t0 };
    }
    // B) опрос БД: цикл «запрос к БД → проверка часов», пока идёт запрос
    {
      const t0 = Date.now();
      let n = 0;
      const ticker = (async () => {
        while (Date.now() - t0 < 1000) { await db.get(sql`SELECT 1 AS x`); n++; }
        return 'ticker';
      })();
      const w = await Promise.race([slowFetch(), ticker]);
      out.B_db_ticker = { winner: w, ms: Date.now() - t0, polls: n };
    }
    // C) Atomics-таймер, а рядом крутится цикл опроса БД (держит «пульс»)
    {
      const t0 = Date.now();
      let stop = false;
      let n = 0;
      const pump = (async () => { while (!stop) { await db.get(sql`SELECT 1 AS x`); n++; } })();
      const t = timeout(1000);
      const w = await Promise.race([slowFetch(), t.promise.then(() => 'timer')]);
      stop = true;
      t.cancel();
      await pump;
      out.C_timer_plus_pump = { winner: w, ms: Date.now() - t0, polls: n };
    }
    return out;
  });

  // Сквозная проверка: настоящий клиент модели с пульсом против медленного ответа (4 с) при сроке 1,5 с.
  // Не ждём результат напрямую (вдруг зависнет): запускаем и опрашиваем БД не дольше 8 с, ведя протокол.
  const llmDeadline = await probe('Клиент модели: срок при медленном ответе', async () => {
    const trace = [];
    const t0 = Date.now();
    const mark = (m) => trace.push(m + '@' + (Date.now() - t0));
    const llm = createLlm({
      fetch: () => {
        mark('fetch_called');
        return fetch('https://httpbin.org/delay/4').then((r) => { mark('fetch_resolved'); return r; });
      },
      apiKey: 'x', base: 'https://x.invalid', retries: 0,
      pulse: async () => { await ping(); },
    });
    let outcome = null;
    llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], deadline: Date.now() + 1500 }).then(
      (r) => { outcome = 'вернул: ' + JSON.stringify({ cut: r.cut, finish: r.finish }).slice(0, 100); mark('chat_returned'); },
      (e) => { outcome = 'ошибка: ' + String(e?.kind ?? '') + ' / ' + String(e?.message ?? e).slice(0, 80); mark('chat_threw'); },
    );
    while (outcome === null && Date.now() - t0 < 8000) await ping();
    return { ms: Date.now() - t0, outcome: outcome ?? 'не завершилось за 8 с', trace };
  });

  // Доступен ли с серверов Telegram поиск Exa (без ключа: ждём отказ по ключу — значит, до сервиса дошли)
  const exaReach = await probe('Exa api.exa.ai доступен', async () => {
    const r = await fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'probe-no-key' }, body: JSON.stringify({ query: 'test', contents: { highlights: true } }) });
    const t = await r.text().catch(() => '');
    return { status: r.status, body_start: t.slice(0, 120) };
  });

  // Настоящий поиск Exa с ключом бота (печатаем только число результатов и время, без содержимого)
  const exaSearch = EXA_API_KEY
    ? await probe('Exa поиск с ключом', async () => {
        const r = await fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY }, body: JSON.stringify({ query: 'курс доллара к рублю', type: 'auto', contents: { highlights: true } }) });
        const j = r.ok ? await r.json().catch(() => null) : null;
        return { status: r.status, results: Array.isArray(j?.results) ? j.results.length : null, with_highlights: Array.isArray(j?.results) ? j.results.filter((x) => x.highlights?.length).length : null };
      })
    : { name: 'Exa поиск с ключом', ok: false, error: 'EXA_API_KEY не задан в secrets.js (секрет не добавлен или бот не перевыложен)' };

  // Фоновый ответ через Actions, весь путь без Telegram: первый запуск стартует проверочную задачу, следующий сообщает итог
  const bgTest = input?.bgtest && input.bgtest !== 'no' ? await probe('Фоновый ответ (Actions)', async () => ({ ...(await app.bg.selfTest({ big: input?.bgtest === 'big' })) })) : undefined;

  // метаданные последних сообщений владельца (длина и модель; без текстов)
  const lastMsgs = (await db.select().from(T.messages).where(eq(T.messages.chatKey, String(owner))).orderBy(desc(T.messages.id)).limit(8).all()).map((m) => ({
    role: m.role, chars: m.text.length, model: m.model ?? null, age_s: now - m.ts, clip: m.text.startsWith('📎'), reply: m.text.startsWith('↪️'),
  }));
  const ownerChat = await db.select().from(T.chats).where(eq(T.chats.chatId, owner)).get();
  const sets = {};
  for (const k of ['auto', 'think', 'att_last', 'default_model']) sets[k] = (await db.select().from(T.settings).where(eq(T.settings.key, k)).get())?.value ?? null;

  return {
    now,
    env,
    webhook,
    db_write: dbWrite,
    timers,
    atomicsTimer,
    deadlineProbe,
    llmDeadline,
    exaReach,
    exaSearch,
    search_setting: (await db.select().from(T.settings).where(eq(T.settings.key, 'search')).get())?.value ?? 'вкл',
    ...(bgTest ? { bgTest } : {}),
    last_messages: lastMsgs,
    chat_model: ownerChat?.model ?? null,
    settings: { auto: sets.auto, think: sets.think, att_last: sets.att_last ? 'есть' : null, default_model: sets.default_model },
    recent_updates: recent.map((u) => ({ id: u.updateId, status: u.status, age_s: now - u.ts })),
    probes,
    stuck_updates: stuck.map((u) => ({ id: u.updateId, age_s: now - u.ts })),
    journal,
  };
}
