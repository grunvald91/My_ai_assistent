// bgjob.mjs — фоновый ответ тяжёлой модели в GitHub Actions (там нет лимита ~30 с на вызов бота).
// Забирает запрос у бота (эндпоинт bgjob_get), ждёт ответ модели и отдаёт его боту (bgjob_part / bgjob_done).
// Репозиторий публичный: текст запроса и ответа НИКУДА не печатаем — в лог идут только служебные строки без содержимого.
import { spawnSync } from 'node:child_process';
import JSON5 from 'json5';
import { createLlm } from '../tgcloud/lib/llm.js';
import { splitSafe } from '../tgcloud/lib/bg.js';
import { decideMessages, parseDecision, exaRequest, exaResults, applyResults, sourcesNote, isLiveTransitQuestion, transitQuery, requiresFreshSearch, freshSearchQuery } from '../tgcloud/lib/exa.js';
import { API_BASE, DEFAULTS } from '../tgcloud/lib/config.js';
import { understandTransitQuestion } from '../tgcloud/lib/transit.js';
import { lookupRussianTransit } from '../tgcloud/lib/yandex-rasp.js';

const env = (k) => (process.env[k] ?? '').trim();
const JOB = env('JOB_ID');
const YANDEX_RASP_KEY = /^(1|true)$/i.test(env('YANDEX_RASP_ALLOWED')) ? (env('YANDEX_API') || env('YANDEX_RASP_API_KEY')) : '';
const OWNER = env('OWNER_IDS').split(/[,;\s]+/)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/** Начало строки до конца первого сбалансированного {…} или […] (с учётом кавычек); иначе строка целиком. */
function balanced(text) {
  const open = text[0];
  if (open !== '{' && open !== '[') return text.split(/\s/)[0];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return text.slice(0, i + 1);
  }
  return text;
}

/** Вызов эндпоинта бота (с повторами). Возвращает разобранный результат или null. Вывод не печатаем. */
function callBot(name, payload) {
  const ctx = `{ initData: { user: { id: ${OWNER} } } }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('npx', ['--no-install', 'tgcloud', 'run', `endpoints/${name}`, JSON.stringify(payload), '--ctx', ctx], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      const lines = String(r.stdout).split('\n');
      const at = lines.findIndex((l) => l.replace(/\u001b\[[0-9;]*m/g, '').startsWith('< '));
      if (at < 0) {
        // содержимое не печатаем — только форма вывода
        console.error(`endpoints/${name}: нет строки результата; строк ${lines.length}, начала: ${lines.slice(0, 8).map((l) => JSON.stringify(l.slice(0, 4))).join(' ')}; stderr ${String(r.stderr).length} симв.`);
        return {};
      }
      // результат — «< {…}», за ним на той же строке платформа дописывает служебную пометку (время): берём только сбалансированный объект
      const line = lines[at].replace(/\u001b\[[0-9;]*m/g, '').trim().slice(2);
      try {
        return JSON5.parse(balanced(line));
      } catch (e) {
        console.error(`endpoints/${name}: результат не разобрался (${String(e?.message).slice(0, 120)}); длина ${line.length}`);
        return {};
      }
    }
    console.error(`endpoints/${name}: попытка ${attempt} не удалась (код ${r.status})`);
  }
  return null;
}

async function deliver({ text = '', finish = null, usage = null, model = '', error = null, snote = null }) {
  const parts = splitSafe(text);
  for (let i = 0; i < parts.length; i++) {
    if (!callBot('bgjob_part', { job: JOB, i, text: parts[i] })) throw new Error('не удалось передать боту часть ' + (i + 1));
  }
  if (!callBot('bgjob_done', { job: JOB, n: parts.length, finish, usage, model, error, ...(snote ? { snote } : {}) })) throw new Error('не удалось сообщить боту итог');
}

/**
 * Поиск в интернете (Exa) для фонового ответа: при { asked } сначала быстрая модель решает, нужен ли он; при { query } — уже решено.
 * Найденное дописывается к последнему сообщению пользователя в запросе. Возвращает подпись под ответом или null. Содержимое не печатаем.
 */
async function webSearch(llm, req, extra) {
  const key = env('EXA_API_KEY');
  if (!key) return '🔎 Exa не выполнен в фоновой задаче: ключ EXA_API_KEY недоступен.';
  let query = req.search.query ?? '';
  if (!query && isLiveTransitQuestion(req.search.asked ?? '')) {
    query = transitQuery(req.search.asked, req.search.date ?? '');
    console.log('Поиск расписания обязателен; решатель пропущен');
  }
  if (!query && requiresFreshSearch(req.search.asked ?? '')) {
    query = freshSearchQuery(req.search.asked, req.search.date ?? '');
    console.log('Свежие данные: поиск обязателен');
  }
  if (!query) {
    let decision = null;
    for (const id of DEFAULTS.fastModels) {
      try {
        const r = await llm.chat({ model: id, messages: decideMessages(req.messages, req.search.asked ?? '', req.search.date ?? ''), maxTokens: 150, retries: 1 });
        extra.in += r.usage?.in ?? 0;
        extra.out += r.usage?.out ?? 0;
        decision = parseDecision(r.text);
        break;
      } catch (e) {
        console.error('Решатель поиска: модель', id, 'не ответила:', String(e?.kind ?? e?.message ?? e).slice(0, 80));
      }
    }
    console.log('Поиск нужен:', !!decision?.search);
    if (!decision?.search) return null;
    query = decision.query;
  }
  try {
    const results = await exaResults(await exaRequest(fetch, key, query));
    console.log('Поиск: найдено', results.length);
    if (!results.length) return `🔎 Искал в интернете «${query}» — ничего не нашлось, отвечаю без поиска.`;
    if (!applyResults(req.messages, query, results, req.search.date ?? '')) return null;
    return sourcesNote(query, results);
  } catch (e) {
    console.error('Поиск не получился:', String(e?.message ?? e).slice(0, 120));
    return '🔎 Поиск в интернете не получился — отвечаю без него.';
  }
}

async function main() {
  if (!JOB) throw new Error('не задан id задачи');
  const first = callBot('bgjob_get', { job: JOB, i: 0 });
  if (!first || typeof first.text !== 'string') throw new Error('бот не отдал запрос (задача отменена или устарела)');
  let raw = first.text;
  for (let i = 1; i < Number(first.n ?? 1); i++) {
    const part = callBot('bgjob_get', { job: JOB, i });
    if (!part || typeof part.text !== 'string') throw new Error('бот не отдал часть запроса ' + (i + 1));
    raw += part.text;
  }
  const req = JSON.parse(raw);
  console.log('Запрос получен: модель', req.model, ', сообщений', req.messages?.length ?? 0, ', размышления', req.think ?? 'off');

  if (req.transitIntent) {
    // Telegram Serverless has a ~30s invocation limit. If semantic parsing times
    // out there, do AI understanding AND the provider lookup here, not a canned error.
    const intent = req.transitIntent;
    const llm = createLlm({ fetch, apiKey: env('CLAUDEHUB_API_KEY'), base: API_BASE, sleep, retries: 1 });
    const models = [...new Set([req.model, 'claude-haiku-4.5', 'claude-sonnet-5-5'].filter(Boolean))];
    let plan;
    let activeModel = req.model;
    const usage = { in: 0, out: 0 };
    let lastError;
    for (const id of models) {
      try {
        const decision = await understandTransitQuestion(
          intent.question, intent.previous ?? null, Math.floor(Date.now() / 1000),
          Number(intent.timezoneHours ?? 3),
          async (messages) => {
            const result = await llm.chat({
              model: id, messages, maxTokens: 360, stream: false, retries: 1,
              deadline: Date.now() + 30000,
            });
            usage.in += result.usage?.in ?? 0;
            usage.out += result.usage?.out ?? 0;
            return result.text;
          },
        );
        if (!decision || decision.intent === 'other') throw new Error('ИИ не нашёл подтверждённого запроса расписания');
        plan = decision;
        activeModel = id;
        break;
      } catch (e) {
        lastError = e;
        console.warn('Tutu AI intent retry:', id, String(e?.kind ?? e?.message ?? e).slice(0, 80));
      }
    }
    if (!plan) throw new Error('ИИ-разбор маршрута недоступен после повторной попытки: ' +
      String(lastError?.kind ?? lastError?.message ?? lastError).slice(0, 100));
    if (plan.intent === 'clarify') {
      const missing = plan.missingOrigin && !plan.missingDestination ? 'откуда отправляемся' :
        plan.missingDestination && !plan.missingOrigin ? 'куда нужно ехать' : 'откуда и куда нужно ехать';
      await deliver({ text: 'Уточни, пожалуйста, ' + missing + '.', model: activeModel, usage });
      return;
    }
    const signal = AbortSignal.timeout(65000);
    const lookup = await lookupRussianTransit((url, opts) => fetch(url, { ...opts, signal }),
      YANDEX_RASP_KEY, plan.plan, Math.floor(Date.now() / 1000), { deadlineMs: 0 });
    if (!lookup.text) throw new Error('Ни один источник не подтвердил расписание');
    await deliver({ text: lookup.text, model: activeModel, usage });
    return;
  }

  if (req.transit) {
    // Deterministic provider response, no language model and no invented departures.
    const signal = AbortSignal.timeout(65000); // maximum total for all provider pages
    const lookup = await lookupRussianTransit((url, opts) => fetch(url, { ...opts, signal }),
      YANDEX_RASP_KEY, req.transit, Math.floor(Date.now() / 1000), { deadlineMs: 0 });
    if (!lookup.text) throw new Error('Ни один источник не подтвердил расписание');
    await deliver({ text: lookup.text, model: lookup.source === 'yandex' ? 'yandex-rasp-api' : 'tutu-mcp' });
    return;
  }
  const llm = createLlm({ fetch, apiKey: env('CLAUDEHUB_API_KEY'), base: API_BASE, sleep, retries: 3 });
  const extra = { in: 0, out: 0 }; // расход «решателя» поиска — добавим к итогу
  const snote = req.search ? await webSearch(llm, req, extra) : null;
  if (req.messages?.[0]?.role === 'system') {
    const resultStatus = !req.search ? 'Для этого запроса Exa не запускался.' :
      snote?.startsWith('🔎 Искал в интернете:') ? 'Exa выполнен; выдержки источников добавлены в запрос.' :
      snote ? 'Exa не дал проверенных данных (' + snote.slice(0, 150) + '). Не придумывай текущие цифры.' :
      'Exa не запускался по решению маршрутизатора. Не утверждай, что веб-поиск выполнен.';
    req.messages[0].content += '\n\nИТОГ ВЕБ-ПОИСКА В ФОНЕ: ' + resultStatus;
  }
  let n = 0;
  const res = await llm.chat({
    model: req.model,
    messages: req.messages,
    maxTokens: req.maxTokens,
    stream: true,
    think: req.think ? { level: req.think, budget: DEFAULTS.thinkBudgets[req.think] } : null,
    onProgress: () => {
      if (++n % 200 === 0) console.log('…пишу, получено порций:', n);
      return false;
    },
  });
  console.log('Готово. Символов:', res.text.length, 'finish:', res.finish);
  const usage = res.usage ? { in: (res.usage.in ?? 0) + extra.in, out: (res.usage.out ?? 0) + extra.out } : null;
  await deliver({ text: res.text, finish: res.finish, usage, model: req.model, snote });
}

try {
  await main();
} catch (e) {
  const msg = e?.userMessage || String(e?.message ?? e);
  console.error('Ошибка задачи:', msg.slice(0, 300));
  try {
    await deliver({ error: msg.slice(0, 500) });
  } catch (e2) {
    console.error('И сообщить боту не удалось:', String(e2?.message ?? e2).slice(0, 200));
  }
  process.exit(1);
}
