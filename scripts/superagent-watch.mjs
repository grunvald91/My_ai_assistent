// scripts/superagent-watch.mjs — фоновая доставка результата агента в Telegram.
// Этот workflow запускает сам бот при создании Issue, никаких ручных Actions.
import { execFileSync } from 'node:child_process';

const REPO = 'grunvald91/Ai_growth_os';
const issue = Number(process.env.AGENT_ISSUE);
const owner = Number(process.env.AGENT_CHAT_ID);
const approvedOwners = String(process.env.OWNER_IDS ?? '').split(/[,;\s]+/).map(Number).filter(Number.isSafeInteger);
const token = String(process.env.GH_PAT ?? '');
const tgToken = String(process.env.TGCLOUD_TOKEN ?? '');
if (!Number.isSafeInteger(issue) || issue < 1 || !approvedOwners.includes(owner) || !token || !tgToken) {
  throw new Error('Invalid task, owner, GitHub token or tgcloud CLI token');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const API = 'https://api.github.com/repos/' + REPO + '/issues/' + issue + '/comments?per_page=100';
const FINISH_TIMEOUT_MS = 25 * 60 * 1000;
const startedAt = Date.now();

async function agentReply() {
  const res = await fetch(API, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'superagent-telegram-watch',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('GitHub comment API status ' + res.status);
  const comments = await res.json();
  return comments.find((c) =>
    String(c?.user?.login ?? '').toLowerCase() === 'grunvald1991' &&
    !!String(c?.body ?? '').trim() &&
    !/<!--\s*dsh-superagent:[\da-f]+\s*-->/i.test(String(c.body))
  ) ?? null;
}

function notify(body) {
  const args = ['tgcloud', 'run', 'endpoints/superagent_result', JSON.stringify(body),
    '--ctx', JSON.stringify({ initData: { user: { id: owner } } })];
  execFileSync('npx', args, { stdio: 'pipe', timeout: 120000, maxBuffer: 1024 * 1024 });
}

let lastFailure = '';
while (Date.now() - startedAt < FINISH_TIMEOUT_MS) {
  try {
    const reply = await agentReply();
    if (reply) {
      notify({ issue, comment_id: reply.id });
      console.log('SUPERAGENT_TELEGRAM_RESULT_DELIVERED issue=' + issue);
      process.exit(0);
    }
    lastFailure = '';
  } catch (err) {
    lastFailure = String(err?.message ?? err).slice(0, 130);
    console.warn('Superagent notification check failed:', lastFailure);
  }
  await sleep(30000);
}
if (lastFailure) console.warn('Last transient issue check error:', lastFailure);
notify({ issue, timeout: true });
console.log('SUPERAGENT_TELEGRAM_TIMEOUT_NOTICE_DELIVERED issue=' + issue);
