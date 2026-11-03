import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

const SITE = () => ({ default_branch: 'main', private: true, files: { 'README.md': '# Site' } });

test('/agent не создаёт Issue до явного подтверждения; повторная кнопка не дублирует задание', async () => {
  const w = await createWorld();
  w.gh.repos['me/site'] = SITE();
  await w.say('/repo me/site');
  await w.say('/agent bind coder-bot');
  assert.match(w.last(OWNER).text, /маршрутизац|сохранён/);
  await w.say('/agent Исправь ошибку на странице профиля');
  assert.equal(w.gh.issues.length, 0);
  const buttons = w.last(OWNER).reply_markup.inline_keyboard;
  assert.equal(buttons.length, 2);
  await w.press(buttons[0][0].callback_data);
  assert.equal(w.gh.issues.length, 1);
  assert.equal(w.gh.issues[0].repo, 'me/site');
  assert.match(w.gh.issues[0].body, /^@coder-bot\n/);
  assert.match(w.gh.issues[0].body, /Pull Request/);
  await w.press(buttons[0][0].callback_data);
  assert.equal(w.gh.issues.length, 1, 'повторное нажатие не создаёт вторую Issue');
  await w.say('/agent status');
  assert.match(w.last(OWNER).text, /Issue/);
  assert.match(w.last(OWNER).text, /#1/);
  assert.match(w.last(OWNER).text, /открыта/);
});

test('/agent отмена, истечение срока и чужой Telegram ID не создают Issue', async () => {
  const w = await createWorld();
  w.gh.repos['me/site'] = SITE();
  await w.say('/repo me/site');
  await w.say('/agent bind coder-bot');
  await w.say('/agent Подготовь тесты');
  const buttons = w.last(OWNER).reply_markup.inline_keyboard;
  await w.press(buttons[0][0].callback_data, { from: 2002 });
  assert.equal(w.gh.issues.length, 0);
  await w.press(buttons[1][0].callback_data);
  await w.press(buttons[0][0].callback_data);
  assert.equal(w.gh.issues.length, 0);

  await w.say('/agent Исправь тесты');
  const confirm = w.last(OWNER).reply_markup.inline_keyboard[0][0].callback_data;
  w.advance(901);
  await w.press(confirm);
  assert.equal(w.gh.issues.length, 0);
});

test('/agent требует привязки и GH_PAT Issues; при ошибке не повторяет POST', async () => {
  const w = await createWorld();
  w.gh.repos['me/site'] = { ...SITE(), issuesDenied: true };
  await w.say('/repo me/site');
  await w.say('/agent Сделай модуль');
  assert.match(w.last(OWNER).text, /Сначала укажи/);
  await w.say('/agent bind coder-bot');
  await w.say('/agent Сделай модуль');
  const confirm = w.last(OWNER).reply_markup.inline_keyboard[0][0].callback_data;
  await w.press(confirm);
  assert.equal(w.gh.issues.length, 0);
  await w.press(confirm);
  const writes = w.gh.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues'));
  assert.equal(writes.length, 1);
  assert.equal(w.sent(OWNER).some((m) => /Не могу подтвердить/.test(m.text)), true);
});

test('/agent при отсутствии токена не позволяет отправлять задания', async () => {
  const w = await createWorld({ github: false });
  await w.say('/agent что-то исправь');
  assert.match(w.last(OWNER).text, /GH_PAT/);
});
