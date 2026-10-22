// endpoints/diag.js — диагностика бота «изнутри» серверов Telegram. Запускается вручную workflow «Diagnostics»
// (tgcloud run endpoints/diag). Только для владельца. Отчёт не содержит текстов переписки, id чатов и имён репозиториев:
// workflow выводит его в лог Actions, а репозиторий публичный.

import { db, api, fetch, EndpointError } from 'sdk';
import { desc, eq } from 'sdk/db';
import * as T from '../schema.js';
import { OWNER_IDS, CLAUDEHUB_API_KEY, GH_PAT, SELF_REPO } from '../lib/secrets.js';
import { API_BASE } from '../lib/config.js';
import { parseIdList } from '../lib/util.js';

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

  return {
    now,
    webhook,
    db_write: dbWrite,
    recent_updates: recent.map((u) => ({ id: u.updateId, status: u.status, age_s: now - u.ts })),
    probes,
    stuck_updates: stuck.map((u) => ({ id: u.updateId, age_s: now - u.ts })),
    journal,
  };
}
