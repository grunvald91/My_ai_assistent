import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { ASSISTANT_WIDGET_HTML } from '../tgcloud/lib/widget-html.js';

const q = (id, data, who = OWNER, chat = OWNER, messageId = 42) =>
  ({ id, data, from: { id: who, first_name: 'Tester' }, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, message_id: messageId });

test('Bot API 10.4: HTMLBubble is self contained, compressed below 4 KB', () => {
  assert.match(ASSISTANT_WIDGET_HTML, /TelegramWidget\.request|tw\.request/);
  assert.match(ASSISTANT_WIDGET_HTML, /chatDataChanged/);
  assert.ok(Buffer.byteLength(ASSISTANT_WIDGET_HTML) <= 32768);
  assert.ok(deflateSync(Buffer.from(ASSISTANT_WIDGET_HTML), { level: 9 }).byteLength <= 4096);
  assert.doesNotMatch(ASSISTANT_WIDGET_HTML, /https?:\/\/|fetch\(|<img/i, 'no external resources or browser HTTP calls');
});

test('sendWidget produces real HTMLBubble with per-message private data', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/task add Отправить документы');
  const p = w.calls('sendWidget').at(-1);
  assert.equal(p.chat_id, OWNER);
  assert.equal(p.allow_queries, true);
  assert.equal(p.is_shared, undefined, 'must not be a shareable widget');
  assert.equal(p.public_data, undefined, 'do not leak owner data to forwarded copies');
  assert.equal(p.html, ASSISTANT_WIDGET_HTML);
  assert.ok(Buffer.byteLength(p.chat_data) <= 1024);
  const data = JSON.parse(p.chat_data);
  assert.equal(data.k, 'tasks');
  assert.equal(data.items[0].t, 'Отправить документы');
  assert.equal(w.sent(OWNER).length, 0, 'no fallback text when widget is accepted');
  await w.say('/panel');
  assert.equal(JSON.parse(w.calls('sendWidget').at(-1).chat_data).k, 'home');
});

test('widget requests toggle server-backed tasks, edit message data and answer immediately', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/task add Проверить PR');
  const before = await w.store.getUiCard('tasks_' + OWNER);
  assert.equal(before.version, 2);
  await w.dispatchRaw('widget_query', q('qw1', 'w:toggle:2:0:0'));
  const after = await w.store.getUiCard('tasks_' + OWNER);
  assert.equal(after.version, 3);
  assert.equal(JSON.parse(after.data).items[0].done, true);
  assert.equal(w.calls('editMessageWidgetData').at(-1).message_id, 42);
  const ack = w.calls('answerWidgetQuery').at(-1);
  assert.equal(ack.widget_query_id, 'qw1');
  assert.equal(JSON.parse(ack.data).items[0].d, 1);
  assert.ok(Buffer.byteLength(ack.data) <= 1024);
  await w.dispatchRaw('widget_query', q('qw2', 'w:toggle:2:0:0'));
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, 3, 'stale tap must not undo completion');
  assert.match(w.calls('answerWidgetQuery').at(-1).data, /Карточка обновилась/);
});

test('widget navigation and long Cyrillic task names fit 1024-byte state limit', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  for (let i = 0; i < 8; i++) {
    await w.say('/task add ' + ('Юникод🎯'.repeat(17)) + i);
  }
  const state = await w.app.D.cards.widgetState(OWNER, 'tasks', 0);
  assert.ok(Buffer.byteLength(state) <= 1024);
  assert.equal(JSON.parse(state).items.length, 6);
  await w.dispatchRaw('widget_query', q('qnav', 'w:tasks:1'));
  assert.equal(JSON.parse(w.calls('answerWidgetQuery').at(-1).data).page, 1);
  await w.dispatchRaw('widget_query', q('qmem', 'w:memory'));
  assert.equal(JSON.parse(w.calls('answerWidgetQuery').at(-1).data).k, 'memory');
});

test('add from widget sets owner state; next message creates a new persistent task', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/panel');
  await w.dispatchRaw('widget_query', q('qadd', 'w:add'));
  assert.equal((await w.store.getChat(OWNER)).state, 'ui_add_task');
  assert.match(w.last(OWNER).text, /Напиши название задачи/);
  await w.say('Позвонить заказчику');
  assert.equal(JSON.parse((await w.store.getUiCard('tasks_' + OWNER)).data).items[0].text, 'Позвонить заказчику');
  assert.equal((await w.store.getChat(OWNER)).state, null);
});

test('private widget rejects foreign and group requests without leaking state', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/task add Секретная задача');
  const version = (await w.store.getUiCard('tasks_' + OWNER)).version;
  await w.dispatchRaw('widget_query', q('foreign', 'w:toggle:2:0:0', 1234));
  await w.dispatchRaw('widget_query', q('group', 'w:toggle:2:0:0', OWNER, -999));
  await w.dispatchRaw('shared_widget_query', { id: 'forward', from: { id: OWNER }, widget_id: 700, data: 'w:toggle:2:0:0' });
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, version);
  assert.deepEqual(w.calls('answerWidgetQuery').slice(-3).map((x) => Object.keys(x)), [
    ['widget_query_id'], ['widget_query_id'], ['widget_query_id'],
  ]);
});

test('widget rejected -> original Telegram buttons still work; explicit /panel_text bypasses widget', async () => {
  const w = await createWorld();
  w.fail('sendWidget', 404, 'Not Found: method not found');
  await w.say('/panel');
  assert.match(w.last(OWNER).text, /Моя панель/);
  assert.ok(w.last(OWNER).reply_markup.inline_keyboard.length);
  w.clear();
  w.widgetApiSupported = true;
  await w.say('/panel_text');
  assert.equal(w.calls('sendWidget').length, 0);
  assert.match(w.last(OWNER).text, /Моя панель/);
});

test('widget edit failure is logged but request is answered with authoritative state', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/task add Обновить данные');
  w.fail('editMessageWidgetData', 400, 'Bad Request: message is not modified');
  await w.dispatchRaw('widget_query', q('editfail', 'w:toggle:2:0:0'));
  assert.equal(JSON.parse(w.calls('answerWidgetQuery').at(-1).data).d, 1);
});
