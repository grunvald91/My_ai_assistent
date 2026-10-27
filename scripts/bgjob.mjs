// bgjob.mjs — фоновый ответ тяжёлой модели в GitHub Actions (там нет лимита ~30 с на вызов бота).
// Забирает запрос у бота (эндпоинт bgjob_get), ждёт ответ модели и отдаёт его боту (bgjob_part / bgjob_done).
// Репозиторий публичный: текст запроса и ответа НИКУДА не печатаем — в лог идут только служебные строки без содержимого.
import { spawnSync } from 'node:child_process';
import JSON5 from 'json5';
import { createLlm } from '../tgcloud/lib/llm.js';
import { splitSafe } from '../tgcloud/lib/bg.js';
import { API_BASE, DEFAULTS } from '../tgcloud/lib/config.js';

const env = (k) => (process.env[k] ?? '').trim();
const JOB = env('JOB_ID');
const OWNER = env('OWNER_IDS').split(/[,;\s]+/)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Вызов эндпоинта бота (с повторами). Возвращает разобранный результат или null. Вывод не печатаем. */
function callBot(name, payload) {
  const ctx = `{ initData: { user: { id: ${OWNER} } } }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('npx', ['--no-install', 'tgcloud', 'run', `endpoints/${name}`, JSON.stringify(payload), '--ctx', ctx], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      const lines = String(r.stdout).split('\n');
      const at = lines.findIndex((l) => l.startsWith('< '));
      if (at < 0) return {};
      try {
        return JSON5.parse(lines.slice(at).join('\n').slice(2).trim());
      } catch {
        return {};
      }
    }
    console.error(`endpoints/${name}: попытка ${attempt} не удалась (код ${r.status})`);
  }
  return null;
}

async function deliver({ text = '', finish = null, usage = null, model = '', error = null }) {
  const parts = splitSafe(text);
  for (let i = 0; i < parts.length; i++) {
    if (!callBot('bgjob_part', { job: JOB, i, text: parts[i] })) throw new Error('не удалось передать боту часть ' + (i + 1));
  }
  if (!callBot('bgjob_done', { job: JOB, n: parts.length, finish, usage, model, error })) throw new Error('не удалось сообщить боту итог');
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

  const llm = createLlm({ fetch, apiKey: env('CLAUDEHUB_API_KEY'), base: API_BASE, sleep, retries: 3 });
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
  await deliver({ text: res.text, finish: res.finish, usage: res.usage, model: req.model });
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
