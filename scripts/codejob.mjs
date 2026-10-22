// codejob.mjs — тяжёлая часть /code в GitHub Actions (там нет лимита ~30 с на вызов, как у бота на серверах Telegram).
// Читает репозиторий, выбирает файлы, пишет код моделью, отправляет сырой ответ боту (эндпоинты codejob_part / codejob_done).
// Бот сам разбирает ответ, проверяет на секреты и показывает предпросмотр — ничего не коммитится без кнопки владельца.
import { spawnSync } from 'node:child_process';
import { createGithub } from '../tgcloud/lib/github.js';
import { createLlm } from '../tgcloud/lib/llm.js';
import { normalizeModels } from '../tgcloud/lib/models.js';
import { listCandidates, parseSelection } from '../tgcloud/lib/codeparse.js';
import { codeSelectSystem, codeSystem } from '../tgcloud/lib/persona.js';
import { API_BASE, DEFAULTS } from '../tgcloud/lib/config.js';

const env = (k) => (process.env[k] ?? '').trim();
const JOB = env('JOB_ID');
const MODE = env('JOB_MODE') || 'run';
const OWNER = env('OWNER_IDS').split(/[,;\s]+/)[0];
const SELF = env('GITHUB_REPOSITORY').toLowerCase();
const CHUNK = 25000; // символов в одной передаче боту: аргумент командной строки ограничен ~128 КБ

if (MODE === 'ping') {
  console.log('pong: Actions доступны боту, задача', JOB);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Вызов эндпоинта бота на серверах Telegram (с повторами). */
function callBot(name, payload) {
  const ctx = `{ initData: { user: { id: ${OWNER} } } }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('npx', ['--no-install', 'tgcloud', 'run', `endpoints/${name}`, JSON.stringify(payload), '--ctx', ctx], { encoding: 'utf8', env: process.env });
    if (r.status === 0) return true;
    console.error(`endpoints/${name}: попытка ${attempt} не удалась:`, (r.stdout + r.stderr).slice(-300));
  }
  return false;
}

async function deliver({ text = '', finish = null, usage = null, model = '', error = null }) {
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  for (let i = 0; i < parts.length; i++) {
    if (!callBot('codejob_part', { job: JOB, i, text: parts[i] })) throw new Error('не удалось передать боту часть ' + (i + 1));
  }
  if (!callBot('codejob_done', { job: JOB, n: parts.length, finish, usage, model, error })) throw new Error('не удалось сообщить боту итог');
}

async function main() {
  const repoName = env('JOB_REPO');
  const branchIn = env('JOB_BRANCH');
  const task = process.env.JOB_TASK ?? '';
  const modelId = env('JOB_MODEL');
  const thinkLevel = ['low', 'medium', 'high'].includes(env('JOB_THINK')) ? env('JOB_THINK') : null;
  if (!JOB || !repoName || !task || !modelId) throw new Error('не хватает входных данных задачи');

  const gh = createGithub({ fetch, token: env('GH_PAT') });
  const llm = createLlm({ fetch, apiKey: env('CLAUDEHUB_API_KEY'), base: API_BASE, sleep, retries: 3 });

  const repo = await gh.getRepo(repoName);
  if (repo.full_name.toLowerCase() === SELF) throw new Error('Репозиторий самого бота трогать нельзя.');
  const branch = branchIn || repo.default_branch;
  console.log('Репозиторий', repo.full_name, 'ветка', branch);

  const models = normalizeModels(await llm.listModels());
  const model = models.find((m) => m.id === modelId) ?? { id: modelId, maxOut: null, thinking: /^claude/i.test(modelId) };
  const think = thinkLevel && model.thinking ? { level: thinkLevel, budget: DEFAULTS.thinkBudgets[thinkLevel] } : null;

  const tree = await gh.getTree(repo.full_name, branch);
  const cands = listCandidates(tree.files);
  console.log('Файлов-кандидатов:', cands.length);

  let readPaths = [];
  if (cands.length) {
    const sel = await llm.chat({
      model: model.id,
      messages: [
        { role: 'system', content: codeSelectSystem() },
        { role: 'user', content: `ЗАДАНИЕ:\n${task}\n\nФАЙЛЫ РЕПОЗИТОРИЯ:\n${cands.map((f) => `${f.path} (${f.size} Б)`).join('\n')}` },
      ],
      maxTokens: 400,
    });
    readPaths = parseSelection(sel.text, cands);
  }
  const contents = [];
  for (const p of readPaths) contents.push({ path: p, text: await gh.getFile(repo.full_name, p, branch) });
  console.log('Прочитано файлов:', contents.length);

  const user =
    `ЗАДАНИЕ:\n${task}\n\n` +
    `ВСЕ ФАЙЛЫ (пути):\n${cands.map((f) => f.path).join('\n') || '(пусто)'}\n\n` +
    contents.map((c) => `=== СОДЕРЖИМОЕ ${c.path} ===\n${c.text}\n=== КОНЕЦ ${c.path} ===`).join('\n\n');

  let n = 0;
  const res = await llm.chat({
    model: model.id,
    messages: [{ role: 'system', content: codeSystem({ repo: repo.full_name, branch, empty: tree.empty }) }, { role: 'user', content: user }],
    maxTokens: model.maxOut || DEFAULTS.maxTokensFallback,
    stream: true,
    think,
    onProgress: () => {
      if (++n % 200 === 0) console.log('…пишу, получено порций:', n);
      return false;
    },
  });
  console.log('Готово. Символов:', res.text.length, 'finish:', res.finish);
  await deliver({ text: res.text, finish: res.finish, usage: res.usage, model: model.id });
}

try {
  await main();
} catch (e) {
  const msg = e?.userMessage || String(e?.message ?? e);
  console.error('Ошибка задачи:', msg);
  try {
    await deliver({ error: msg });
  } catch (e2) {
    console.error('И сообщить боту не удалось:', e2?.message ?? e2);
  }
  process.exit(1);
}
