// llm.js — клиент ClaudeHub (https://app.claudehub.fun/docs).
//
// Используем OpenAI-совместимый POST /v1/chat/completions: он принимает и Claude-, и GPT-,
// и другие модели из списка шлюза — то есть /model может переключать модели любых вендоров.
// Авторизация: Authorization: Bearer sk-hub-… ; стрим: "stream": true → SSE «data: {...}», в конце [DONE].
// Размышление (thinking) в ClaudeHub описано только для Anthropic-формата POST /v1/messages
// (thinking.budget_tokens) — поэтому Claude с включённым /think идёт туда; остальные модели — в
// chat/completions с reasoning_effort. Если шлюз/модель параметр отвергает — снимаем его и повторяем.
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
    this.kind = kind; // auth | balance | forbidden | notfound | too_large | bad_request | budget | timeout | rate | upstream | network
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
      case 'budget':
        return '🧠 Модель потратила весь лимит ответа на размышления и не успела ответить. Понизь уровень: /think';
      case 'timeout':
        return '⏱ Модель не успела начать ответ: Telegram обрывает вызов бота примерно через 30 секунд. Так бывает у медленных моделей и при длинных размышлениях — выбери модель быстрее или понизь /think.';
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

const isClaude = (model) => /^claude/i.test(model);
const DEFAULT_MAX = 16000; // /v1/messages требует max_tokens; core.js всегда передаёт своё значение

/** OpenAI-сообщения → формат Anthropic: system отдельно, роли чередуются, первая — user. */
/** Части сообщения в формат Anthropic: текст, картинка (data:URI → base64), документ (PDF). */
function anthropicBlocks(content) {
  const blocks = [];
  for (const p of content) {
    if (typeof p === 'string') blocks.push({ type: 'text', text: p });
    else if (p?.type === 'image_url') {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url ?? '');
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    } else if (p?.type === 'document') blocks.push({ type: 'document', source: { type: 'base64', media_type: p.mediaType || 'application/pdf', data: p.data } });
    else if (p?.text) blocks.push({ type: 'text', text: p.text });
  }
  return blocks;
}

/** Есть ли в сообщениях PDF-документы (их понимает только формат Anthropic). */
export const hasDocument = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'document'));

export function toAnthropic(messages) {
  const sys = [];
  const out = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (m.role === 'system') {
      if (text) sys.push(text);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    const rich = Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url' || p?.type === 'document');
    if (last && last.role === role) {
      if (rich || Array.isArray(last.content)) {
        const prev = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
        last.content = [...prev, ...(rich ? anthropicBlocks(m.content) : [{ type: 'text', text: text || '…' }])];
      } else last.content += '\n\n' + (text || '…');
    } else out.push({ role, content: rich ? anthropicBlocks(m.content) : text || '…' });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '(начало переписки)' });
  return { system: sys.join('\n\n'), messages: out };
}

const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter' };

/** Режимы размышления Claude по порядку отката: бюджет токенов → adaptive+effort → без размышлений. */
const THINK_MODES = ['budget', 'adaptive', 'none'];

function thinkBody(mode, think, maxTokens) {
  if (mode === 'budget') {
    const budget = Math.min(think.budget, maxTokens - 1024);
    return budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : null;
  }
  if (mode === 'adaptive') return { thinking: { type: 'adaptive' }, output_config: { effort: think.level } };
  return null;
}

/** Гонка с таймером срока; таймер всегда снимается. Если setTimeout в среде нет — срок проверяется только между порциями. */
const TIMED_OUT = Symbol('timeout');
function withDeadline(p, ms) {
  if (typeof setTimeout !== 'function') return p;
  let id;
  const t = new Promise((r) => {
    id = setTimeout(() => r(TIMED_OUT), Math.max(0, ms));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(id));
}

export function createLlm({ fetch, apiKey, base = API_BASE, sleep = async () => {}, retries = 2 }) {
  const authHeaders = () => ({ Authorization: 'Bearer ' + apiKey });

  async function once({ model, messages, maxTokens, temperature, stream, onProgress, think, st, deadline }) {
    const left = () => (deadline ? deadline - Date.now() : Infinity);
    const late = () => new LlmError('timeout', 'модель не ответила за отведённое время', { retryable: false });
    const strip = st.strip;
    const thinkMode = THINK_MODES[st.thinkIdx];
    const forceAnth = isClaude(model) && hasDocument(messages); // PDF уходит только форматом Anthropic
    const anth = isClaude(model) && ((!!think && thinkMode !== 'none') || forceAnth);

    let url;
    let headers;
    let body;
    let thinkUsed = null;
    if (anth) {
      const max = maxTokens && !strip.has('max_tokens') ? maxTokens : DEFAULT_MAX;
      const a = toAnthropic(messages);
      body = { model, max_tokens: max, messages: a.messages, stream: !!stream };
      if (a.system) body.system = a.system;
      const tb = think && thinkMode !== 'none' ? thinkBody(thinkMode, think, max) : null;
      if (tb) {
        Object.assign(body, tb); // с thinking температуру не передаём
        thinkUsed = thinkMode;
      } else if (temperature != null) body.temperature = temperature;
      url = base + '/v1/messages';
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    } else {
      body = { model, messages, stream: !!stream };
      if (maxTokens && !strip.has('max_tokens')) body[isClaude(model) ? 'max_tokens' : 'max_completion_tokens'] = maxTokens;
      if (temperature != null) body.temperature = temperature;
      if (stream && !strip.has('stream_options')) body.stream_options = { include_usage: true };
      if (think && !isClaude(model) && !strip.has('reasoning_effort')) {
        body.reasoning_effort = think.level;
        thinkUsed = 'effort';
      }
      url = base + '/v1/chat/completions';
      headers = { ...authHeaders(), 'Content-Type': 'application/json' };
    }

    let res;
    try {
      if (left() <= 0) throw late();
      const pending = fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (deadline) {
        pending.catch(() => {}); // если выиграл таймер — позднюю ошибку запроса не разбираем
        const r = await withDeadline(pending, left());
        if (r === TIMED_OUT) throw late();
        res = r;
      } else res = await pending;
    } catch (e) {
      if (e instanceof LlmError) throw e;
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
      let text;
      let finish;
      if (anth) {
        text = (j.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        finish = STOP[j.stop_reason] ?? j.stop_reason ?? null;
      } else {
        const ch = j?.choices?.[0];
        text = contentToText(ch?.message?.content);
        finish = ch?.finish_reason ?? null;
      }
      if (!text.trim()) throw emptyError(finish);
      return { text, usage: normUsage(j.usage), finish, stopped: false, thinkUsed };
    }

    // ── потоковый режим
    let text = '';
    let thinking = 0; // сколько символов «размышлений» пришло (сами размышления не храним)
    let usage = null;
    let finish = null;
    let done = false;
    let streamError = null;
    const dec = createUtf8Decoder();
    const addUsage = (u) => {
      // у Anthropic вход приходит в message_start, выход — в message_delta: складываем по частям
      const n = normUsage(u);
      if (!n) return;
      const cached = Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
      usage = {
        in: u.input_tokens != null ? n.in + cached : usage?.in ?? 0,
        out: u.output_tokens != null || u.completion_tokens != null ? n.out : usage?.out ?? 0,
      };
    };
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
      if (anth) {
        switch (j.type) {
          case 'message_start':
            addUsage(j.message?.usage);
            break;
          case 'content_block_delta':
            if (j.delta?.type === 'text_delta') text += j.delta.text ?? '';
            else if (j.delta?.type === 'thinking_delta') thinking += (j.delta.thinking ?? '').length;
            break;
          case 'message_delta':
            if (j.delta?.stop_reason) finish = STOP[j.delta.stop_reason] ?? j.delta.stop_reason;
            addUsage(j.usage);
            break;
          case 'message_stop':
            done = true;
            break;
          default:
        }
        return;
      }
      if (j?.usage) usage = normUsage(j.usage) ?? usage;
      const ch = j?.choices?.[0];
      if (ch) {
        text += contentToText(ch.delta?.content);
        if (typeof ch.delta?.reasoning_content === 'string') thinking += ch.delta.reasoning_content.length;
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    });

    let stopped = false;
    let cut = false; // оборвали по сроку: платформа Telegram убивает вызов бота примерно через 30 с
    let readError = null;
    try {
      const it = res.body[Symbol.asyncIterator]();
      for (;;) {
        if (deadline && left() <= 0) {
          cut = true;
          break;
        }
        const next = it.next();
        let step;
        if (deadline) {
          next.catch(() => {});
          step = await withDeadline(next, left());
          if (step === TIMED_OUT) {
            cut = true;
            break;
          }
        } else step = await next;
        if (step.done) break;
        const chunk = step.value;
        parser.push(typeof chunk === 'string' ? chunk : dec.decode(chunk));
        if (streamError) break;
        if (onProgress) {
          if (await onProgress({ text, thinking })) {
            stopped = true;
            break;
          }
        }
        if (done) break;
      }
      if (cut || stopped) {
        try {
          const r = it.return?.();
          r?.catch?.(() => {}); // закрываем поток, не дожидаясь
        } catch {
          /* поток уже закрыт */
        }
      }
      parser.push(dec.flush());
      parser.end();
    } catch (e) {
      readError = e;
    }

    const err = streamError ?? (readError ? new LlmError('network', String(readError?.message ?? readError), { retryable: true }) : null);
    if (err && !text) throw err;
    if (cut && !text.trim()) throw late();
    if (!text.trim() && !stopped) throw emptyError(finish);
    return { text, usage, finish: cut ? 'cut' : finish, stopped, cut: cut || undefined, error: err ?? undefined, thinkUsed };
  }

  /** Пустой ответ: если упёрлись в лимит — значит всё ушло на размышления (повтор не поможет). */
  function emptyError(finish) {
    return finish === 'length'
      ? new LlmError('budget', 'весь лимит ушёл на размышления')
      : new LlmError('upstream', 'пустой ответ модели', { retryable: true });
  }

  /**
   * Запрос к модели. С retries повторяет временные сбои (429/5xx/сеть) ДО того, как пошёл текст;
   * лишние параметры (stream_options, max_tokens), которые отвергла модель, убирает и повторяет.
   */
  async function chat(opts) {
    const st = { strip: new Set(), thinkIdx: 0 };
    let attempt = 0;
    for (;;) {
      try {
        return await once({ ...opts, st });
      } catch (e) {
        if (!(e instanceof LlmError)) throw new LlmError('network', String(e?.message ?? e), { retryable: true });
        if (e.kind === 'bad_request') {
          const m = e.message.toLowerCase();
          // параметры размышления отвергнуты → следующий способ, в конце — без размышлений
          if (opts.think && /think|budget|effort|reasoning/.test(m)) {
            if (isClaude(opts.model) && st.thinkIdx < THINK_MODES.length - 1) {
              st.thinkIdx++;
              continue;
            }
            if (!isClaude(opts.model) && !st.strip.has('reasoning_effort')) {
              st.strip.add('reasoning_effort');
              continue;
            }
          }
          if (!st.strip.has('stream_options') && m.includes('stream_options')) {
            st.strip.add('stream_options');
            continue;
          }
          if (!st.strip.has('max_tokens') && /max_(completion_)?tokens/.test(m)) {
            st.strip.add('max_tokens');
            continue;
          }
        }
        const limit = opts.retries ?? retries;
        if (!e.retryable || attempt >= limit || (opts.deadline && Date.now() >= opts.deadline - 2000)) throw e;
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
