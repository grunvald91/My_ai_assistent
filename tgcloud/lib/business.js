// business.js — ответы от имени владельца в его личных чатах (Telegram Business).
//
// Режим на каждый чат: off (молчим) · confirm (черновик владельцу, сам решает) · auto (отвечаю сам).
// По умолчанию для новых собеседников — off: без явного включения бот в чужих переписках не участвует.
// Состояния владельца: biz_edit:<id> (пришли свой текст ответа) · biz_rev:<id> (пришли правку к черновику).

import { bizSystem } from './persona.js';
import { entitiesToHtml } from './format.js';
import { BIZ_MODES } from './config.js';
import { LlmError } from './llm.js';
import { LimitError } from './core.js';
import { displayName, escapeHtml, truncate, uid, safeJson } from './util.js';

const MODE_LABEL = { off: 'выкл', confirm: 'с подтверждением', auto: 'автоматически' };
const OWNER_MARK = '__owner'; // имя автора у сообщений, которые владелец написал сам
const QUIET_AFTER_OWNER_SEC = 600; // после ручного сообщения владельца авто-режим молчит

const kb = (rows) => ({ inline_keyboard: rows });

/** Текст входящего сообщения; real=false — это вложение без подписи (отвечать не на что). */
export function textOf(msg) {
  const t = msg.text ?? msg.caption;
  if (t && t.trim()) return { text: t.trim(), real: true };
  const kind = msg.photo ? 'фото' : msg.voice ? 'голосовое' : msg.video ? 'видео' : msg.video_note ? 'кружок' : msg.document ? 'файл' : msg.sticker ? 'стикер' : msg.audio ? 'аудио' : 'вложение';
  return { text: `[${kind}]`, real: false };
}

export function createBusiness(D) {
  const { store, out, core, cfg } = D;
  const key = (chatId) => 'b:' + chatId;

  async function defaultMode() {
    const v = await core.setting('biz_default');
    return BIZ_MODES.includes(v) ? v : 'off';
  }
  const modeOf = async (bizChat) => (bizChat?.mode && BIZ_MODES.includes(bizChat.mode) ? bizChat.mode : await defaultMode());

  // ───────── подключение аккаунта ─────────

  async function onConnection(bc) {
    if (!D.isOwner(bc.user?.id)) {
      await D.log('biz_foreign_connection', bc.user?.id ?? null, {});
      return;
    }
    const canReply = !!(bc.rights?.can_reply ?? bc.can_reply);
    const enabled = bc.is_enabled !== false;
    await store.upsertBizConnection({ id: bc.id, userId: bc.user.id, userChatId: bc.user_chat_id, canReply, enabled }, D.now());
    await D.log('biz_connection', bc.user.id, { enabled, canReply });
    if (!enabled) {
      await out.toOwner('🔌 Business-подключение отключено. Ответы от твоего имени остановлены.');
    } else if (!canReply) {
      await out.toOwner(
        '🔗 Business-аккаунт подключён, но без права «Отвечать на сообщения». Включи его: Настройки Telegram → Business → Чат-боты → этот бот → «Отвечать на сообщения».',
      );
    } else {
      await out.toOwner(
        '🔗 Business-аккаунт подключён. Пока ответы <b>выключены</b> во всех чатах — я ничего не отправлю без твоего решения.\n\n/business — включить: «с подтверждением» (черновик тебе в личку) или «автоматически».',
      );
    }
  }

  // ───────── входящие business_message ─────────

  async function onMessage(msg) {
    const conn = await store.getBizConnection(msg.business_connection_id);
    if (!conn || !conn.enabled) return;
    const chatId = msg.chat.id;
    const k = key(chatId);
    const fromOwner = msg.from?.id === conn.userId;
    const bizChat = await store.getBizChat(chatId);

    if (fromOwner) {
      // владелец ответил сам: учитываем для контекста, только если в этом чате я работаю
      if (bizChat && (await modeOf(bizChat)) !== 'off') {
        const { text, real } = textOf(msg);
        if (real) await store.addMessage({ chatKey: k, role: 'assistant', name: OWNER_MARK, text, ts: D.now() });
      }
      return;
    }

    const contactName = displayName(msg.chat);
    const fresh = await store.touchBizChat({ chatId, connId: conn.id, contactName }, D.now());
    const mode = await modeOf(fresh);
    if (mode === 'off') return;

    const { text, real } = textOf(msg);
    await store.addMessage({ chatKey: k, role: 'user', name: contactName, text, ts: D.now() });
    await store.trimMessages(k, 60);
    if (!real) return;
    if (await core.paused()) return;

    if (mode === 'auto') return autoReply(conn, chatId, contactName);
    return proposeReply(conn, chatId, contactName, text);
  }

  async function compose({ chatId, contactName, auto, note, prev }) {
    const memories = await core.memoryTexts(['biz']);
    let system = bizSystem({ ownerName: await core.ownerName(), contactName, memories, auto, nowSec: D.now(), tz: core.tz() });
    if (note) system += `\n\nПРАВКА ВЛАДЕЛЬЦА к предыдущему варианту ответа. Предыдущий вариант:\n${prev}\nЧто изменить: ${note}\nНапиши новый вариант.`;
    const messages = await core.contextFor({ key: key(chatId), chat: { summary: null, summaryUpto: 0 }, system });
    const res = await core.generate({ model: await core.ownerModel(), messages, maxTokens: cfg.maxTokensGroup });
    return res.text.trim();
  }

  async function autoReply(conn, chatId, contactName) {
    if (!conn.canReply) {
      const r = await store.hit('biz_noreply', Math.floor(D.now() / 86400), 1);
      if (r.allowed) await out.toOwner('⚠️ Автоответ невозможен: у бота нет права «Отвечать на сообщения». Включи его: Настройки Telegram → Business → Чат-боты.');
      return;
    }
    const hist = await store.getHistory(key(chatId), 0, 2);
    const prevMsg = hist.length >= 2 ? hist[hist.length - 2] : null;
    if (prevMsg && prevMsg.name === OWNER_MARK && D.now() - prevMsg.ts < QUIET_AFTER_OWNER_SEC) {
      await D.log('biz_quiet', chatId, {}); // владелец сам в диалоге — не мешаем
      return;
    }
    const cap = await store.hit('biz:' + chatId, Math.floor(D.now() / 3600), cfg.bizHourlyCap);
    if (!cap.allowed) {
      await D.log('biz_cap', chatId, {});
      return;
    }
    await out.typing(chatId, { bizConn: conn.id });
    let text;
    try {
      text = await compose({ chatId, contactName, auto: true });
    } catch (e) {
      if (e instanceof LlmError || e instanceof LimitError) return D.notifyOwnerOnce(e);
      throw e;
    }
    if (!text) return;
    try {
      await out.sendText({ chatId, text, bizConn: conn.id });
    } catch (e) {
      await D.log('biz_send_error', chatId, { error: String(e?.description ?? e?.message ?? e).slice(0, 200) });
      await out.toOwner(`⚠️ Не смог отправить автоответ для ${escapeHtml(contactName)}: ${escapeHtml(String(e?.description ?? e?.message ?? e))}`);
      return;
    }
    await store.addMessage({ chatKey: key(chatId), role: 'assistant', text, ts: D.now() });
    await D.log('biz_auto', chatId, { chars: text.length });
  }

  // ───────── режим «с подтверждением» ─────────

  const cardKeyboard = (id) =>
    kb([
      [{ text: '✅ Отправить', callback_data: 'b:s:' + id, style: 'success' }],
      [{ text: '✏️ Свой текст', callback_data: 'b:e:' + id }, { text: '🔁 Переделать', callback_data: 'b:r:' + id }],
      [{ text: '⏭ Пропустить', callback_data: 'b:x:' + id }],
    ]);

  const cardText = (d, inText) =>
    `💼 <b>${escapeHtml(d.contactName ?? 'Собеседник')}</b> пишет:\n«${escapeHtml(truncate(inText ?? d.inText ?? '', 600))}»\n\n✍️ <b>Черновик ответа от тебя:</b>\n${escapeHtml(truncate(d.text ?? '', 2800))}`;

  async function proposeReply(conn, chatId, contactName, inText) {
    await out.typing(chatId, { bizConn: conn.id });
    let text;
    try {
      text = await compose({ chatId, contactName, auto: false });
    } catch (e) {
      if (e instanceof LlmError || e instanceof LimitError) return D.notifyOwnerOnce(e);
      throw e;
    }
    if (!text) return;
    const id = uid();
    const d = { id, chatId, connId: conn.id, contactName, inText: truncate(inText, 1500), text, status: 'pending', createdAt: D.now() };
    await store.createBizDraft(d);
    await out.toOwner(cardText(d), { reply_markup: cardKeyboard(id) });
    await D.log('biz_draft', chatId, { id });
  }

  async function sendDraftNow(d, ownerCardChat, cardMsgId, { html } = {}) {
    if (!(await store.claimBizDraft(d.id, ['pending', 'editing'], 'sent'))) return { ok: false, why: 'уже обработан' };
    try {
      await out.sendText({ chatId: d.chatId, ...(html ? { html } : { text: d.text }), bizConn: d.connId });
    } catch (e) {
      await store.updateBizDraft(d.id, { status: 'pending' });
      return { ok: false, why: String(e?.description ?? e?.message ?? e) };
    }
    await store.addMessage({ chatKey: key(d.chatId), role: 'assistant', text: d.text, ts: D.now() });
    await D.log('biz_sent', d.chatId, { id: d.id });
    if (cardMsgId) {
      await out.editHtml(ownerCardChat, cardMsgId, cardText(d) + '\n\n✅ <b>Отправлено.</b>', null).catch(() => {});
    }
    return { ok: true };
  }

  /** Кнопки b:* */
  async function callback(cq, parts) {
    const [act, a, b] = parts;
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;

    if (act === 'd') {
      if (!BIZ_MODES.includes(a)) return out.answerCb(cq.id);
      await store.setSetting('biz_default', a);
      await out.answerCb(cq.id, 'Режим по умолчанию: ' + MODE_LABEL[a]);
      return showSettings(chatId, msgId);
    }
    if (act === 'c') {
      // цикл режима чата: по умолчанию → выкл → с подтверждением → авто → по умолчанию
      const cid = Number(a);
      const bc = await store.getBizChat(cid);
      if (!bc) return out.answerCb(cq.id, 'Чат не найден', true);
      const order = [null, 'off', 'confirm', 'auto'];
      const next = order[(order.indexOf(bc.mode ?? null) + 1) % order.length];
      await store.setBizMode(cid, next, D.now());
      await out.answerCb(cq.id, next ? MODE_LABEL[next] : 'как по умолчанию');
      return showSettings(chatId, msgId);
    }
    if (act === 'o') {
      // быстрое включение режима чата: b:o:<chatId>:<mode>
      const cid = Number(a);
      if (!BIZ_MODES.includes(b)) return out.answerCb(cq.id);
      await store.setBizMode(cid, b, D.now());
      await out.answerCb(cq.id, MODE_LABEL[b]);
      return;
    }

    const d = await store.getBizDraft(a);
    if (!d) return out.answerCb(cq.id, 'Черновик не найден', true);
    if (d.status === 'sent') return out.answerCb(cq.id, 'Уже отправлено', true);
    if (d.status === 'skipped') return out.answerCb(cq.id, 'Уже пропущено', true);

    if (act === 's') {
      const r = await sendDraftNow(d, chatId, msgId);
      if (r.ok) return out.answerCb(cq.id, 'Отправлено');
      await out.answerCb(cq.id, r.why === 'уже обработан' ? 'Уже обработано' : 'Не отправилось', true);
      if (r.why !== 'уже обработан') await out.sendHtml(chatId, `❌ Не удалось отправить: ${escapeHtml(r.why)}\nПроверь в настройках Business, что у бота есть право отвечать.`);
    } else if (act === 'x') {
      await store.updateBizDraft(d.id, { status: 'skipped' });
      await out.answerCb(cq.id, 'Пропущено');
      await out.editHtml(chatId, msgId, cardText(d) + '\n\n⏭ <i>Пропущено.</i>', null);
      const chat = await store.getChat(chatId);
      if (chat?.state?.endsWith(':' + d.id)) await store.setState(chatId, null);
    } else if (act === 'e') {
      await store.updateBizDraft(d.id, { status: 'editing' });
      await store.setState(chatId, 'biz_edit:' + d.id, { card: msgId });
      await out.answerCb(cq.id);
      await out.ask(chatId, `✏️ Пришли текст ответа для «${escapeHtml(d.contactName ?? '')}» — отправлю его как есть, форматирование сохраню. /cancel — отмена.`);
    } else if (act === 'r') {
      await store.setState(chatId, 'biz_rev:' + d.id, { card: msgId });
      await out.answerCb(cq.id);
      await out.ask(chatId, '🔁 Что поменять в ответе? Например: «короче», «на ты», «назови цену 5000». /cancel — отмена.');
    }
  }

  /** Состояния biz_edit / biz_rev. true — обработано. */
  async function onState(msg, chat) {
    const st = chat.state ?? '';
    const chatId = chat.chatId;
    const text = msg.text ?? msg.caption ?? '';
    if (!text.trim()) return false;
    const data = safeJson(chat.stateData, {}) || {};

    if (st.startsWith('biz_edit:')) {
      const d = await store.getBizDraft(st.slice('biz_edit:'.length));
      await store.setState(chatId, null);
      if (!d) return false;
      const html = entitiesToHtml(text, msg.entities ?? msg.caption_entities);
      const r = await sendDraftNow({ ...d, text }, chatId, data.card, { html });
      if (r.ok) await out.sendHtml(chatId, '✅ Отправил.');
      else await out.sendHtml(chatId, r.why === 'уже обработан' ? 'Этот ответ уже обработан.' : `❌ Не удалось отправить: ${escapeHtml(r.why)}`);
      return true;
    }
    if (st.startsWith('biz_rev:')) {
      const d = await store.getBizDraft(st.slice('biz_rev:'.length));
      await store.setState(chatId, null);
      if (!d || d.status === 'sent' || d.status === 'skipped') return false;
      let fresh;
      try {
        fresh = await compose({ chatId: d.chatId, contactName: d.contactName, auto: false, note: text, prev: d.text });
      } catch (e) {
        if (e instanceof LlmError || e instanceof LimitError) {
          await out.sendHtml(chatId, escapeHtml(e.userMessage));
          return true;
        }
        throw e;
      }
      if (!fresh) return true;
      await store.updateBizDraft(d.id, { text: fresh, status: 'pending' });
      const nd = { ...d, text: fresh };
      if (data.card) {
        try {
          await out.editHtml(chatId, data.card, cardText(nd), cardKeyboard(d.id));
          return true;
        } catch {
          /* карточку не обновить — пришлём новую */
        }
      }
      await out.sendHtml(chatId, cardText(nd), { reply_markup: cardKeyboard(d.id) });
      return true;
    }
    return false;
  }

  // ───────── /business ─────────

  async function showSettings(chatId, editMsgId) {
    const conns = await store.listBizConnections();
    const active = conns.filter((c) => c.enabled);
    const def = await defaultMode();
    const chats = await store.listBizChats(8);

    let html = '💼 <b>Ответы от моего имени (Telegram Business)</b>\n\n';
    if (!active.length) {
      html +=
        'Аккаунт не подключён. Как подключить: Настройки Telegram → <b>Business</b> → <b>Чат-боты</b> → выбери этого бота и дай право «Отвечать на сообщения». (Нужен Telegram Premium.)\n\n';
    } else {
      html += `Подключение: ✅${active.some((c) => !c.canReply) ? ' (но без права отвечать — включи его в настройках Business)' : ''}\n\n`;
    }
    html +=
      '<b>Режимы</b>\n• выкл — молчу, ничего не читаю и не храню\n• с подтверждением — присылаю тебе черновик, ты жмёшь «Отправить»\n• автоматически — отвечаю сам (не чаще ' +
      cfg.bizHourlyCap +
      ' раз в час на чат; если ты сам вмешался в диалог — молчу 10 минут)\n\n' +
      `По умолчанию для новых собеседников: <b>${MODE_LABEL[def]}</b>.`;
    if (chats.length) html += '\n\nНажми на чат, чтобы переключить его режим по кругу (по умолч. → выкл → подтв. → авто):';
    else html += '\n\nЧаты появятся здесь, когда кто-то напишет тебе в личку.';

    const rows = [
      BIZ_MODES.map((m) => ({ text: (m === def ? '● ' : '') + MODE_LABEL[m], callback_data: 'b:d:' + m })),
    ];
    for (const c of chats) {
      const eff = c.mode ? MODE_LABEL[c.mode] : `по умолч. (${MODE_LABEL[def]})`;
      rows.push([{ text: truncate(`${c.contactName ?? c.chatId} · ${eff}`, 60), callback_data: 'b:c:' + c.chatId }]);
    }
    const markup = kb(rows);
    if (editMsgId) {
      try {
        await out.editHtml(chatId, editMsgId, html, markup);
        return;
      } catch {
        /* упало — пришлём заново */
      }
    }
    await out.sendHtml(chatId, html, { reply_markup: markup });
  }

  return { onConnection, onMessage, onState, callback, showSettings, modeOf };
}
