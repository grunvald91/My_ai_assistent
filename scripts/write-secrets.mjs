// Генерирует tgcloud/lib/secrets.js из переменных окружения перед деплоем.
// Файл в .gitignore: ключ не попадает в репозиторий. Но после push он живёт в коде бота на серверах
// Telegram (в Serverless нет отдельного хранилища секретов) — см. README.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const key = (process.env.CLAUDEHUB_API_KEY ?? '').trim();
const owners = (process.env.OWNER_IDS ?? '').trim();

if (!key) {
  console.error('Не задан CLAUDEHUB_API_KEY (переменная окружения / секрет GitHub Actions).');
  process.exit(1);
}
if (owners && !/^[\d\s,;-]+$/.test(owners)) {
  console.error('OWNER_IDS должен содержать только числа (Telegram ID), через запятую.');
  process.exit(1);
}
if (!owners) console.warn('⚠️ OWNER_IDS не задан: бот задеплоится, но ответит любому «не настроен» и покажет его ID.');

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tgcloud', 'lib', 'secrets.js');
writeFileSync(
  out,
  `// СГЕНЕРИРОВАНО scripts/write-secrets.mjs — не редактировать и не коммитить.\n` +
    `export const CLAUDEHUB_API_KEY = ${JSON.stringify(key)};\n` +
    `export const OWNER_IDS = ${JSON.stringify(owners)};\n`,
);
console.log('secrets.js записан (ключ и владельцы).');
