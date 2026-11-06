import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { ASSISTANT_WIDGET_HTML } from '../tgcloud/lib/widget-html.js';
import { verifyWidgetWebhookReport, verifyBasicWebhookReport } from '../scripts/verify-widget-webhook.mjs';

const query = (id, data) => ({ id, data, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, message_id: 44 });

test('fail closed: sendWidget is never called when webhook has no widget_query', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  w.widgetWebhookUpdates = ['message', 'callback_query'];
  await w.say('/panel');
  assert.equal(w.calls('sendWidget').length, 0);
  assert.match(w.last(OWNER).text, /Моя панель/);
  assert.equal(w.calls('getWebhookInfo').length, 1);
});

test('fail closed: both widget query types are required', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  w.widgetWebhookUpdates = ['message', 'widget_query'];
  await w.say('/tasks');
  assert.equal(w.calls('sendWidget').length, 0);
  assert.match(w.last(OWNER).text, /Задачи/);
});

test('webhook readiness rechecked after TTL; once subscription exists widgets resume', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  w.widgetWebhookUpdates = ['message', 'callback_query'];
  await w.say('/panel');
  assert.equal(w.calls('sendWidget').length, 0);
  w.widgetWebhookUpdates = ['message', 'widget_query', 'shared_widget_query'];
  w.advance(61);
  await w.say('/panel');
  assert.equal(w.calls('sendWidget').length, 1);
});

test('getWebhookInfo errors fail closed and keep text commands working', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  w.fail('getWebhookInfo', 502, 'webhook temporarily unavailable');
  await w.say('/panel');
  assert.equal(w.calls('sendWidget').length, 0);
  assert.match(w.last(OWNER).text, /Моя панель/);
});

test('ack is attempted before editing widget state; edit failure cannot mask saved result', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/task add Проверить бота');
  w.clear();
  w.fail('editMessageWidgetData', 500, 'temporary edit failure');
  await w.dispatchRaw('widget_query', query('qa1', 'w:toggle:2:0:0'));
  const methods = w.tg.map((v) => v.method);
  assert.ok(methods.indexOf('answerWidgetQuery') < methods.indexOf('editMessageWidgetData'));
  assert.equal(methods.filter((m) => m === 'answerWidgetQuery').length, 1);
  const reply = w.calls('answerWidgetQuery')[0];
  assert.equal(JSON.parse(reply.data).d, 1);
  assert.equal(JSON.parse((await w.store.getUiCard('tasks_' + OWNER)).data).items[0].done, true);
  await w.dispatchRaw('widget_query', query('qa2', 'w:sync:tasks:0'));
  assert.equal(JSON.parse(w.calls('answerWidgetQuery').at(-1).data).items[0].d, 1);
});

test('synchronization refreshes another older widget with the actual SQLite version', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/panel');
  const original = JSON.parse(w.calls('sendWidget')[0].chat_data);
  assert.equal(original.v, 1);
  await w.say('/task add Оплатить счёт');
  await w.dispatchRaw('widget_query', query('qa3', 'w:sync:home:0'));
  const updated = JSON.parse(w.calls('answerWidgetQuery').at(-1).data);
  assert.equal(updated.k, 'home');
  assert.equal(updated.v, 2);
  assert.equal(updated.n, 1);
});

test('add-task action is acknowledged before any auxiliary chat message', async () => {
  const w = await createWorld();
  w.widgetApiSupported = true;
  await w.say('/panel');
  w.clear();
  await w.dispatchRaw('widget_query', query('qa4', 'w:add'));
  const methods = w.tg.map((v) => v.method);
  assert.ok(methods.indexOf('answerWidgetQuery') < methods.indexOf('sendMessage'));
  assert.equal(w.calls('answerWidgetQuery').length, 1);
  assert.equal((await w.store.getChat(OWNER)).state, 'ui_add_task');
});

test('webhook output parser rejects missing update types, failures and unknown output', () => {
  assert.equal(verifyWidgetWebhookReport(
    'URL: https://example.invalid\nAllowed updates: message, callback_query, widget_query, shared_widget_query\nIn sync: yes\n'
  ).ok, true);
  assert.equal(verifyWidgetWebhookReport(
    'Allowed updates:\n  - message\n  - widget_query\n  - shared_widget_query\n✓ In sync with deployed handlers'
  ).ok, true);
  for (const output of [
    'Allowed updates: message, widget_query\nIn sync: yes',
    'Allowed updates: widget_query, shared_widget_query\nOut of sync',
    'allowed_updates: widget_query, shared_widget_query\nIn sync: no',
    'all handlers deployed, no webhook report',
  ]) assert.equal(verifyWidgetWebhookReport(output).ok, false, output);
});

test('HTML UI refreshes stale state on activation and ignores older state events', async () => {
  const script = ASSISTANT_WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.style = {}; this.className = ''; this.textContent = ''; }
    appendChild(e) { this.children.push(e); return e; }
    addEventListener(type, cb) { this.handlers[type] = cb; }
    set innerHTML(_) { this.children = []; }
  }
  const root = new Element();
  const handlers = {};
  const requests = [];
  const tw = {
    chatData: JSON.stringify({ k: 'home', v: 1, n: 0, d: 0, m: 0 }),
    chatType: 'private', isActive: true, isForward: false,
    onEvent: (name, fn) => { handlers[name] = fn; },
    ready: () => {},
    request: (data) => {
      requests.push(data);
      return Promise.resolve({ result: JSON.stringify({ k: 'home', v: 3, n: 2, d: 1, m: 0 }) });
    },
  };
  runInNewContext(script, { window: { TelegramWidget: tw }, document: {
    getElementById: () => root, createElement: () => new Element(),
  }, Date, JSON, Math });
  await new Promise((r) => setImmediate(r));
  assert.equal(requests[0], 'w:sync:home:0');
  const flatten = (e) => [e.textContent, ...e.children.flatMap(flatten)].join(' ');
  assert.match(flatten(root), /Задачи: 1\/2/);
  tw.chatData = JSON.stringify({ k: 'home', v: 1, n: 0, d: 0, m: 0 });
  handlers.chatDataChanged();
  assert.match(flatten(root), /Задачи: 1\/2/);
});

test('CLI fallback accepts only a synchronized standard webhook, never false HTMLBubble support', () => {
  assert.equal(verifyBasicWebhookReport('Allowed updates: message, callback_query\nIn sync: yes').ok, true);
  assert.equal(verifyBasicWebhookReport('Allowed updates: callback_query\nIn sync: yes').ok, false);
  assert.equal(verifyBasicWebhookReport('Allowed updates: message\nIn sync: no').ok, false);
  assert.equal(verifyBasicWebhookReport('No webhook info').ok, false);
  assert.equal(verifyWidgetWebhookReport('Allowed updates: message, callback_query\nIn sync: yes').ok, false);
});
