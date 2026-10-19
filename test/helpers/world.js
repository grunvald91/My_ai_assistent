// Тестовый «мир»: настоящая БД (SQLite в памяти) со схемой из tgcloud/schema.js, заглушки Telegram Bot API
// и ClaudeHub (с потоковым SSE), готовое приложение createApp и удобные «клиенты» для сценариев.
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { client, BotApiError, InputFile } from '../shim/sdk.js';
import * as T from '../../tgcloud/schema.js';
import * as store from '../../tgcloud/lib/store.js';
import { createLlm } from '../../tgcloud/lib/llm.js';
import { createApp } from '../../tgcloud/lib/app.js';
import { DEFAULTS, API_BASE } from '../../tgcloud/lib/config.js';

export const OWNER = 1001;
export const BOT_ID = 777;
export const BOT_NAME = 'testbot';

// ───────── схема из описания таблиц ─────────
const tables = Object.values(T).filter((t) => t && typeof t === 'object' && Symbol.for('drizzle:Name') in t);
const SQL_TYPE = { SQLiteInteger: 'INTEGER', SQLiteText: 'TEXT', SQLiteReal: 'REAL', SQLiteBoolean: 'INTEGER', SQLiteTextJson: 'TEXT' };

function ddl(t) {
  const cfg = getTableConfig(t);
  const cols = cfg.columns.map((c) => {
    let s = `"${c.name}" ${SQL_TYPE[c.columnType] ?? 'TEXT'}`;
    if (c.primary) s += ' PRIMARY KEY' + (c.autoIncrement ? ' AUTOINCREMENT' : '');
    if (c.notNull && !c.primary) s += ' NOT NULL';
    if (c.isUnique) s += ' UNIQUE';
    if (c.hasDefault && c.default !== undefined && !c.defaultFn) {
      const d = c.default;
      s += ' DEFAULT ' + (typeof d === 'string' ? `'${d.replace(/'/g, "''")}'` : typeof d === 'boolean' ? (d ? 1 : 0) : d);
    }
    return s;
  });
  const out = [`CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(', ')})`];
  for (const ix of cfg.indexes) {
    const c = ix.config;
    out.push(`CREATE INDEX IF NOT EXISTS "${c.name}" ON "${cfg.name}" (${c.columns.map((x) => `"${x.name}"`).join(', ')})`);
  }
  return out;
}

let schemaReady = false;
export async function resetDb() {
  if (!schemaReady) {
    for (const t of tables) for (const q of ddl(t)) await client.execute(q);
    schemaReady = true;
  }
  for (const t of tables) await client.execute(`DELETE FROM "${getTableConfig(t).name}"`);
  await client.execute(`DELETE FROM sqlite_sequence`).catch(() => {});
}

// ───────── ClaudeHub ─────────
export const MODELS = [
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', uptime_status: 'up', pricing: { billing_mode: 'token', price_input_per_1m_usd: 3, price_output_per_1m_usd: 15 } },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', uptime_status: 'up', pricing: { billing_mode: 'token', price_input_per_1m_usd: 15, price_output_per_1m_usd: 75 } },
  { id: 'gpt-5', display_name: 'GPT-5', uptime_status: 'up', pricing: { billing_mode: 'token', price_input_per_1m_usd: 1.25, price_output_per_1m_usd: 10 } },
  { id: 'gemini-banana-image', display_name: 'Image', pricing: { billing_mode: 'request' } },
];

const enc = new TextEncoder();
function sseBody(text, usage) {
  const parts = text.length > 8 ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))] : [text];
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`, 'data: [DONE]\n\n');
  return {
    async *[Symbol.asyncIterator]() {
      for (const l of lines) yield enc.encode(l);
    },
  };
}
const jsonRes = (status, obj) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });

export async function createWorld({ ownerIds = [OWNER], cfg = {} } = {}) {
  await resetDb();
  const w = {
    now: 1_800_000_000, // 2027-01-15, фиксированное «сейчас»
    tg: [], // все вызовы Bot API: { method, params }
    llmCalls: [], // тела запросов к ClaudeHub
    llmReplies: [], // очередь ответов: строка или функция (body) => строка | { status, body }
    llmDefault: (body) => `Ответ на: ${[...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''}`.slice(0, 200),
    failures: new Map(), // method → очередь ошибок BotApiError
    nextMessageId: 100,
    modelFetches: 0,
    balance: { balance: 1234.5, currency: 'RUB' },
  };
  w.advance = (s) => (w.now += s);

  globalThis.__tg = async (method, params) => {
    w.tg.push({ method, params });
    const q = w.failures.get(method);
    if (q?.length) {
      const f = q.shift();
      if (f) throw f;
    }
    switch (method) {
      case 'getMe':
        return { id: BOT_ID, is_bot: true, username: BOT_NAME, first_name: 'Test' };
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
        return { message_id: ++w.nextMessageId, chat: { id: params.chat_id }, date: w.now, text: params.text };
      case 'sendMediaGroup':
        return params.media.map(() => ({ message_id: ++w.nextMessageId, chat: { id: params.chat_id } }));
      default:
        return true;
    }
  };

  globalThis.__fetch = async (url, opts = {}) => {
    const path = url.replace(API_BASE, '');
    if (path === '/v1/models') {
      w.modelFetches++;
      return jsonRes(200, { data: MODELS });
    }
    if (path === '/v1/balance') return jsonRes(200, w.balance);
    if (path === '/v1/chat/completions') {
      const body = JSON.parse(opts.body);
      w.llmCalls.push(body);
      let r = w.llmReplies.length ? w.llmReplies.shift() : w.llmDefault;
      if (typeof r === 'function') r = r(body);
      if (r && typeof r === 'object') return jsonRes(r.status, r.body ?? { error: { message: 'err' } });
      const usage = { prompt_tokens: 100, completion_tokens: Math.max(1, Math.ceil(String(r).length / 4)) };
      if (!body.stream) return { ...jsonRes(200, { choices: [{ message: { content: r }, finish_reason: 'stop' }], usage }) };
      return { ok: true, status: 200, headers: { get: () => null }, body: sseBody(String(r), usage) };
    }
    return jsonRes(404, {});
  };

  const llm = createLlm({ fetch: globalThis.__fetch, apiKey: 'sk-hub-test', base: API_BASE, sleep: async () => {}, retries: 2 });
  const app = createApp({
    api: new Proxy({}, { get: (_, m) => (typeof m === 'string' && m !== 'then' ? (p) => globalThis.__tg(m, p ?? {}) : undefined) }),
    store,
    llm,
    cfg: { ...DEFAULTS, ...cfg },
    now: () => w.now,
    sleep: async () => {},
    InputFile,
    ownerIds,
  });
  w.app = app;
  w.store = store;

  // ───────── клиенты ─────────
  let uid = 1;
  const send = (type, payload) => app.handle(type, payload, { update: { update_id: uid++ } });
  w.dispatchRaw = send;

  const user = (id, name = 'Имя') => ({ id, is_bot: false, first_name: name });
  w.say = (text, { from = OWNER, chat = from, extra = {} } = {}) =>
    send('message', { message_id: ++w.nextMessageId, date: w.now, chat: { id: chat, type: 'private' }, from: user(from), text, ...extra });
  w.photo = (fileId, { caption, group, from = OWNER } = {}) =>
    send('message', {
      message_id: ++w.nextMessageId, date: w.now, chat: { id: from, type: 'private' }, from: user(from),
      photo: [{ file_id: fileId + '_s', width: 10, height: 10 }, { file_id: fileId, width: 100, height: 100 }],
      ...(caption ? { caption } : {}), ...(group ? { media_group_id: group } : {}),
    });
  w.group = (text, { chat = -5001, from = 2002, title = 'Тестовая группа', replyTo, extra = {} } = {}) =>
    send('message', {
      message_id: ++w.nextMessageId, date: w.now, chat: { id: chat, type: 'supergroup', title }, from: user(from, 'Гость'), text,
      ...(replyTo ? { reply_to_message: replyTo } : {}), ...extra,
    });
  w.press = (data, { messageId = 5, chat = OWNER, from = OWNER } = {}) =>
    send('callback_query', { id: 'cb' + uid, from: user(from), data, message: { message_id: messageId, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' } } });

  // ───────── удобные выборки ─────────
  w.calls = (method) => w.tg.filter((c) => c.method === method).map((c) => c.params);
  w.sent = (chat) => w.calls('sendMessage').filter((p) => chat == null || p.chat_id === chat);
  w.last = (chat) => w.sent(chat).at(-1);
  w.clear = () => {
    w.tg.length = 0;
    w.llmCalls.length = 0;
  };
  w.fail = (method, code, description, parameters) => {
    const q = w.failures.get(method) ?? [];
    q.push(new BotApiError(method, code, description, parameters));
    w.failures.set(method, q);
  };
  w.setGroupMode = async (chat, mode, title = 'Тестовая группа') => {
    await store.ensureChat(chat, { type: 'supergroup', title }, w.now);
    await store.updateChat(chat, { groupMode: mode });
  };
  return w;
}

export { assert };
