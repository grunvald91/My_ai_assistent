// context.js — собирает messages для запроса к модели: system + сводка + последние сообщения
// в пределах бюджета токенов. Чистый модуль.

import { estimateTokens } from './tokens.js';

/**
 * @param {object} p
 * @param {string} p.system       системный промпт
 * @param {string} [p.summary]    сводка старой части диалога (память ур. 2)
 * @param {Array}  p.history      сообщения по возрастанию: {role, name?, text}
 * @param {number} p.budget       бюджет токенов на историю
 * @param {number} [p.maxMessages] не больше стольких последних сообщений
 */
export function buildMessages({ system, summary, history, budget, maxMessages = 60 }) {
  const sys =
    system + (summary && summary.trim() ? '\n\nСВОДКА ПРЕДЫДУЩЕГО РАЗГОВОРА (старые сообщения уже сжаты сюда):\n' + summary.trim() : '');

  const mapped = history.slice(-maxMessages).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.role !== 'assistant' && m.name ? `${m.name}: ${m.text}` : m.text,
  }));

  // берём с конца, пока влезает в бюджет (но последнее сообщение — всегда)
  const picked = [];
  let used = 0;
  for (let i = mapped.length - 1; i >= 0; i--) {
    const cost = estimateTokens(mapped[i].content) + 4;
    if (picked.length > 0 && used + cost > budget) break;
    picked.push(mapped[i]);
    used += cost;
  }
  picked.reverse();
  // диалог должен начинаться с реплики пользователя
  while (picked.length > 1 && picked[0].role === 'assistant') picked.shift();

  return [{ role: 'system', content: sys }, ...picked];
}

/** Сколько токенов в запросе (для учёта, если API не вернул usage). */
export function promptTokens(messages) {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content) + 4;
  return n;
}
