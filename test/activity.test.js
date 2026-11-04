import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypingHeartbeat } from '../tgcloud/lib/activity.js';

function fakeTimers() {
  let callback = null;
  let cleared = false;
  return {
    timers: {
      setInterval(fn, interval) {
        assert.equal(interval, 4000);
        callback = fn;
        return 1;
      },
      clearInterval(id) {
        assert.equal(id, 1);
        cleared = true;
      },
    },
    tick() { callback?.(); },
    get cleared() { return cleared; },
  };
}

test('typing begins immediately, repeats, and stops when the handler completes', async () => {
  const fake = fakeTimers();
  let sent = 0;
  const activity = createTypingHeartbeat(async () => { sent++; }, { timers: fake.timers });
  await activity.start();
  assert.equal(sent, 1);
  fake.tick();
  await Promise.resolve();
  assert.equal(sent, 2);
  activity.stop();
  assert.equal(fake.cleared, true);
  fake.tick();
  await Promise.resolve();
  assert.equal(sent, 2);
});

test('typing works in Telegram Serverless without timer globals', async () => {
  let sent = 0;
  const activity = createTypingHeartbeat(async () => { sent++; }, { timers: {} });
  await activity.start();
  assert.equal(sent, 1);
  activity.stop();
});

test('typing errors are nonfatal and do not create an unhandled rejection', async () => {
  const fake = fakeTimers();
  let sent = 0;
  const activity = createTypingHeartbeat(async () => {
    sent++;
    throw new Error('Telegram API unavailable');
  }, { timers: fake.timers });
  await activity.start();
  fake.tick();
  await Promise.resolve();
  activity.stop();
  assert.equal(sent, 2);
});

test('heartbeat never overlaps a slow Telegram API call', async () => {
  const fake = fakeTimers();
  let sent = 0;
  let unblock;
  const slow = new Promise(resolve => { unblock = resolve; });
  const activity = createTypingHeartbeat(async () => {
    sent++;
    if (sent === 2) await slow;
  }, { timers: fake.timers });
  await activity.start();
  fake.tick();
  fake.tick();
  assert.equal(sent, 2);
  unblock();
  await Promise.resolve();
  activity.stop();
  fake.tick();
  assert.equal(sent, 2);
});
