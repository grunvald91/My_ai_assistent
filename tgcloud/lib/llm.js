// llm.js — клиент ClaudeHub (https://app.claudehub.fun/docs).
//
// Используем OpenAI-совместимый POST /v1/chat/completions: он принимает и Claude-, и GPT-,
// и другие модели из списка шлюза — то есть /model может переключать модели любых вендоров.
// Авторизация: Authorization: Bearer sk-hub-… ; стрим: "stream": true → SSE «data: {...}», в конце [DONE].
// Ошибки (из доков ClaudeHub): 400 тело, 401 ключ, 402 баланс, 403 модель отключена,
// 404 нет модели, 413 слишком большой запрос, 429 лимит (Retry-After), 5xx/504 — повторить.
//
// Зависимости (fetch, sleep) передаются снаружи, чтобы модуль тестировался без платформы.

import { createSseParser } from './sse.js';
import { createUtf8Decoder } from './utf8.js';
import { API_BASE } from './config.js';

export class LlmError extends Error {
  constructor(kind, message, { status = 0, retryAfter = 0, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // auth | balance | forbidden | notfound | too_large | bad_request | rate | upstream | network
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
  }

  /** Текст для владельца — по-русски и с тем, что делать. */
  get userMessage() {
    switch (this.kind) {
      case 'auth':
        return '🔑 ClaudeHub не принял ключ (401). Проверь секрет CLAUDEHUB_API_KEY: ключ мог быть заморожен или удалён.';
      case 'balance':
        return '💸 На балансе ClaudeHub закончились средства (402). Пополни баланс в личном кабинете ClaudeHub.';
      case 'forbidden':
        return '🚫 Эта модель отключена для твоего ключа (403). Выбери другую: /model';
      case 'notfound':
        return '🔎 Такой модели нет в ClaudeHub (404). Выбери другую: /model';
      case 'too_large':
        return '📦 Запрос слишком большой (413). Сбрось историю чата: /reset';
      case 'bad_request':
        return '⚠️ ClaudeHub отклонил запрос (400)' + (this.message ? ': ' + this.message : '.');
      case 'rate':
        return '⏳ ClaudeHub просит подождать: слишком много запросов (429). Попробуй через минуту.';
      case 'upstream':
        return '🔌 ClaudeHub или выбранная модель сейчас недоступны' + (this.status ? ' (' + this.status + ')' : '') + '. Попробуй ещё раз или выбери другую модель: /model';
      default:
        return '🌐 Не получилось связаться с ClaudeHub. Попробуй ещё раз.';
    }
  }
}

function errorMessageFrom(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    return String(j?.error?.message ?? j?.message ?? '').slice(0, 300);
  } catch {
    return String(bodyText ?? '').slice(0, 200);
  }
}

export function classifyError(status, bodyText, retryAfterHeader) {
  const message = errorMessageFrom(bodyText);
  const retryAfter = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) : 0;
  const o = { status, retryAfter };
  if (status === 401) return new LlmError('auth', message, o);
  if (status === 402) return new LlmError('balance', message, o);
  if (status === 403) return new LlmError('forbidden', message, o);
  if (status === 404) return new LlmError('notfound', message, o);
  if (status === 413) return new LlmError('too_large', message, o);
  if (status === 429) return new LlmError('rate', message, { ...o, retryable: true });
  if (status >= 500) return new LlmError('upstream', message, { ...o, retryable: true });
  return new LlmError('bad_request', message, o);
}

function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.text ? p.text ?? '' : '')).join('');
  return '';
}

function normUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const i = Number(u.prompt_tokens ?? u.input_tokens);
  const o = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return null;
  return { in: Number.isFinite(i) ? i : 0, out: Number.isFinite(o) ? o : 0 };
}

// У части не-Claude моделей параметр max_tokens отвергается (нужен max_completion_tokens) —
// для них лимит не передаём; для Claude передаём.
const supportsMaxTokens = (model) => /^claude/i.test(model);

export function createLlm({ fetch, apiKey, base = API_BASE, sleep = async () => {}, retries = 2 }) {
  const authHeaders = () => ({ Authorization: 'Bearer ' + apiKey });

  async function once({ model, messages, maxTokens, temperature, stream, onProgress, strip }) {
    const body = { model, messages, stream: !!stream };
    if (maxTokens && !strip.has('max_tokens') && supportsMaxTokens(model)) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
    if (stream && !strip.has('stream_options')) body.stream_options = { include_usage: true };

    let res;
    try {
      res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LlmError('network', String(e?.message ?? e), { retryable: true });
    }

    if (!res.ok) {
      let t = '';
      try {
        t = await res.text();
      } catch {
        /* тело не прочиталось — не страшно */
      }
      throw classifyError(res.status, t, res.headers?.get?.('retry-after'));
    }

    if (!stream) {
      let j;
      try {
        j = await res.json();
      } catch {
        throw new LlmError('upstream', 'неразборчивый ответ', { status: res.status, retryable: true });
      }
      if (j?.error) throw classifyError(res.status || 500, JSON.stringify(j), 0);
      const ch = j?.choices?.[0];
      const text = contentToText(ch?.message?.content);
      if (!text.trim()) throw new LlmError('upstream', 'пустой ответ модели', { retryable: true });
      return { text, usage: normUsage(j.usage), finish: ch?.finish_reason ?? null, stopped: false };
    }

    // ── потоковый режим
    let text = '';
    let usage = null;
    let finish = null;
    let done = false;
    let streamError = null;
    const dec = createUtf8Decoder();
    const parser = createSseParser((ev) => {
      const d = ev.data.trim();
      if (d === '[DONE]') {
        done = true;
        return;
      }
      let j;
      try {
        j = JSON.parse(d);
      } catch {
        return;
      }
      if (j?.error) {
        streamError = new LlmError('upstream', String(j.error.message ?? '').slice(0, 200), { retryable: true });
        return;
      }
      if (j?.usage) usage = normUsage(j.usage) ?? usage;
      const ch = j?.choices?.[0];
      if (ch) {
        text += contentToText(ch.delta?.content);
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    });

    let stopped = false;
    let readError = null;
    try {
      for await (const chunk of res.body) {
        parser.push(typeof chunk === 'string' ? chunk : dec.decode(chunk));
        if (streamError) break;
        if (onProgress) {
          if (await onProgress({ text })) {
            stopped = true;
            break;
          }
        }
        if (done) break;
      }
      parser.push(dec.flush());
      parser.end();
    } catch (e) {
      readError = e;
    }

    const err = streamError ?? (readError ? new LlmError('network', String(readError?.message ?? readError), { retryable: true }) : null);
    if (err && !text) throw err;
    if (!text.trim() && !stopped) throw new LlmError('upstream', 'пустой ответ модели', { retryable: true });
    return { text, usage, finish, stopped, error: err ?? undefined };
  }

  /**
   * Запрос к модели. С retries повторяет временные сбои (429/5xx/сеть) ДО того, как пошёл текст;
   * лишние параметры (stream_options, max_tokens), которые отвергла модель, убирает и повторяет.
   */
  async function chat(opts) {
    const strip = new Set();
    let attempt = 0;
    for (;;) {
      try {
        return await once({ ...opts, strip });
      } catch (e) {
        if (!(e instanceof LlmError)) throw new LlmError('network', String(e?.message ?? e), { retryable: true });
        if (e.kind === 'bad_request') {
          const m = e.message.toLowerCase();
          if (!strip.has('stream_options') && m.includes('stream_options')) {
            strip.add('stream_options');
            continue;
          }
          if (!strip.has('max_tokens') && /max_(completion_)?tokens/.test(m)) {
            strip.add('max_tokens');
            continue;
          }
        }
        const limit = opts.retries ?? retries;
        if (!e.retryable || attempt >= limit) throw e;
        const waitMs = e.retryAfter ? Math.min(e.retryAfter, 10) * 1000 : 1000 * 2 ** attempt;
        attempt++;
        await sleep(waitMs);
      }
    }
  }

  /** Каталог моделей. Публичный, но с ключом вернёт цены именно вашего аккаунта. */
  async function listModels() {
    let res;
    try {
      res = await fetch(base + '/v1/models', { method: 'GET', headers: apiKey ? authHeaders() : {} });
    } catch (e) {
      throw new LlmError('network', String(e?.message ?? e), { retryable: true });
    }
    if (!res.ok) throw classifyError(res.status, await res.text().catch(() => ''), 0);
    const j = await res.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  /** Баланс аккаунта (кредиты, 1 кредит = 1 ₽). null, если не удалось узнать. */
  async function balance() {
    try {
      const res = await fetch(base + '/v1/balance', { method: 'GET', headers: authHeaders() });
      if (!res.ok) return null;
      const j = await res.json();
      return typeof j?.balance === 'number' ? { balance: j.balance, currency: j.currency ?? 'RUB' } : null;
    } catch {
      return null;
    }
  }

  return { chat, listModels, balance };
}
