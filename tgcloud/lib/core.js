// core.js — общее ядро: список моделей (кеш 24 ч), лимиты расходов, вызов ИИ с учётом расхода,
// сжатие истории в сводку (память ур. 2). Зависимости приходят в объекте D (см. app.js).

import { MODEL_PREFERENCE, THINK_LEVELS } from './config.js';
import { normalizeModels, pickDefault, providerOf, costUsd } from './models.js';
import { buildMessages, promptTokens } from './context.js';
import { summarySystem } from './persona.js';
import { estimateTokens } from './tokens.js';
import { dayKey, safeJson, truncate } from './util.js';

/** Лимит расходов: ошибка с готовым текстом для владельца. */
export class LimitError extends Error {
  constructor(kind, userMessage) {
    super('limit:' + kind);
    this.name = 'LimitError';
    this.kind = kind; // daily | rpm
    this.userMessage = userMessage;
  }
}

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function createCore(D) {
  const { store, llm, cfg } = D;

  const tz = () => cfg.tzOffsetHours;

  async function setting(key, def = null) {
    const v = await store.getSetting(key);
    return v ?? def;
  }

  // ───────── модели ─────────

  async function getModels({ force = false } = {}) {
    const s = await store.getSettings(['models_cache', 'models_ts']);
    const age = D.now() - Number(s.models_ts || 0);
    const cached = safeJson(s.models_cache, []);
    const oldShape = cached.length && cached[0].maxOut === undefined; // кеш до появления maxOut/thinking
    if (!force && cached.length && !oldShape && age < cfg.modelsTtlSec) return cached;
    try {
      const fresh = normalizeModels(await llm.listModels());
      if (fresh.length) {
        await store.setSetting('models_cache', JSON.stringify(fresh));
        await store.setSetting('models_ts', D.now());
        return fresh;
      }
    } catch (e) {
      console.warn('models fetch failed', e?.message ?? e);
    }
    if (cached.length) return cached; // устаревший кеш лучше, чем ничего
    // аварийный список, чтобы бот работал, даже если каталог недоступен
    return MODEL_PREFERENCE.map(fallbackModel);
  }

  const fallbackModel = (id) => ({ id, name: id, provider: providerOf(id), down: false, priceIn: null, priceOut: null, ctx: null, vision: false, maxOut: null, thinking: /^claude/i.test(id) });

  /** Модель чата: выбранная в чате → общая по умолчанию → первая «живая» из предпочтений. */
  async function resolveModel(chat) {
    const models = await getModels();
    const id = chat?.model || (await setting('default_model')) || pickDefault(models);
    return models.find((m) => m.id === id) ?? fallbackModel(id);
  }

  /** Модель владельца (для постов, Business, сводок): та, что выбрана в его личном чате. */
  async function ownerModel() {
    const chat = D.ownerId ? await store.getChat(D.ownerId) : null;
    return resolveModel(chat);
  }

  // ───────── лимиты ─────────

  async function dailyLimit() {
    const v = Number(await setting('daily_limit'));
    return v > 0 ? v : cfg.dailyTokenLimit;
  }

  async function todayUsage() {
    const row = await store.getUsage(dayKey(D.now(), tz()));
    return row ?? { tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };
  }

  async function assertLimits() {
    const [u, limit] = [await todayUsage(), await dailyLimit()];
    const used = u.tokensIn + u.tokensOut;
    if (used >= limit) {
      throw new LimitError(
        'daily',
        `⛔ Дневной лимит токенов исчерпан: ${fmt(used)} из ${fmt(limit)}. Подними лимит командой /limit ${Math.round(limit * 1.5)} или дождись завтра.`,
      );
    }
    const h = await store.hit('llm:rpm', Math.floor(D.now() / 60), cfg.rpmLimit);
    if (!h.allowed) throw new LimitError('rpm', '⏳ Слишком много запросов к ИИ за минуту. Подожди немного и повтори.');
  }

  // ───────── вызов ИИ ─────────

  /**
   * @returns {{text, usage, finish, stopped, error?, tokensIn, tokensOut}}
   * Бросает LimitError (лимиты) или LlmError (сбой ClaudeHub).
   */
  async function generate({ model, messages, maxTokens, stream = false, onProgress, retries, think, deadline }) {
    await assertLimits();
    const cap = maxTokens === 'max' ? model.maxOut || cfg.maxTokensFallback : maxTokens;
    const level = think && think !== 'off' && model.thinking ? think : null;

    // время каждого вызова — в журнал: по нему видно, где ClaudeHub тормозит или рвёт соединение
    const t0 = Date.now();
    const dl = deadline === undefined ? (D.t0 && cfg.cutAfterMs ? D.t0 + cfg.cutAfterMs : null) : deadline; // срок вызова бота (см. cfg.cutAfterMs)
    let res;
    try {
      res = await llm.chat({
        model: model.id,
        messages,
        maxTokens: cap,
        stream,
        onProgress,
        retries,
        deadline: dl,
        think: level ? { level, budget: cfg.thinkBudgets[level] } : null,
      });
    } catch (e) {
      await D.log('llm_fail', null, { model: model.id, kind: e?.kind ?? 'error', status: e?.status ?? 0, ms: Date.now() - t0 });
      throw e;
    }
    await D.log('llm', null, { model: model.id, ms: Date.now() - t0, think: level ?? 'off', finish: res.finish ?? null, stopped: !!res.stopped, cut: !!res.cut });

    const tokensIn = res.usage?.in ?? promptTokens(messages);
    const tokensOut = res.usage?.out ?? estimateTokens(res.text);
    await store.addUsage(dayKey(D.now(), tz()), tokensIn, tokensOut, costUsd(model, tokensIn, tokensOut));
    // thinkAsked: размышления просили, но ClaudeHub/модель их не приняла (ответ дан без них)
    return { ...res, tokensIn, tokensOut, thinkAsked: !!level, thinkDropped: !!level && !res.thinkUsed };
  }

  /** Учёт расхода для ответов, полученных не через generate (фоновые, из GitHub Actions). */
  async function recordUsage(modelId, tokensIn, tokensOut) {
    const model = (await getModels()).find((m) => m.id === modelId);
    await store.addUsage(dayKey(D.now(), tz()), tokensIn, tokensOut, costUsd(model, tokensIn, tokensOut));
  }

  // ───────── память ─────────

  async function memoryTexts(scopes) {
    const rows = await store.listMemories(scopes);
    return rows.map((r) => r.text);
  }

  /** Если несжатых сообщений слишком много — сжимаем старые в сводку (ур. 2), свежие оставляем. */
  async function maybeSummarize(chat) {
    const key = String(chat.chatId);
    const after = chat.summaryUpto ?? 0;
    const n = await store.countAfter(key, after);
    if (n <= cfg.summaryTrigger) return false;
    const old = await store.oldestAfter(key, after, n - cfg.historyMessages);
    if (!old.length) return false;

    const transcript = old
      .map((m) => `${m.role === 'assistant' ? 'Ассистент' : m.name || 'Владелец'}: ${m.text}`)
      .join('\n');
    const prev = chat.summary ? `Прежняя сводка:\n${chat.summary}\n\n` : '';
    const model = await resolveModel(chat);
    const res = await generate({
      model,
      messages: [
        { role: 'system', content: summarySystem() },
        { role: 'user', content: `${prev}Новые сообщения для сжатия:\n${truncate(transcript, 24000, '\n…')}` },
      ],
      maxTokens: cfg.maxTokensSummary,
      retries: 1,
    });
    const lastId = old[old.length - 1].id;
    await store.updateChat(chat.chatId, { summary: truncate(res.text.trim(), 2500), summaryUpto: lastId });
    await store.deleteUpTo(key, lastId);
    return true;
  }

  /** Контекст для запроса: сводка + свежая история в пределах бюджета токенов. */
  async function contextFor({ key, chat, system }) {
    const history = await store.getHistory(key, chat?.summaryUpto ?? 0, 80);
    return buildMessages({ system, summary: chat?.summary, history, budget: cfg.historyTokenBudget });
  }

  // ───────── прочее ─────────

  /** Уровень размышлений (/think): off | low | medium | high. */
  async function thinkLevel() {
    const v = await setting('think');
    return THINK_LEVELS.includes(v) ? v : 'off';
  }

  async function paused() {
    return (await setting('paused')) === '1';
  }

  async function ownerName() {
    return (await setting('owner_name')) || 'владелец';
  }

  return {
    setting, getModels, resolveModel, ownerModel, dailyLimit, todayUsage, assertLimits,
    generate, recordUsage, thinkLevel, memoryTexts, maybeSummarize, contextFor, paused, ownerName, tz,
  };
}
