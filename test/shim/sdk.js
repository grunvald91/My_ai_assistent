// Локальная замена платформенного 'sdk': db — настоящий SQLite (libsql в памяти) через Drizzle,
// api и fetch — управляемые заглушки (см. test/helpers/world.js).
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';

export const client = createClient({ url: ':memory:' });
export const db = drizzle(client);

export class BotApiError extends Error {
  constructor(method, code, description, parameters = {}) {
    super(`${method}: ${code} ${description}`);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.description = description;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(bytes, name, opts = {}) {
    this.bytes = bytes;
    this.name = name;
    this.type = opts.type;
  }
}

export class FormData {}

// api.<метод>(params) → globalThis.__tg(method, params)
export const api = new Proxy(
  {},
  {
    get(_, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (params) => globalThis.__tg(method, params ?? {});
    },
  },
);

export function fetch(url, opts) {
  return globalThis.__fetch(url, opts);
}
fetch.body = {
  json: (v) => JSON.stringify(v),
  form: (v) => new URLSearchParams(v).toString(),
  text: (v) => String(v),
};

export default { db, api, fetch };
