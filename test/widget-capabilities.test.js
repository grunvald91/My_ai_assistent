import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsWidgetUpdates } from '../scripts/check-widget-capabilities.mjs';

test('probe detects Telegram Serverless 10.4 handler support from real descriptor shape', () => {
  const descriptor = {
    ok: true, result: { project_schema_version: 1, directories: [
      { name: 'lib', nested: true },
      { name: 'handlers', nested: false, allowed_names: ['message', 'callback_query', 'widget_query', 'shared_widget_query'] },
    ] },
  };
  assert.equal(supportsWidgetUpdates(descriptor), true);
  assert.equal(supportsWidgetUpdates(descriptor.result), true);
  assert.equal(supportsWidgetUpdates({ ...descriptor, result: {
    ...descriptor.result, directories: [{ name: 'handlers', allowed_names: ['message', 'widget_query'] }],
  } }), false);
});

test('probe fails closed for malformed, missing or outdated cloud capabilities', () => {
  for (const data of [null, undefined, {}, { ok: false }, { result: {} }, { result: { directories: [] } },
    { result: { directories: [{ name: 'handlers', allowed_names: ['message'] }] } }]) {
    assert.equal(supportsWidgetUpdates(data), false);
  }
});
