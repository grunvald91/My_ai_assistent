// models.js — что считать чат-моделью, как группировать и какую брать по умолчанию.
// Чистый модуль. Каталог ClaudeHub (GET /v1/models) содержит и картинки/видео/эмбеддинги —
// в /model их показывать не нужно: бот отвечает только текстом.

import { MODEL_PREFERENCE } from './config.js';

const NOT_CHAT = /embedding|image|veo|banana|tts|whisper|moderation|rerank/i;

export function isChatModel(m) {
  const id = String(m?.id ?? '');
  if (!id || NOT_CHAT.test(id)) return false;
  if (m.supports_streaming === false) return false;
  const mode = m.pricing?.billing_mode;
  if (mode && mode !== 'token') return false; // «за запрос» — это генерация картинок/видео
  return true;
}

const PROVIDERS = [
  ['Claude', /^claude/i],
  ['GPT', /^gpt/i],
  ['Gemini', /^gemini/i],
  ['DeepSeek', /^deepseek/i],
  ['Grok', /^grok/i],
  ['Kimi', /^kimi/i],
  ['Qwen', /^qwen/i],
  ['GLM', /^glm/i],
];
export const PROVIDER_ORDER = [...PROVIDERS.map((p) => p[0]), 'Другие'];

export function providerOf(id) {
  for (const [name, re] of PROVIDERS) if (re.test(id)) return name;
  return 'Другие';
}

/** Ответ /v1/models → компактный отсортированный список только чат-моделей. */
export function normalizeModels(list) {
  const out = [];
  for (const m of list || []) {
    if (!isChatModel(m)) continue;
    out.push({
      id: m.id,
      name: m.display_name || m.name || m.id,
      provider: providerOf(m.id),
      down: m.uptime_status === 'down',
      priceIn: m.pricing?.price_input_per_1m_usd ?? null,
      priceOut: m.pricing?.price_output_per_1m_usd ?? null,
      ctx: m.context_length ?? m.context_window ?? null,
      vision: !!m.supports_vision,
      maxOut: m.max_output_tokens ?? m.max_completion_tokens ?? null,
      thinking: !!(m.supports_thinking ?? m.capabilities?.thinking),
    });
  }
  out.sort((a, b) => {
    const pa = PROVIDER_ORDER.indexOf(a.provider);
    const pb = PROVIDER_ORDER.indexOf(b.provider);
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // новые версии выше
  });
  return out;
}

/** Модель по умолчанию: первая из списка предпочтений, что есть и не «лежит»; иначе любая живая. */
export function pickDefault(models, preference = MODEL_PREFERENCE) {
  for (const id of preference) {
    const m = models.find((x) => x.id === id && !x.down);
    if (m) return m.id;
  }
  const alive = models.find((m) => !m.down);
  return (alive ?? models[0])?.id ?? preference[0];
}

export function priceLabel(m) {
  if (!m || m.priceIn == null) return '';
  const f = (n) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));
  return m.priceOut != null && m.priceOut !== m.priceIn
    ? `$${f(m.priceIn)}/${f(m.priceOut)} за 1M`
    : `$${f(m.priceIn)} за 1M`;
}

/** Стоимость запроса в USD по тарифу модели (0, если цены неизвестны). */
export function costUsd(model, tokensIn, tokensOut) {
  if (!model || model.priceIn == null) return 0;
  return (tokensIn * model.priceIn + tokensOut * (model.priceOut ?? model.priceIn)) / 1e6;
}
