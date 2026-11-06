import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { AGENT_REPO, isNaturalCodeTask, agentTaskType, agentFollowup } from '../tgcloud/lib/superagent.js';

function prepare(w) {
  w.gh.repos[AGENT_REPO] = {
    default_branch: 'main', files: { 'README.md': '# Growth' },
    statuses: [{
      context: 'superagent/multirepo-ready', description: 'superagent-multirepo-v2',
      state: 'success', creator: { login: 'Grunvald1991' },
      created_at: new Date(w.now * 1000).toISOString(),
    }],
  };
  w.gh.repos['grunvald91/Mnebyvpn'] = { default_branch: 'main', files: { 'README.md': '# VPN' }, agentPermission: 'write' };
  w.gh.repos['grunvald91/Sushef'] = { default_branch: 'main', files: { 'README.md': '# Chef' }, agentPermission: 'write' };
}

const terminal = (number, body) => ({
  issue: number, id: number + 400, user: { login: 'Grunvald1991' },
  body: body + '\n<!-- superagent-relay:v1 report=0123456789abcdef0123 -->\n<!-- superagent-result:v1 issue=' + number + ' state=ready -->',
});

test('review is read-only and natural developer requests do not invoke local code model', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/repo grunvald91/Mnebyvpn');
  await w.say('Сделай полное ревью кода');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.gh.issues[0].body, /repo=grunvald91\/Mnebyvpn mode=read/);
  assert.match(w.gh.issues[0].body, /Только чтение/);
  assert.equal(w.llmCalls.length, 0);
  assert.equal(w.gh.commits.length, 0);
  assert.equal(await w.store.getSetting('agent:repo:' + OWNER), 'grunvald91/Mnebyvpn');
});

test('/code delegates to server agent, never to local file rewrite workflow', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/repo grunvald91/Mnebyvpn');
  await w.say('/code Исправь стили мобильной страницы');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.gh.issues[0].body, /mode=write/);
  assert.equal(w.llmCalls.length, 0);
  assert.equal(w.gh.prs.length, 0);
  assert.equal(w.gh.commits.length, 0);
});

test('selected /gh button also selects superagent repository, including same-message /agent repo task', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/gh');
  const buttons = w.last(OWNER).reply_markup.inline_keyboard.flat();
  const vpn = buttons.find(b => b.text === 'Mnebyvpn');
  assert.ok(vpn);
  await w.press(vpn.callback_data);
  assert.equal(await w.store.getSetting('gh_repo'), 'grunvald91/Mnebyvpn');
  assert.equal(await w.store.getSetting('agent:repo:' + OWNER), 'grunvald91/Mnebyvpn');
  await w.say('/agent repo grunvald91/Sushef сделай ревью');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.gh.issues[0].body, /repo=grunvald91\/Sushef mode=read/);
  assert.equal(await w.store.getSetting('gh_repo'), 'grunvald91/Sushef');
});

test('short followup uses latest verified report in the same project', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/repo grunvald91/Mnebyvpn');
  await w.say('Сделай ревью');
  w.gh.comments.push(terminal(300, 'Найдено: ошибка в login.js, требуется исправление.'));
  await w.say('Исправляй');
  assert.equal(w.gh.issues.length, 2);
  assert.match(w.gh.issues[1].body, /Результат задачи #300/);
  assert.match(w.gh.issues[1].body, /ошибка в login.js/);
  assert.match(w.gh.issues[1].body, /mode=write/);
  assert.equal(w.llmCalls.length, 0);
});

test('followups do not invent missing reports or use another project history', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/repo grunvald91/Mnebyvpn');
  await w.say('Сделай ревью');
  await w.say('Исправляй');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.last(OWNER).text, /ещё не имеет подтверждённого итогового отчёта/);
  await w.say('/repo grunvald91/Sushef');
  await w.say('Исправляй');
  assert.equal(w.gh.issues.length, 1);
  assert.match(w.last(OWNER).text, /нет предыдущего поручения/);
});

test('panel shows actual project, task and actions in bubble state and fallback card', async () => {
  const w = await createWorld();
  prepare(w);
  await w.say('/repo grunvald91/Mnebyvpn');
  await w.say('Сделай ревью');
  const data = JSON.parse(await w.app.D.cards.widgetState(OWNER, 'agent'));
  assert.equal(data.agent.repo, 'Mnebyvpn');
  assert.equal(data.agent.issue, 300);
  await w.say('/panel_text');
  await w.press('ui:agent');
  const card = w.last(OWNER);
  assert.match(card.text, /Mnebyvpn/);
  assert.match(card.text, /#300/);
  assert.ok(card.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'ui:agent_action:review'));
});

test('code intent does not hijack ordinary chat', async () => {
  const w = await createWorld();
  prepare(w);
  assert.equal(isNaturalCodeTask('Расскажи, что такое GitHub'), false);
  assert.equal(isNaturalCodeTask('Создай ветку feature/new в проекте'), true);
  assert.equal(isNaturalCodeTask('Сделай ревью Mnebyvpn'), true);
  assert.equal(agentTaskType('Сделай ревью Mnebyvpn'), 'report-only');
  assert.equal(agentFollowup('Исправляй'), 'fix');
  await w.say('Расскажи, что такое GitHub');
  assert.equal(w.gh.issues.length, 0);
  assert.ok(w.llmCalls.length > 0);
});
