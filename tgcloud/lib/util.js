// util.js — мелкие чистые помощники. Без sdk, без Node-API: платформа — это V8-изолят,
// здесь нет Buffer, TextEncoder, Intl, crypto и т.п. Только стандартный JavaScript.

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Короткий уникальный id (~14 символов, помещается в callback_data). */
export function uid() {
  let r = '';
  for (let i = 0; i < 6; i++) r += Math.floor(Math.random() * 36).toString(36);
  return Date.now().toString(36) + r;
}

/** Случайное ненулевое 31-битное число (draft_id для sendMessageDraft). */
export function randomDraftId() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function truncate(s, n, suffix = '…') {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - suffix.length)) + suffix;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

/** Ключ дня «YYYY-MM-DD» с учётом часового пояса владельца. */
export function dayKey(sec, tzHours = 3) {
  const d = new Date((sec + tzHours * 3600) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function monthKey(sec, tzHours = 3) {
  return dayKey(sec, tzHours).slice(0, 7);
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** «20.10 00:36» — короткая дата и время в часовом поясе владельца. */
export function shortTime(sec, tzHours = 3) {
  const d = new Date((sec + tzHours * 3600) * 1000);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** «понедельник, 19 октября 2026, 22:29 (UTC+3)» */
export function formatNow(sec, tzHours = 3) {
  const d = new Date((sec + tzHours * 3600) * 1000);
  const sign = tzHours >= 0 ? '+' : '-';
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} (UTC${sign}${Math.abs(tzHours)})`
  );
}

/** Разбор команды: "/model@bot arg" → { cmd:'model', arg:'arg' }. Чужой бот → { foreign:true }. */
export function parseCommand(text, botUsername) {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec((text ?? '').trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== String(botUsername).toLowerCase()) {
    return { foreign: true };
  }
  return { cmd: m[1].toLowerCase(), arg: (m[3] ?? '').trim() };
}

/** Строка → байты UTF-8 (TextEncoder в изоляте не гарантирован). */
export function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/** Безопасный JSON.parse: при ошибке вернёт fallback. */
export function safeJson(s, fallback = null) {
  try {
    return s == null || s === '' ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Имя человека из объекта User/Chat. */
export function displayName(u) {
  if (!u) return 'Аноним';
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || u.title || (u.username ? '@' + u.username : 'Аноним');
}

/** Список целых id из строки "123, 456;789". */
export function parseIdList(s) {
  return String(s ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter((x) => /^-?\d+$/.test(x))
    .map(Number);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let PAIRS = null; // 12 бит → 2 символа: вдвое меньше операций на байт
/** Байты → base64 (btoa/Buffer в изоляте не гарантированы). Быстрый путь: таблица пар и сборка кусками. */
export function base64Encode(bytes) {
  if (!PAIRS) {
    PAIRS = new Array(4096);
    for (let i = 0; i < 4096; i++) PAIRS[i] = B64[i >> 6] + B64[i & 63];
  }
  const n = bytes.length;
  const full = n - (n % 3);
  const chunks = [];
  let part = [];
  for (let i = 0; i < full; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    part.push(PAIRS[v >> 12] + PAIRS[v & 4095]);
    if (part.length === 8192) {
      chunks.push(part.join(''));
      part = [];
    }
  }
  if (n - full === 1) {
    const a = bytes[full];
    part.push(B64[a >> 2] + B64[(a & 3) << 4] + '==');
  } else if (n - full === 2) {
    const a = bytes[full];
    const b = bytes[full + 1];
    part.push(B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + B64[(b & 15) << 2] + '=');
  }
  chunks.push(part.join(''));
  return chunks.join('');
}
