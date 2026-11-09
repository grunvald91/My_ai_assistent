import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { WIDGET_WEBHOOK_VERIFIED } from '../tgcloud/lib/widget-readiness.js';

test('committed widget flag defaults to false until real webhook deploy attests it', () => {
  assert.equal(WIDGET_WEBHOOK_VERIFIED, false);
  const deploy = readFileSync(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /verifyWidgetWebhookReport/);
  assert.match(deploy, /widget-readiness\.js/);
  assert.match(deploy, /push.*tgcloud\/lib\/widget-readiness\.js/);
});

test('after cloud attestation, forbidden getWebhookInfo does not block sendWidget', async () => {
  const w = await createWorld({ widgetWebhookVerified: true });
  w.widgetApiSupported = true;
  w.fail('getWebhookInfo', 403, 'This method is managed by Telegram Serverless');
  await w.say('/panel');
  const sends = w.calls('sendWidget');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].allow_queries, true);
  assert.equal(sends[0].height, undefined, 'no invalid zero-height in production 10.4');
  assert.equal(w.sent(OWNER).length, 0);
});

test('explicit webhook negative overrides deploy attestation', async () => {
  const w = await createWorld({ widgetWebhookVerified: true });
  w.widgetApiSupported = true;
  w.widgetWebhookUpdates = ['message', 'callback_query'];
  await w.say('/panel');
  assert.equal(w.calls('sendWidget').length, 0);
  assert.match(w.last(OWNER).text, /Моя панель/);
});

test('non-data 10.4 wallet query cannot toggle a task', async () => {
  const w = await createWorld({ widgetWebhookVerified: true });
  w.widgetApiSupported = true;
  await w.say('/task add Важная задача');
  const before = await w.store.getUiCard('tasks_' + OWNER);
  await w.dispatchRaw('widget_query', {
    id: 'qw-wallet', from: { id: OWNER },
    chat: { id: OWNER, type: 'private' }, message_id: 42,
    data: 'w:toggle:' + before.version + ':0:0',
    type: { type: 'sign_data' },
  });
  assert.equal((await w.store.getUiCard('tasks_' + OWNER)).version, before.version);
  assert.deepEqual(w.calls('answerWidgetQuery').at(-1), { widget_query_id: 'qw-wallet' });
});
