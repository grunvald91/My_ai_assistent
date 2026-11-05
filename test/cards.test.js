import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

test('/panel uses current server data and does not invoke an LLM', async () => {
  const w = await createWorld();
  await w.say('/panel');
  const msg = w.last(OWNER);
  assert.match(msg.text, /Моя панель/);
  assert.match(msg.text, /Задачи: 0\/0/);
  assert.ok(msg.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'ui:tasks:0'));
  assert.equal(w.llmCalls.length, 0);
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, 1);
});

test('tasks survive opening a new card; toggles are persisted and stale taps do not revert them', async () => {
  const w = await createWorld();
  await w.say('/task add Проверить деплой');
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, 2);
  await w.say('/tasks');
  const button = w.last(OWNER).reply_markup.inline_keyboard[0][0];
  assert.match(button.text, /Проверить деплой/);
  assert.match(button.callback_data, /^ui:toggle:2:0:0$/);
  await w.press(button.callback_data);
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, 3);
  assert.match(w.calls('editMessageText').at(-1).reply_markup.inline_keyboard[0][0].text, /✅/);

  await w.press(button.callback_data); // old message must not toggle the newer version
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, 3);
  await w.say('/panel');
  assert.match(w.last(OWNER).text, /1\/1 выполнено/);
  assert.equal(w.llmCalls.length, 0);
});

test('adding from a button stores text, escapes HTML and keeps tasks in owner-only chat', async () => {
  const w = await createWorld();
  await w.say('/tasks');
  await w.press('ui:add');
  await w.say('Уточнить <условия> & цену');
  const board = await w.store.getUiCard('tasks_' + OWNER);
  assert.equal(JSON.parse(board.data).items[0].text, 'Уточнить <условия> & цену');
  const b = w.last(OWNER);
  assert.ok(b.reply_markup.inline_keyboard.flat().some((x) => x.callback_data.startsWith('ui:toggle:')));
  assert.doesNotMatch(b.text, /<условия>/);
  await w.press('ui:tasks:0', { chat: -999, from: OWNER });
  assert.equal(w.calls('editMessageText').length, 0, 'group click never edits a private board');
  await w.say('/tasks', { from: 5555 });
  assert.match(w.last(5555).text, /личный бот/);
});

test('card system has honest unavailable states and memory reads real stored facts', async () => {
  const w = await createWorld();
  await w.say('/remember Реальный факт');
  await w.say('/panel');
  assert.match(w.last(OWNER).text, /Факты в памяти: 1/);
  await w.press('ui:memory');
  assert.match(w.calls('editMessageText').at(-1).text, /Реальный факт/);
  await w.press('ui:calendar');
  assert.match(w.calls('editMessageText').at(-1).text, /пока не реализовано/);
  await w.press('ui:routes');
  assert.match(w.calls('editMessageText').at(-1).text, /пока не подключено/);
});
