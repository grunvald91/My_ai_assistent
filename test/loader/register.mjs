// Подключается через `node --import`: подменяет платформенные модули 'sdk', 'sdk/db', ...
// на локальные заглушки из test/shim (настоящий Drizzle + SQLite в памяти, управляемые api/fetch).
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
