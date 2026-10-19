// Деплой для CI: ключи → secrets.js, push, безопасная миграция БД, синхронизация webhook.
//
// Почему не просто «tgcloud push && tgcloud migrate»: в @tgcloud/cli 0.2.0 есть баг — после УСПЕШНОЙ
// загрузки кода CLI падает при записи локального снимка (сервер вернул у одного из модулей не строку).
// Код на сервере уже обновлён, но `&&` обрывал цепочку, и миграция не выполнялась. Здесь именно этот сбой
// терпим (и печатаем, какой модуль его вызвал), любые другие ошибки push по-прежнему валят деплой.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CLI = ['npx', '--no-install', 'tgcloud'];

function run(args, { capture = false } = {}) {
  const r = spawnSync(CLI[0], [...CLI.slice(1), ...args], { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: process.env });
  if (capture) {
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
  }
  return r;
}

const w = spawnSync('node', ['scripts/write-secrets.mjs'], { stdio: 'inherit' });
if (w.status !== 0) process.exit(w.status ?? 1);

// 1. push --force: в CI нет локального снимка (свежий checkout), репозиторий — источник истины
const push = run(['push', '--force'], { capture: true });
if (push.status !== 0) {
  const out = (push.stdout ?? '') + (push.stderr ?? '');
  const uploaded = /Deploying \d+ changes/.test(out) && /✓ tgcloud\//.test(out);
  const snapshotBug = out.includes('core/snapshot.js') && out.includes('ERR_INVALID_ARG_TYPE');
  if (!(uploaded && snapshotBug)) {
    console.error('\n❌ tgcloud push завершился ошибкой (не похоже на известный баг снимка) — деплой остановлен.');
    process.exit(push.status ?? 1);
  }
  console.warn('\n⚠️ Известный баг CLI 0.2.0 при записи локального снимка; код на сервер уже загружен. Продолжаю.');
  try {
    const ep = await import(pathToFileURL(resolve('node_modules/@tgcloud/cli/src/api/endpoints.js')).href);
    const state = await ep.getFiles(process.env.TGCLOUD_TOKEN);
    const bad = Object.entries(state.canonical_modules ?? {}).filter(([, v]) => typeof v !== 'string').map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    console.log('Модули на сервере:', Object.keys(state.canonical_modules ?? {}).length, '| не строки:', bad.length ? bad.join(', ') : 'нет');
  } catch (e) {
    console.log('Диагностика состояния не удалась:', e?.message ?? e);
  }
}

// 2. миграция БД (только безопасные изменения)
const mig = run(['migrate', '--safe']);
if (mig.status !== 0) {
  console.error('\n❌ migrate --safe завершился ошибкой.');
  process.exit(mig.status ?? 1);
}

// 3. webhook должен соответствовать задеплоенным обработчикам
run(['webhook', 'sync']);
run(['webhook']);
console.log('\n✅ Деплой завершён.');
