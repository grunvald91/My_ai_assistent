// chat.js — ответы ИИ: личный чат владельца (со стримингом) и группы.

import { ownerSystem, groupSystem } from './persona.js';
import { LlmError } from './llm.js';
import { LimitError } from './core.js';
import { displayName, escapeHtml, randomDraftId, truncate, uid } from './util.js';

// ───────── «запомнить?» — предложение бота в конце ответа ─────────

const PROPOSAL_RE = /\[\[\s*запомнить\s*:\s*([\s\S]*?)\]\]\s*$/i;

/** Отделяет маркер [[запомнить: …]] от текста ответа. */
export function extractProposal(text) {
  const m = PROPOSAL_RE.exec(text);
  if (!m) return { text, fact: null };
  const fact = m[1].replace(/\s+/g, ' ').trim();
  return { text: text.slice(0, m.index).trimEnd(), fact: fact && fact.length <= 300 ? fact : null };
}

/** Что показывать в «черновике» во время стрима: без недописанного маркера. */
export function visibleDraft(text) {
  return text.replace(/\[\[\s*запомнить[\s\S]*$/i, '').replace(/\[\[[^\]]*$/, '').trim();
}

/** Текст ошибки для человека. */
export function explain(e) {
  if (e instanceof LimitError || e instanceof LlmError) return e.userMessage;
  return '⚠️ Что-то пошло не так. Ошибка записана в журнал — попробуй ещё раз.';
}

export function createChat(D) {
  const { store, out, core, cfg } = D;

  // ───────── стриминг ответа в личку через sendMessageDraft ─────────
  // Черновик живёт ~30 секунд как «живое превью»; итоговое сообщение отправляем обычным sendMessage.
  // Если Telegram не принимает черновики — просто молча отвечаем целиком.

  function draftStreamer(chatId) {
    const draftId = randomDraftId();
    const stopKey = `${chatId}:${draftId}`;
    let failed = false;
    let lastLen = 0;
    let lastAt = 0;

    const push = async (text) => {
      try {
        await D.api.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text, can_stop: true });
      } catch (e) {
        failed = true;
      }
    };

    return {
      draftId,
      async start() {
        await push(''); // пустой текст = плашка «Думаю…»
      },
      /** Вызывается по мере прихода текста. true = пользователь нажал «Стоп». */
      async onProgress({ text }) {
        if (failed) return false;
        const vis = visibleDraft(text);
        if (!vis) return false;
        // Частота: каждые ~120 новых символов или раз в ~1.2 с (время может «стоять» — тогда работает правило длины).
        const t = Date.now();
        if (vis.length - lastLen >= 120 || (vis.length > lastLen && t - lastAt >= 1200)) {
          lastLen = vis.length;
          lastAt = t;
          await push(vis.length > 4000 ? '…' + vis.slice(-3990) : vis);
          if (failed) return false;
          return store.isStopped(stopKey);
        }
        return false;
      },
    };
  }

  // ───────── личный чат владельца ─────────

  async function answerOwner(msg, chat, text) {
    const chatId = msg.chat.id;
    await store.addMessage({ chatKey: String(chatId), role: 'user', name: null, text, ts: D.now() });
    return respondOwner(chatId);
  }

  async function respondOwner(chatId) {
    const chat = await store.getChat(chatId);
    const key = String(chatId);
    const model = await core.resolveModel(chat);
    const memories = await core.memoryTexts(['owner']);
    const system = ownerSystem({ name: await core.ownerName(), memories, nowSec: D.now(), tz: core.tz() });
    const messages = await core.contextFor({ key, chat, system });

    const streamer = draftStreamer(chatId);
    await streamer.start();

    let res;
    try {
      res = await core.generate({ model, messages, maxTokens: cfg.maxTokensChat, stream: true, onProgress: streamer.onProgress });
    } catch (e) {
      return replyError(chatId, e);
    }

    const { text: clean, fact } = extractProposal(res.text.trim());
    let body = clean || '…';
    const saved = body;
    if (res.stopped) body += '\n\n⏹ Остановлено.';
    else if (res.finish === 'length') body += '\n\n…(ответ обрезан лимитом длины)';
    if (res.error) body += '\n\n⚠️ Связь с моделью оборвалась — ответ может быть неполным.';

    let markup;
    if (fact) {
      const pid = uid();
      await store.addProposal(pid, 'owner', fact, D.now());
      markup = {
        inline_keyboard: [[{ text: '💾 Запомнить', callback_data: 'mem:y:' + pid }, { text: '✖️ Не надо', callback_data: 'mem:n:' + pid }]],
      };
      body += `\n\n💡 Запомнить: _${fact}_`;
    }

    await out.sendText({ chatId, text: body, markup });
    await store.addMessage({ chatKey: key, role: 'assistant', text: saved, model: model.id, tokens: res.tokensOut, ts: D.now() });
    await store.updateChat(chatId, { lastReplyAt: D.now() });

    try {
      await core.maybeSummarize(await store.getChat(chatId));
    } catch (e) {
      console.warn('summarize failed', e?.message ?? e); // не критично: сводка сделается в следующий раз
    }
    await store.trimMessages(key, 300);
  }

  /** «🔄 Повторить»: заново отвечаем на последнее сообщение владельца. */
  async function retryLast(chatId) {
    const chat = await store.getChat(chatId);
    if (!chat) return false;
    const hist = await store.getHistory(String(chatId), chat.summaryUpto ?? 0, 1);
    const last = hist[hist.length - 1];
    if (!last || last.role !== 'user') return false;
    await respondOwner(chatId);
    return true;
  }

  async function replyError(chatId, e) {
    if (!(e instanceof LlmError || e instanceof LimitError)) {
      console.error(e);
      await D.log('error', chatId, { message: String(e?.message ?? e).slice(0, 300) });
    }
    const retryable = e instanceof LlmError && ['rate', 'upstream', 'network'].includes(e.kind);
    await out.sendHtml(chatId, escapeHtml(explain(e)), retryable ? { reply_markup: { inline_keyboard: [[{ text: '🔄 Повторить', callback_data: 'r:1' }]] } } : {});
  }

  // ───────── группы ─────────

  const quoteOf = (msg) => {
    const r = msg.reply_to_message;
    const t = r && (r.text ?? r.caption);
    if (!t || r.from?.is_bot) return '';
    return `↪️ в ответ на «${truncate(t, 200)}» (${displayName(r.from)}):\n`;
  };

  /** Один раз в сутки предупреждаем владельца о проблеме (лимит, баланс, ключ). */
  async function notifyOwnerOnce(e) {
    const kind = e instanceof LimitError || e instanceof LlmError ? e.kind : 'error';
    const r = await store.hit('notify:' + kind, Math.floor(D.now() / 86400), 1);
    if (r.allowed) await out.toOwner(escapeHtml('⚠️ В группе/чате не получилось ответить.\n' + explain(e)));
  }

  /**
   * Ответ в группе. mode: 'mention' (по запросу) | 'all' (на все сообщения).
   * Участники — посторонние: личная память владельца не используется, только факты этой группы.
   */
  async function answerGroup(msg, chat, text, mode) {
    const chatId = msg.chat.id;
    const key = String(chatId);
    const t = D.now();
    const name = displayName(msg.from);
    const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    const stored = quoteOf(msg) + text;

    // В режиме «на все» не частим: не чаще одного ответа в N секунд и не более N в час.
    if (mode === 'all' && t - (chat.lastReplyAt || 0) < cfg.groupMinGapSec) {
      await store.addMessage({ chatKey: key, role: 'user', name, text: stored, ts: t });
      return 'gap';
    }
    const cap = await store.hit('grp:' + chatId, Math.floor(t / 3600), cfg.groupHourlyCap);
    if (!cap.allowed) {
      await D.log('group_cap', chatId, { mode });
      return 'cap';
    }

    await store.addMessage({ chatKey: key, role: 'user', name, text: stored, ts: t });
    await out.typing(chatId, { threadId });

    const model = await core.resolveModel(chat);
    const memories = await core.memoryTexts(['group:' + chatId]);
    const system = groupSystem({
      ownerName: await core.ownerName(),
      title: chat.title ?? msg.chat.title ?? 'группа',
      memories,
      nowSec: t,
      tz: core.tz(),
      mode,
    });
    // в группах сводку не ведём (там чужие люди) — только свежая история
    const messages = await core.contextFor({ key, chat: { ...chat, summary: null, summaryUpto: 0 }, system });

    let res;
    try {
      res = await core.generate({ model, messages, maxTokens: cfg.maxTokensGroup });
    } catch (e) {
      if (e instanceof LimitError || e instanceof LlmError) {
        await notifyOwnerOnce(e);
        if (mode === 'mention') {
          await out.sendText({ chatId, text: 'Сейчас не могу ответить. Попробуй чуть позже.', replyTo: msg.message_id, threadId });
        }
        return 'error';
      }
      throw e;
    }

    const reply = res.text.trim() || '…';
    await out.sendText({ chatId, text: reply, replyTo: msg.message_id, threadId, ephemeralTo: chat.ephemeral ? msg.from.id : null });
    await store.addMessage({ chatKey: key, role: 'assistant', text: reply, model: model.id, tokens: res.tokensOut, ts: D.now() });
    await store.updateChat(chatId, { lastReplyAt: D.now() });
    await store.trimMessages(key, 120);

    if (chat.notifyOwner) {
      await out.toOwner(
        `💬 <b>${escapeHtml(chat.title ?? 'группа')}</b> · ${escapeHtml(name)}:\n«${escapeHtml(truncate(text, 300))}»\n\n↩️ ${escapeHtml(truncate(reply, 1500))}`,
      );
    }
    return 'ok';
  }

  return { answerOwner, respondOwner, retryLast, replyError, answerGroup, draftStreamer, notifyOwnerOnce, quoteOf };
}
