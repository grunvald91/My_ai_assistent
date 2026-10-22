// replies.js — «ответь в группе за меня»: владелец в группе отвечает командой /draft на чужое сообщение,
// бот готовит черновик и присылает его в личку; по кнопке реплика уходит в группу.
// Состояние владельца: draft_rev:<id> (пришли правку к черновику).

import { replyDraftSystem } from './persona.js';
import { LlmError } from './llm.js';
import { LimitError } from './core.js';
import { displayName, escapeHtml, truncate, uid, safeJson } from './util.js';

const kb = (rows) => ({ inline_keyboard: rows });

export function createReplies(D) {
  const { store, out, core, cfg } = D;

  const cardText = (d, title, target) =>
    `🗨 <b>Черновик ответа в «${escapeHtml(title)}»</b>` +
    (d.rev > 1 ? ` · вариант ${d.rev}` : '') +
    (target ? `\n↪️ на: «${escapeHtml(truncate(target, 300))}»` : '') +
    `\n\n${escapeHtml(truncate(d.text ?? '', 3000))}`;

  const keyboard = (id) =>
    kb([
      [{ text: '📤 Отправить в группу', callback_data: 'd:s:' + id, style: 'success' }],
      [{ text: '🔁 Переделать', callback_data: 'd:r:' + id }, { text: '🗑 Отмена', callback_data: 'd:x:' + id, style: 'danger' }],
    ]);

  async function compose({ groupChatId, title, quote, quoteAuthor, instruction, prev }) {
    const memories = await core.memoryTexts(['group:' + groupChatId]);
    const system = replyDraftSystem({ ownerName: await core.ownerName(), groupTitle: title, memories, nowSec: D.now(), tz: core.tz() });
    const chat = { summary: null, summaryUpto: 0 };
    const base = await core.contextFor({ key: String(groupChatId), chat, system });
    let ask = `Сообщение, на которое нужно ответить (${quoteAuthor}): «${quote}»`;
    if (prev) ask += `\n\nПредыдущий вариант ответа:\n${prev}\n\nПравка владельца: ${instruction}\nНапиши новый вариант.`;
    else if (instruction) ask += `\n\nУказание владельца, как ответить: ${instruction}`;
    const res = await core.generate({
      model: await core.ownerModel(),
      messages: [...base, { role: 'user', content: ask }],
      maxTokens: cfg.maxTokensGroup,
    });
    return res.text.trim();
  }

  /** /draft [указание] — ответом на сообщение в группе. */
  async function start(msg, chat, arg) {
    const groupId = msg.chat.id;
    const target = msg.reply_to_message;
    const quote = target && (target.text ?? target.caption);
    if (!target || !quote) {
      await out.sendText({
        chatId: groupId,
        text: 'Чтобы я подготовил ответ за тебя: ответь командой /draft на нужное сообщение (можно добавить указание: «/draft согласись, но не раньше пятницы»).',
        replyTo: msg.message_id,
        threadId: msg.is_topic_message ? msg.message_thread_id : undefined,
      });
      return;
    }
    const title = chat.title ?? msg.chat.title ?? 'группа';
    const author = displayName(target.from);
    let text;
    try {
      text = await compose({ groupChatId: groupId, title, quote, quoteAuthor: author, instruction: arg });
    } catch (e) {
      if (e instanceof LlmError || e instanceof LimitError) {
        await out.toOwner(escapeHtml(e.userMessage));
        return;
      }
      throw e;
    }
    if (!text) return;
    const id = uid();
    const d = {
      id,
      kind: 'reply',
      targetChatId: groupId,
      replyToMessageId: target.message_id,
      threadId: msg.is_topic_message ? msg.message_thread_id : null,
      brief: arg || null,
      text,
      format: 'md',
      status: 'ready',
      rev: 1,
      previewMessageId: null,
      createdAt: D.now(),
    };
    await store.createDraft(d);
    // сохраняем цитируемое сообщение, чтобы «Переделать» работало без группы под рукой
    await store.setSetting('draftq:' + id, JSON.stringify({ q: quote, a: author, t: title }));
    const sent = await out.toOwner(cardText(d, title, quote), { reply_markup: keyboard(id) });
    if (!sent) {
      await out.sendText({
        chatId: groupId,
        text: 'Не могу прислать тебе черновик: открой личный чат со мной и нажми Start, потом повтори /draft.',
        replyTo: msg.message_id,
        threadId: d.threadId ?? undefined,
      });
      return;
    }
    await D.log('reply_draft', groupId, { id });
  }

  async function quoteOf(id) {
    return safeJson(await store.getSetting('draftq:' + id), { q: '', a: '', t: 'группа' });
  }

  async function callback(cq, parts) {
    const [act, id] = parts;
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;
    const d = await store.getDraft(id);
    if (!d || d.kind !== 'reply') return out.answerCb(cq.id, 'Черновик не найден', true);
    if (d.status === 'published') return out.answerCb(cq.id, 'Уже отправлено', true);
    if (d.status === 'canceled') return out.answerCb(cq.id, 'Уже отменено', true);
    const meta = await quoteOf(id);

    if (act === 's') {
      if (!(await store.claimDraft(id, 'ready', 'publishing'))) return out.answerCb(cq.id, 'Уже обрабатывается', true);
      try {
        const sent = await out.sendText({
          chatId: d.targetChatId,
          text: d.text,
          replyTo: d.replyToMessageId ?? undefined,
          threadId: d.threadId ?? undefined,
        });
        await store.updateDraft(id, { status: 'published', publishedMessageId: sent[0]?.message_id ?? null, publishedAt: D.now() });
      } catch (e) {
        await store.updateDraft(id, { status: 'ready' });
        await out.answerCb(cq.id, 'Не отправилось', true);
        await out.sendHtml(chatId, `❌ Не получилось отправить в группу: ${escapeHtml(String(e?.description ?? e?.message ?? e))}`);
        return;
      }
      await store.addMessage({ chatKey: String(d.targetChatId), role: 'assistant', text: d.text, ts: D.now() });
      await out.answerCb(cq.id, 'Отправлено');
      await out.editHtml(chatId, msgId, cardText(d, meta.t, meta.q) + '\n\n✅ <b>Отправлено в группу.</b>', null);
      await D.log('reply_sent', d.targetChatId, { id });
    } else if (act === 'x') {
      await store.updateDraft(id, { status: 'canceled' });
      await out.answerCb(cq.id, 'Отменено');
      await out.editHtml(chatId, msgId, cardText(d, meta.t, meta.q) + '\n\n🗑 <i>Отменено.</i>', null);
    } else if (act === 'r') {
      await store.setState(chatId, 'draft_rev:' + id, { card: msgId });
      await out.answerCb(cq.id);
      await out.ask(chatId, '🔁 Что поменять в ответе? Например: «короче», «жёстче», «предложи созвон в четверг». /cancel — отмена.');
    }
  }

  /** Состояние draft_rev. true — обработано. */
  async function onState(msg, chat) {
    const st = chat.state ?? '';
    if (!st.startsWith('draft_rev:')) return false;
    const text = (msg.text ?? '').trim();
    if (!text) return false;
    const chatId = chat.chatId;
    const id = st.slice('draft_rev:'.length);
    const data = safeJson(chat.stateData, {}) || {};
    await store.setState(chatId, null);
    const d = await store.getDraft(id);
    if (!d || d.status !== 'ready') return false;
    const meta = await quoteOf(id);
    let fresh;
    try {
      fresh = await compose({ groupChatId: d.targetChatId, title: meta.t, quote: meta.q, quoteAuthor: meta.a, instruction: text, prev: d.text });
    } catch (e) {
      if (e instanceof LlmError || e instanceof LimitError) {
        await out.sendHtml(chatId, escapeHtml(e.userMessage));
        return true;
      }
      throw e;
    }
    if (!fresh) return true;
    const nd = { ...d, text: fresh, rev: (d.rev ?? 1) + 1 };
    await store.updateDraft(id, { text: fresh, rev: nd.rev });
    if (data.card) {
      try {
        await out.editHtml(chatId, data.card, cardText(nd, meta.t, meta.q), keyboard(id));
        return true;
      } catch {
        /* карточку не обновить — пришлём новую */
      }
    }
    await out.sendHtml(chatId, cardText(nd, meta.t, meta.q), { reply_markup: keyboard(id) });
    return true;
  }

  return { start, callback, onState };
}
