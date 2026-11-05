import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { parseAgentRequest, agentTaskType, AGENT_REPO, requestedAgentRepository } from '../tgcloud/lib/superagent.js';

function setup(w) {
  w.gh.repos['grunvald91/Ai_growth_os'] = { default_branch: 'main', files: { 'README.md': 'hello' } };
  w.gh.repos['grunvald91/booking_bot'] = { default_branch: 'main', files: { 'README.md': 'hello' } };
  w.gh.repos['grunvald91/SMENA'] = { default_branch: 'main', files: {} };
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: {} };
}

test('plain Telegram instruction sends Issue directly to the agent and dispatches internal watcher', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('Поручи агенту проверить код Growth и написать короткий отчёт');
  assert.equal(w.gh.issues.length, 1);
  assert.equal(w.gh.issues[0].repo.toLowerCase(), AGENT_REPO.toLowerCase());
  assert.match(w.gh.issues[0].body, /@Grunvald1991/);
  assert.match(w.gh.issues[0].body, /Только чтение/);
  assert.equal(w.gh.dispatches.length, 1);
  assert.equal(w.gh.dispatches[0].workflow, 'superagent-watch.yml');
  assert.equal(w.gh.dispatches[0].inputs.issue, '300');
  assert.equal(w.gh.dispatches[0].inputs.chat_id, String(OWNER));
  assert.match(w.last(OWNER).text, /Передал задачу агенту/);
  assert.equal(w.llmCalls.length, 0);
});

test('code-changing Telegram task opens an Issue with PR-only permission and rejects production deploy', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent Исправь CSS в ServGo Studio, сделай PR');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.gh.issues[0].body, /Pull Request/);
  assert.match(w.gh.issues[0].body, /Не сливать PR в main/);
  assert.match(w.last(OWNER).text, /изменения через PR/);
});

test('/agent with no text accepts the next message without manual workflow setup', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent');
  assert.match(w.last(OWNER).text, /Что поручить агенту/);
  await w.say('Проверь API и дай отчёт');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.last(OWNER).text, /Передал задачу агенту/);
});

test('no automatic dispatch for ordinary conversation and unrelated explanations', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('Привет, расскажи мне про GitHub');
  assert.equal(w.gh.issues.length, 0);
  assert.ok(w.llmCalls.length > 0);
});

test('callback delivers only final comment by the exact agent and does not duplicate', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent Проверь README и опиши структуру');
  w.clear();
  w.gh.comments.push(
    { issue: 300, id: 500, user: { login: 'Grunvald1991' }, body: 'Начинаю работу\n<!-- dsh-superagent:abcdef1234 -->' },
    { issue: 300, id: 501, user: { login: 'someoneElse' }, body: 'This is by an automated agent, not a human.\nПодмена' },
    { issue: 300, id: 502, user: { login: 'Grunvald1991' }, body: 'This is by an automated agent, not a human.\nГотовый отчёт, найдено три каталога.' },
  );
  assert.equal(await w.app.superagent.deliver({ issue: 300, commentId: 502 }), true);
  assert.match(w.last(OWNER).text, /Готовый отчёт/);
  const count = w.sent(OWNER).length;
  assert.equal(await w.app.superagent.deliver({ issue: 300, commentId: 502 }), true);
  assert.equal(w.sent(OWNER).length, count);
  await w.say('/agent статус');
  assert.match(w.last(OWNER).text, /уже выполнена/);
});

test('non-default repository stays blocked until the server prepare hook is enabled', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent Проверь github.com/grunvald91/booking_bot');
  assert.equal(w.gh.issues.length, 0);
  assert.match(w.last(OWNER).text, /ещё не активирована/);
  await w.say('/agent multirepo status');
  assert.match(w.last(OWNER).text, /выключена/);
});

test('explicit BookingBot task is queued centrally but targets booking_bot for agent checkout and PR', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent multirepo on');
  await w.say('/agent Проверь и исправь в github.com/grunvald91/booking_bot форму записи');
  assert.equal(w.gh.issues.length, 1);
  assert.equal(w.gh.issues[0].repo, AGENT_REPO);
  assert.match(w.gh.issues[0].body.split('\n')[0], /^<!-- superagent-route:v1 repo=grunvald91\/booking_bot -->$/);
  assert.match(w.gh.issues[0].body, /Pull Request именно в него/);
  assert.match(w.last(OWNER).text, /grunvald91\/booking_bot/);
  assert.equal(w.gh.dispatches.length, 1);
});

test('repo selection persists and explicit target overrides it for one task', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent multirepo on');
  await w.say('/agent repo grunvald91/booking_bot');
  assert.match(w.last(OWNER).text, /будет работать/);
  await w.say('/agent Проверь код');
  assert.match(w.gh.issues[0].body, /superagent-route:v1 repo=grunvald91\/booking_bot/);
  await w.say('/agent Проверь github.com/grunvald91/Ai_growth_os');
  assert.match(w.gh.issues[1].body, /superagent-route:v1 repo=grunvald91\/Ai_growth_os/);
  await w.say('/agent Проверь код ещё раз');
  assert.match(w.gh.issues[2].body, /superagent-route:v1 repo=grunvald91\/booking_bot/);
  await w.say('/agent repo default');
  await w.say('/agent Проверь README');
  assert.match(w.gh.issues[3].body, /superagent-route:v1 repo=grunvald91\/Ai_growth_os/);
});

test('multi-target and unauthorized repositories fail closed without creating Issues', async () => {
  const w = await createWorld();
  setup(w);
  await w.say('/agent Проверь github.com/grunvald91/booking_bot и github.com/grunvald91/SMENA');
  assert.equal(w.gh.issues.length, 0);
  assert.match(w.last(OWNER).text, /несколько репозиториев/);
  await w.say('/agent Проверь github.com/grunvald91/no_such_repo');
  assert.equal(w.gh.issues.length, 0);
  assert.match(w.last(OWNER).text, /Не могу подтвердить доступ/);
  await w.say('/agent Проверь github.com/grunvald91/My_ai_assistent');
  assert.equal(w.gh.issues.length, 0);
  assert.match(w.last(OWNER).text, /Репозиторий недопустим/);
  await w.say('/agent Используй токен ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR');
  assert.equal(w.gh.issues.length, 0);
  assert.match(w.last(OWNER).text, /ключ или токен/);
});


test('if watcher dispatch fails, issue still exists and Telegram gives status fallback', async () => {
  const w = await createWorld();
  setup(w);
  w.gh.repos['grunvald91/my_ai_assistent'].dispatchFails = 'not permitted';
  await w.say('Агент: проверь README.md');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.last(OWNER).text, /Автоуведомление не запустилось/);
  await w.say('/agent статус');
  assert.match(w.last(OWNER).text, /в работе/);
});

test('agent intent classifier accepts explicit requests, but not unrelated text', () => {
  assert.equal(parseAgentRequest('Поручи агенту исправить ошибки'), 'исправить ошибки');
  assert.equal(parseAgentRequest('Суперагент: проверь Issue'), 'проверь Issue');
  assert.equal(parseAgentRequest('Просто поговорим об агенте'), null);
  assert.equal(agentTaskType('Проверь стили'), 'report-only');
  assert.equal(agentTaskType('Проверь и исправь стили'), 'code-change');
});

test('repository parser supports explicit URL and avoids guessing an unspecified project', () => {
  assert.deepEqual(requestedAgentRepository('Посмотри GitHub https://github.com/grunvald91/booking_bot/issues/3'), {
    repo: 'grunvald91/booking_bot', ambiguous: false,
  });
  assert.deepEqual(requestedAgentRepository('В репозитории booking_bot исправь'), {
    repo: 'grunvald91/booking_bot', ambiguous: false,
  });
  assert.deepEqual(requestedAgentRepository('Проверь проект'), { repo: null, ambiguous: false });
});
