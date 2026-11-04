import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(name) {
  return readFileSync(new URL('../' + name, import.meta.url), 'utf8');
}

test('YANDEX_API включается автоматически, без скрытого флага YANDEX_RASP_ALLOWED', () => {
  const secrets = source('scripts/write-secrets.mjs');
  const deps = source('tgcloud/lib/deps.js');
  const bg = source('scripts/bgjob.mjs');
  const deploy = source('.github/workflows/deploy.yml');
  const workflow = source('.github/workflows/bgjob.yml');
  for (const content of [secrets, deps, bg, deploy, workflow]) {
    assert.doesNotMatch(content, /YANDEX_RASP_ALLOWED/, 'настройка Яндекса не должна зависеть от дополнительного переключателя');
  }
  assert.match(secrets, /process\.env\.YANDEX_API/);
  assert.match(deps, /yandexRaspKey:\s*YANDEX_RASP_API_KEY/);
  assert.match(bg, /env\('YANDEX_API'\)\s*\|\|\s*env\('YANDEX_RASP_API_KEY'\)/);
  assert.match(deploy, /YANDEX_API:\s*\$\{\{ secrets\.YANDEX_API \}\}/);
  assert.match(workflow, /YANDEX_API:\s*\$\{\{ secrets\.YANDEX_API \}\}/);
});
