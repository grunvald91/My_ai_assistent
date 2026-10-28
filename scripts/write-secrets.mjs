// Генерирует tgcloud/lib/secrets.js из переменных окружения перед деплоем.
// Файл в .gitignore: ключ не попадает в репозиторий. Но после push он живёт в коде бота на серверах
// Telegram (в Serverless нет отдельного хранилища секретов) — см. README.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const key = (process.env.CLAUDEHUB_API_KEY ?? '').trim();
const owners = (process.env.OWNER_IDS ?? '').trim();
const ghPat = (process.env.GH_PAT ?? '').trim();
const exaKey = (process.env.EXA_API_KEY ?? '').trim(); // необязательный: без него веб-поиск выключен
// Репозиторий бота: GitHub Actions сам задаёт GITHUB_REPOSITORY. Код в нём бот менять не вправе.
const selfRepo = (process.env.GITHUB_REPOSITORY || 'grunvald91/my_ai_assistent').trim();

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
    `export const OWNER_IDS = ${JSON.stringify(owners)};\n` +
    `export const GH_PAT = ${JSON.stringify(ghPat)};\n` +
    `export const SELF_REPO = ${JSON.stringify(selfRepo)};\n` +
    `export const EXA_API_KEY = ${JSON.stringify(exaKey)};\n`,
);
console.log('secrets.js записан (ключ, владельцы' + (ghPat ? ', GitHub-токен' : '; GH_PAT не задан — режим /code выключен') + (exaKey ? ', ключ Exa' : '; EXA_API_KEY не задан — веб-поиск выключен') + ').');
