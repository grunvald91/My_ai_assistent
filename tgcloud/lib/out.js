// out.js — отправка сообщений в Telegram: Markdown → HTML, разбиение на части, повтор при 429,
// запасной вариант «простым текстом», если Telegram не принял разметку.

import { renderChunks } from './format.js';
import { escapeHtml, truncate } from './util.js';

const isParseError = (e) => e?.code === 400 && /parse|entit|can't find end|unsupported start tag|unclosed/i.test(e.description ?? '');
const isGoneTarget = (e) => e?.code === 400 && /thread not found|reply message not found|message to reply not found/i.test(e.description ?? '');
const isNotModified = (e) => e?.code === 400 && /not modified/i.test(e.description ?? '');

/** HTML → простой текст (на случай, если Telegram отверг разметку). */
export function htmlToPlain(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function createOut(D) {
  const { api } = D;

  /** Вызов метода Bot API с одним повтором при 429 (flood control). */
  async function call(method, params) {
    try {
      return await api[method](params);
    } catch (e) {
      if (e?.code === 429) {
        const wait = Number(e.parameters?.retry_after ?? 1);
        if (wait <= 5) {
          await D.sleep(wait * 1000 + 100);
          return api[method](params);
        }
      }
      throw e;
    }
  }

  /**
   * Отправляет текст (Markdown) одним или несколькими сообщениями.
   * markup вешается на последнее сообщение. Возвращает массив отправленных сообщений.
   * opts: { chatId, text, replyTo, threadId, bizConn, markup, ephemeralTo, html }
   *   html — готовый HTML вместо Markdown (тогда делится только по длине).
   */
  async function sendText(opts) {
    const { chatId, text, replyTo, threadId, bizConn, markup, ephemeralTo } = opts;
    let chunks;
    if (opts.html != null) chunks = [{ html: String(opts.html).slice(0, 4096), md: htmlToPlain(opts.html).slice(0, 4096) }];
    else chunks = renderChunks(text);
    if (!chunks.length) chunks = [{ html: '…', md: '…' }];

    const sent = [];
    let useReply = !!replyTo;
    let useThread = !!threadId;
    let useEphemeral = !!ephemeralTo;
    for (let i = 0; i < chunks.length; i++) {
      const base = () => {
        const p = { chat_id: chatId, link_preview_options: { is_disabled: true } };
        if (useThread) p.message_thread_id = threadId;
        if (bizConn) p.business_connection_id = bizConn;
        if (useReply && i === 0) p.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
        if (i === chunks.length - 1 && markup) p.reply_markup = markup;
        if (useEphemeral) p.ephemeral_message_parameters = { receiver_user_id: ephemeralTo };
        return p;
      };
      let m;
      for (let attempt = 0; attempt < 4 && !m; attempt++) {
        try {
          m = await call('sendMessage', { ...base(), text: chunks[i].html, parse_mode: 'HTML' });
        } catch (e) {
          if (isParseError(e)) {
            m = await call('sendMessage', { ...base(), text: truncate(chunks[i].md, 4096, '') });
          } else if (useEphemeral && e?.code === 400) {
            useEphemeral = false; // эфемерные сообщения недоступны — отвечаем обычным сообщением
          } else if ((useThread || useReply) && isGoneTarget(e)) {
            useThread = false;
            useReply = false;
          } else {
            throw e;
          }
        }
      }
      if (!m) throw new Error('sendText: не удалось отправить сообщение');
      sent.push(m);
    }
    return sent;
  }

  /** Готовый HTML (интерфейс бота: списки, подсказки, кнопки). */
  async function sendHtml(chatId, html, extra = {}) {
    const p = { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
    try {
      return await call('sendMessage', p);
    } catch (e) {
      if (isParseError(e)) return call('sendMessage', { ...p, text: truncate(htmlToPlain(html), 4096, ''), parse_mode: undefined });
      throw e;
    }
  }

  async function editHtml(chatId, messageId, html, markup) {
    const p = { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (markup !== undefined) p.reply_markup = markup ?? { inline_keyboard: [] };
    try {
      return await call('editMessageText', p);
    } catch (e) {
      if (isNotModified(e)) return null;
      throw e;
    }
  }

  async function dropButtons(chatId, messageId) {
    try {
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    } catch {
      /* сообщение могло быть удалено или без кнопок — не страшно */
    }
  }

  async function answerCb(id, text, alert = false) {
    try {
      await api.answerCallbackQuery({ callback_query_id: id, text: text ? truncate(text, 190) : undefined, show_alert: alert || undefined });
    } catch {
      /* кнопка устарела — не страшно */
    }
  }

  async function typing(chatId, { threadId, bizConn } = {}) {
    try {
      const p = { chat_id: chatId, action: 'typing' };
      if (threadId) p.message_thread_id = threadId;
      if (bizConn) p.business_connection_id = bizConn;
      await api.sendChatAction(p);
    } catch {
      /* индикатор — «приятная мелочь», его сбой не должен ничего ломать */
    }
  }

  /** Сообщение владельцу в личку (id владельца = id его личного чата). */
  async function toOwner(html, extra = {}) {
    if (!D.ownerId) return null;
    try {
      return await sendHtml(D.ownerId, html, extra);
    } catch (e) {
      console.warn('toOwner failed', e?.message ?? e);
      return null;
    }
  }

  return { call, sendText, sendHtml, editHtml, dropButtons, answerCb, typing, toOwner, escapeHtml };
}
