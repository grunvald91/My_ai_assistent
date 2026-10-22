// posts.js — посты в каналы владельца: фото + задание → черновик в стиле канала → кнопки
// «Опубликовать / Переделать / Вручную / Отмена» → публикация. Плюс каналы и их стиль (память ур. 4).
//
// Состояния диалога (chats.state): post_brief:<id> · post_rev:<id> · post_manual:<id> · style:<chId> · example:<chId>

import { postSystem } from './persona.js';
import { renderChunks, entitiesToHtml, mdToHtml } from './format.js';
import { htmlToPlain } from './out.js';
import { TG_CAPTION_LIMIT } from './config.js';
import { escapeHtml, truncate, uid } from './util.js';
import { LlmError } from './llm.js';
import { LimitError } from './core.js';

const isParseError = (e) => e?.code === 400 && /parse|entit|can't find end|unsupported start tag|unclosed/i.test(e.description ?? '');

const kb = (rows) => ({ inline_keyboard: rows });
const chName = (c) => c.title || (c.username ? '@' + c.username : 'канал ' + c.chatId);

export function createPosts(D) {
  const { store, out, core, cfg } = D;
  const ownerChat = () => D.ownerId;

  // Отправки поста считаем: если публикация упала, нужно знать, ушла ли уже хоть одна часть (тогда исход неизвестен)
  let tracker = null;
  async function tgSend(method, params) {
    const r = await out.call(method, params);
    if (tracker) tracker.sent++;
    return r;
  }

  // ───────── текст черновика → что отправлять ─────────

  function htmlOf(draft) {
    return draft.format === 'html' ? draft.text : mdToHtml(draft.text);
  }
  function plainOf(draft) {
    return draft.format === 'html' ? htmlToPlain(draft.text) : draft.text;
  }
  function bodyChunks(draft) {
    if (draft.format === 'html') return [{ html: draft.text.slice(0, 4096), md: htmlToPlain(draft.text).slice(0, 4096) }];
    return renderChunks(draft.text);
  }

  async function sendBody(chatId, draft, markup) {
    const chunks = bodyChunks(draft);
    const sent = [];
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const p = { chat_id: chatId, link_preview_options: { is_disabled: true } };
      if (last && markup) p.reply_markup = markup;
      try {
        sent.push(await tgSend('sendMessage', { ...p, text: chunks[i].html, parse_mode: 'HTML' }));
      } catch (e) {
        if (!isParseError(e)) throw e;
        sent.push(await tgSend('sendMessage', { ...p, text: truncate(chunks[i].md, 4096, '') }));
      }
    }
    return sent;
  }

  async function sendPhotoWithCaption(chatId, fileId, draft, markup) {
    const p = { chat_id: chatId, photo: fileId };
    if (markup) p.reply_markup = markup;
    try {
      return await tgSend('sendPhoto', { ...p, caption: htmlOf(draft), parse_mode: 'HTML' });
    } catch (e) {
      if (!isParseError(e)) throw e;
      return tgSend('sendPhoto', { ...p, caption: truncate(plainOf(draft), TG_CAPTION_LIMIT, '') });
    }
  }

  /**
   * Отправляет пост в чат: превью владельцу (с кнопками) или публикация в канал (markup = null).
   * Одна и та же функция для обоих случаев — превью точно совпадает с итогом.
   * Возвращает { first, control }: id первого сообщения поста и сообщения с кнопками.
   */
  async function deliver(draft, photos, chatId, markup) {
    const captionOk = photos.length > 0 && plainOf(draft).length <= TG_CAPTION_LIMIT;

    if (!photos.length) {
      const sent = await sendBody(chatId, draft, markup);
      return { first: sent[0].message_id, control: sent[sent.length - 1].message_id };
    }

    if (photos.length === 1) {
      if (captionOk) {
        const m = await sendPhotoWithCaption(chatId, photos[0], draft, markup);
        return { first: m.message_id, control: m.message_id };
      }
      const ph = await tgSend('sendPhoto', { chat_id: chatId, photo: photos[0] });
      const sent = await sendBody(chatId, draft, markup);
      return { first: ph.message_id, control: sent[sent.length - 1].message_id };
    }

    // альбом: подпись у первого фото
    const media = photos.map((id, i) => {
      const it = { type: 'photo', media: id };
      if (i === 0 && captionOk) {
        it.caption = htmlOf(draft);
        it.parse_mode = 'HTML';
      }
      return it;
    });
    let msgs;
    try {
      msgs = await tgSend('sendMediaGroup', { chat_id: chatId, media });
    } catch (e) {
      if (!isParseError(e)) throw e;
      media[0] = { type: 'photo', media: photos[0], ...(captionOk ? { caption: truncate(plainOf(draft), TG_CAPTION_LIMIT, '') } : {}) };
      msgs = await tgSend('sendMediaGroup', { chat_id: chatId, media });
    }
    const first = msgs[0].message_id;
    if (!captionOk) {
      const sent = await sendBody(chatId, draft, markup);
      return { first, control: sent[sent.length - 1].message_id };
    }
    if (markup) {
      const c = await out.sendHtml(chatId, '☝️ Так будет выглядеть пост.', { reply_markup: markup });
      return { first, control: c.message_id };
    }
    return { first, control: first };
  }

  // ───────── каналы ─────────

  const channelKeyboard = (c) =>
    kb([[
      { text: '✏️ Стиль', callback_data: 'c:st:' + c.id },
      { text: '📌 Пример поста', callback_data: 'c:ex:' + c.id },
      { text: '🗑 Убрать', callback_data: 'c:rm:' + c.id },
    ]]);

  async function showChannels(chatId) {
    const list = await store.listChannels();
    if (!list.length) {
      await out.sendHtml(
        chatId,
        '📣 Каналов пока нет.\n\nЧтобы подключить канал: добавь меня в него администратором с правом «Публиковать сообщения» — я увижу это сам и напишу тебе.',
      );
      return;
    }
    for (const c of list) {
      const ex = (c.examples || []).length;
      await out.sendHtml(
        chatId,
        `📣 <b>${escapeHtml(chName(c))}</b>${c.username ? ' (@' + escapeHtml(c.username) + ')' : ''}\n` +
          `Стиль: ${c.style ? '<i>' + escapeHtml(truncate(c.style, 300)) + '</i>' : 'не задан (пишу нейтрально и живо)'}\n` +
          `Примеров постов: ${ex}/3`,
        { reply_markup: channelKeyboard(c) },
      );
    }
    await out.sendHtml(chatId, 'Новый канал подключается так: добавь меня в него админом с правом публикации.');
  }

  /** Бота сделали админом канала / убрали (my_chat_member). */
  async function onChannelMembership(upd) {
    const chat = upd.chat;
    const st = upd.new_chat_member?.status;
    if (st === 'administrator') {
      if (upd.new_chat_member.can_post_messages === false) {
        await out.toOwner(`⚠️ Я админ канала «${escapeHtml(chat.title ?? '')}», но без права «Публиковать сообщения». Включи его в правах администратора.`);
      }
      const ch = await store.upsertChannel({ chatId: chat.id, title: chat.title, username: chat.username }, D.now());
      await out.toOwner(
        `📣 Подключил канал <b>${escapeHtml(chName(ch))}</b>.\nЗадай стиль постов (/channels → «Стиль») или сразу присылай фото и описание — подготовлю пост.`,
      );
      await D.log('channel_added', chat.id, { title: chat.title });
    } else if (st === 'left' || st === 'kicked' || st === 'member') {
      await store.deactivateChannelByChat(chat.id);
      await out.toOwner(`📣 Канал «${escapeHtml(chat.title ?? '')}» отключён: у меня больше нет прав админа.`);
    }
  }

  async function channelCallback(cq, parts) {
    const [act, idStr] = parts;
    const id = Number(idStr);
    const ch = await store.getChannel(id);
    if (!ch) return out.answerCb(cq.id, 'Канал не найден');
    const chatId = cq.message.chat.id;
    if (act === 'st') {
      await store.setState(chatId, 'style:' + id);
      await out.answerCb(cq.id);
      await out.ask(chatId, `✏️ Опиши стиль канала «${escapeHtml(chName(ch))}» одним сообщением: тон, длина, эмодзи, хэштеги, подпись. /cancel — отмена.`);
    } else if (act === 'ex') {
      await store.setState(chatId, 'example:' + id);
      await out.answerCb(cq.id);
      await out.ask(chatId, `📌 Пришли текст удачного поста канала «${escapeHtml(chName(ch))}» — буду ориентироваться на его тон (хранится до 3 примеров). /cancel — отмена.`);
    } else if (act === 'rm') {
      await store.deactivateChannelByChat(ch.chatId);
      await out.answerCb(cq.id, 'Канал убран из списка');
      await out.editHtml(chatId, cq.message.message_id, `🗑 Канал «${escapeHtml(chName(ch))}» убран. Вернуть: добавь меня админом ещё раз.`, null);
    }
  }

  // ───────── создание поста ─────────

  async function startPost(chat, arg) {
    const chatId = chat.chatId;
    const list = await store.listChannels();
    if (!list.length) return showChannels(chatId);
    let channel = null;
    if (arg) {
      const q = arg.toLowerCase().replace(/^@/, '');
      channel = list.find((c) => (c.title ?? '').toLowerCase().includes(q) || (c.username ?? '').toLowerCase() === q) ?? null;
      if (!channel) {
        await out.sendHtml(chatId, `Не нашёл канал «${escapeHtml(arg)}». Доступные: ${list.map((c) => escapeHtml(chName(c))).join(', ')}.`);
        return;
      }
    } else if (list.length === 1) {
      channel = list[0];
    }
    const id = uid();
    await store.createDraft({ id, kind: 'post', status: channel ? 'await_brief' : 'await_channel', channelId: channel?.id ?? null, createdAt: D.now() });
    if (!channel) return askChannel(chatId, id, list);
    await store.setState(chatId, 'post_brief:' + id);
    await out.ask(chatId, `📝 Канал «${escapeHtml(chName(channel))}». Пришли фото и/или описание поста: что анонсируем, ключевые факты, цена, призыв. /cancel — отмена.`);
  }

  async function askChannel(chatId, draftId, list) {
    await out.sendHtml(chatId, 'В какой канал пост?', {
      reply_markup: kb(list.map((c) => [{ text: chName(c), callback_data: `p:ch:${draftId}:${c.id}` }])),
    });
  }

  /** Владелец прислал фото (с подписью или без). Альбом = несколько апдейтов с общим media_group_id. */
  async function onPhoto(msg, chat) {
    const chatId = chat.chatId;
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const caption = (msg.caption ?? '').trim();

    let draftId = null;
    const st = chat.state ?? '';
    if (st.startsWith('post_brief:')) draftId = st.slice('post_brief:'.length);
    else if (msg.media_group_id) draftId = 'g' + msg.media_group_id;
    else draftId = uid();

    let draft = await store.getDraft(draftId);
    let created = false;
    if (!draft) {
      try {
        await store.createDraft({ id: draftId, kind: 'post', status: 'new', brief: caption || null, createdAt: D.now() });
        created = true;
      } catch {
        created = false; // параллельный апдейт того же альбома уже создал черновик
      }
      draft = await store.getDraft(draftId);
    }
    if (!draft) return;
    await store.addDraftPhoto(draftId, fileId, msg.message_id);

    const isAlbum = !!msg.media_group_id;
    if (caption) await store.updateDraft(draftId, { brief: caption });

    // Фото пришло, когда превью уже готово: в превью его нет
    if (!created && draft.status === 'ready') {
      const r = await store.hit('late:' + draftId, 1, 1);
      if (r.allowed) await out.sendHtml(chatId, '📸 Это фото пришло позже превью и в него не попало. Нажми «Переделать» — соберу пост заново со всеми фото.');
      return;
    }

    // Фото альбома приходят отдельными апдейтами (возможно, параллельно), и «момент, когда пришли все» узнать
    // нельзя — поэтому один раз просим подтвердить кнопкой.
    if (isAlbum) {
      const r = await store.hit('alb:' + draftId, 1, 1);
      if (r.allowed) {
        await out.sendHtml(chatId, '📸 Получаю альбом. Когда все фото загрузятся — нажми «Готово».', {
          reply_markup: kb([[{ text: '✅ Готово', callback_data: 'p:go:' + draftId }]]),
        });
      }
      return;
    }
    return advance(draftId, chatId);
  }

  /** Кнопка «Пост в канал» под отложенными фото: все фото — в один черновик, дальше обычный путь (канал → описание). */
  async function fromPhotos(chatId, fileIds, brief = '') {
    const draftId = uid();
    await store.createDraft({ id: draftId, kind: 'post', status: 'new', brief: brief || null, createdAt: D.now() });
    for (let i = 0; i < fileIds.length; i++) await store.addDraftPhoto(draftId, fileIds[i], i);
    return advance(draftId, chatId);
  }

  /** Фото собраны: определяем канал и описание, дальше — генерация. */
  async function advance(draftId, chatId) {
    const draft = await store.getDraft(draftId);
    if (!draft) return;
    const brief = draft.brief;

    // канал уже выбран (поток /post) → дальше сразу к тексту
    if (draft.channelId) {
      if (brief) return generatePost(draft, {});
      await store.setState(chatId, 'post_brief:' + draftId);
      await out.ask(chatId, '📸 Фото получил. Теперь пришли описание поста — что в нём сказать?');
      return;
    }

    const list = await store.listChannels();
    if (!list.length) {
      await store.updateDraft(draftId, { status: 'canceled' });
      return showChannels(chatId);
    }
    if (list.length === 1) {
      await store.updateDraft(draftId, { channelId: list[0].id, status: 'await_brief' });
      if (brief) return generatePost({ ...draft, channelId: list[0].id }, {});
      await store.setState(chatId, 'post_brief:' + draftId);
      await out.ask(chatId, `📸 Фото получил (канал «${escapeHtml(chName(list[0]))}»). Пришли описание поста — что в нём сказать?`);
      return;
    }
    await store.updateDraft(draftId, { status: 'await_channel' });
    await askChannel(chatId, draftId, list);
  }

  /** Состояния «ждём текст». true — сообщение обработано здесь. */
  async function onState(msg, chat) {
    const st = chat.state ?? '';
    const chatId = chat.chatId;
    const text = msg.text ?? msg.caption ?? '';
    if (!text.trim()) return false;

    if (st.startsWith('post_brief:')) {
      const id = st.slice('post_brief:'.length);
      const draft = await store.getDraft(id);
      if (!draft || !draft.channelId) {
        await store.setState(chatId, null);
        return false;
      }
      await store.updateDraft(id, { brief: text });
      await generatePost({ ...draft, brief: text }, {});
      return true;
    }
    if (st.startsWith('post_rev:')) {
      const id = st.slice('post_rev:'.length);
      const draft = await store.getDraft(id);
      if (!draft) {
        await store.setState(chatId, null);
        return false;
      }
      await generatePost(draft, { note: text });
      return true;
    }
    if (st.startsWith('post_manual:')) {
      const id = st.slice('post_manual:'.length);
      const draft = await store.getDraft(id);
      if (!draft) {
        await store.setState(chatId, null);
        return false;
      }
      await store.updateDraft(id, { text: entitiesToHtml(msg.text ?? msg.caption, msg.entities ?? msg.caption_entities), format: 'html', status: 'ready', rev: draft.rev + 1 });
      await store.setState(chatId, null);
      await sendPreview(id);
      return true;
    }
    if (st.startsWith('style:')) {
      const id = Number(st.slice('style:'.length));
      await store.updateChannel(id, { style: truncate(text, 1500, '') });
      await store.setState(chatId, null);
      await out.sendHtml(chatId, '✅ Стиль канала сохранён. Он будет учитываться в каждом посте.');
      return true;
    }
    if (st.startsWith('example:')) {
      const id = Number(st.slice('example:'.length));
      const ch = await store.getChannel(id);
      const examples = [...(ch?.examples ?? []), truncate(text, 1200, '')].slice(-3);
      await store.updateChannel(id, { examples });
      await store.setState(chatId, null);
      await out.sendHtml(chatId, `✅ Пример сохранён (${examples.length}/3).`);
      return true;
    }
    return false;
  }

  // ───────── генерация и превью ─────────

  async function generatePost(draft, { note } = {}) {
    const chatId = ownerChat();
    const channel = await store.getChannel(draft.channelId);
    if (!channel) {
      await out.sendHtml(chatId, 'Канал для поста не найден. Начни заново: /post');
      await store.setState(chatId, null);
      return;
    }
    const photos = await store.listDraftPhotos(draft.id);
    const system = postSystem({
      title: chName(channel),
      style: channel.style ?? '',
      examples: channel.examples ?? [],
      limit: photos.length ? 1000 : 3800,
      hasPhoto: photos.length > 0,
      nowSec: D.now(),
      tz: core.tz(),
    });
    const user = note
      ? `Задание:\n${draft.brief ?? ''}\n\nТекущий вариант поста:\n${plainOf(draft)}\n\nПравка владельца: ${note}\n\nПерепиши пост с учётом правки.`
      : `Задание:\n${draft.brief ?? ''}`;

    await out.typing(chatId);
    let res;
    try {
      res = await core.generate({
        model: await core.ownerModel(),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        maxTokens: cfg.maxTokensPost,
      });
    } catch (e) {
      if (!(e instanceof LlmError || e instanceof LimitError)) throw e;
      // состояние оставляем: владелец может прислать описание ещё раз
      await out.sendHtml(chatId, escapeHtml(e.userMessage) + '\n\nЧерновик сохранён — пришли описание ещё раз или /cancel.');
      if (!note) await store.setState(chatId, 'post_brief:' + draft.id);
      return;
    }
    await store.updateDraft(draft.id, { text: res.text.trim(), format: 'md', status: 'ready', rev: (draft.rev ?? 0) + 1 });
    await store.setState(chatId, null);
    await sendPreview(draft.id);
  }

  const previewKeyboard = (id) =>
    kb([
      [{ text: '📣 Опубликовать', callback_data: 'p:pub:' + id, style: 'success' }],
      [{ text: '🔁 Переделать', callback_data: 'p:rev:' + id }, { text: '✏️ Вручную', callback_data: 'p:man:' + id }],
      [{ text: '🗑 Отмена', callback_data: 'p:cx:' + id, style: 'danger' }],
    ]);

  async function sendPreview(draftId) {
    const draft = await store.getDraft(draftId);
    const channel = await store.getChannel(draft.channelId);
    const photos = (await store.listDraftPhotos(draftId)).map((p) => p.fileId);
    const chatId = ownerChat();
    const plainLen = plainOf(draft).length;
    let head = `✍️ Черновик для «${escapeHtml(chName(channel))}»` + (draft.rev > 1 ? ` · вариант ${draft.rev}` : '');
    if (photos.length === 1 && plainLen > TG_CAPTION_LIMIT) {
      head += `\n⚠️ Текст длиннее ${TG_CAPTION_LIMIT} символов — подпись к фото не влезет, уйдёт отдельным сообщением под фото.`;
    }
    await out.sendHtml(chatId, head);
    const res = await deliver(draft, photos, chatId, previewKeyboard(draftId));
    await store.updateDraft(draftId, { previewMessageId: res.control });
  }

  // ───────── кнопки под черновиком ─────────

  const linkOf = (ch, messageId) =>
    ch.username ? `https://t.me/${ch.username}/${messageId}` : String(ch.chatId).startsWith('-100') ? `https://t.me/c/${String(ch.chatId).slice(4)}/${messageId}` : null;

  const STALE_PUBLISH_SEC = 60; // публикация идёт секунды; дольше минуты — вызов бота, скорее всего, оборвали

  /** Исход публикации неизвестен: ничего не повторяем сами, спрашиваем владельца. */
  async function markMaybePosted(draftId, chatId, channel, partial) {
    await store.updateDraft(draftId, { status: 'maybe_posted' });
    await out.sendHtml(
      chatId,
      `⚠️ <b>Не уверен, вышел ли пост</b> в «${escapeHtml(chName(channel))}»: ${partial ? 'часть поста уже ушла, а дальше что-то оборвалось' : 'ответ Telegram потерялся'}. ` +
        'Если отправить ещё раз вслепую, получится дубль.\n\nЗагляни в канал и скажи, что там:',
      { reply_markup: kb([[{ text: '✅ Пост вышел', callback_data: 'p:ok:' + draftId, style: 'success' }], [{ text: '🔁 Поста нет — опубликовать', callback_data: 'p:re:' + draftId }]]) },
    );
  }

  async function publish(draftId, cq) {
    const chatId = cq.message.chat.id;
    const draft = await store.getDraft(draftId);
    if (!draft) return out.answerCb(cq.id, 'Черновик не найден', true);
    if (draft.status === 'publishing' && D.now() - (draft.publishedAt ?? 0) > STALE_PUBLISH_SEC) {
      // публикация началась давно и не закончилась: вызов бота оборвали на полпути
      await out.answerCb(cq.id);
      await out.dropButtons(chatId, cq.message.message_id);
      const ch = await store.getChannel(draft.channelId);
      return markMaybePosted(draftId, chatId, ch, false);
    }
    if (!(await store.claimDraft(draftId, 'ready', 'publishing'))) {
      const why = { published: 'Уже опубликовано', maybe_posted: 'Исход прошлой публикации неизвестен — ответь на вопрос выше', publishing: 'Публикуется, подожди' }[draft.status] ?? 'Сейчас нельзя опубликовать';
      return out.answerCb(cq.id, why, true);
    }
    await out.answerCb(cq.id, 'Публикую…');
    await store.updateDraft(draftId, { publishedAt: D.now() }); // время начала: по нему видно «зависшую» публикацию
    const channel = await store.getChannel(draft.channelId);
    const photos = (await store.listDraftPhotos(draftId)).map((p) => p.fileId);
    let res;
    tracker = { sent: 0 };
    try {
      res = await deliver(draft, photos, channel.chatId, null);
    } catch (e) {
      const sentSome = tracker.sent > 0;
      tracker = null;
      await D.log('post_error', channel.chatId, { error: String(e?.description ?? e?.message ?? e).slice(0, 200), sent: sentSome });
      // Telegram ответил отказом (4xx) и ничего не ушло — пост точно не вышел, можно нажать ещё раз.
      // Иначе (сеть, 5xx, оборванный ответ, часть уже ушла) исход неизвестен: повторять вслепую нельзя — будет дубль.
      const certain = !sentSome && Number.isInteger(e?.code) && e.code >= 400 && e.code < 500;
      if (certain) {
        await store.updateDraft(draftId, { status: 'ready' });
        await out.sendHtml(
          chatId,
          `❌ Не получилось опубликовать в «${escapeHtml(chName(channel))}»: ${escapeHtml(String(e?.description ?? e?.message ?? e))}\nПроверь, что я админ канала с правом «Публиковать сообщения». Потом нажми «Опубликовать» ещё раз.`,
        );
      } else {
        await markMaybePosted(draftId, chatId, channel, sentSome);
      }
      return;
    }
    tracker = null;
    const link = linkOf(channel, res.first);
    await store.updateDraft(draftId, { status: 'published', publishedMessageId: res.first, link, publishedAt: D.now() });
    await out.dropButtons(chatId, cq.message.message_id);
    const chat = await store.getChat(chatId);
    if (chat?.state?.endsWith(':' + draftId)) await store.setState(chatId, null);
    await D.log('post_published', channel.chatId, { draft: draftId, message: res.first });
    await out.sendHtml(chatId, `✅ Опубликовано в «${escapeHtml(chName(channel))}»${link ? ': ' + escapeHtml(link) : '.'}`);
  }

  async function postCallback(cq, parts) {
    const [act, id, extra] = parts;
    const chatId = cq.message.chat.id;
    if (act === 'ch') {
      const draft = await store.getDraft(id);
      const ch = await store.getChannel(Number(extra));
      if (!draft || !ch) return out.answerCb(cq.id, 'Не нашёл', true);
      await store.updateDraft(id, { channelId: ch.id, status: 'await_brief' });
      await out.answerCb(cq.id);
      await out.editHtml(chatId, cq.message.message_id, `📣 Канал: <b>${escapeHtml(chName(ch))}</b>`, null);
      if (draft.brief) return generatePost({ ...draft, channelId: ch.id }, {});
      await store.setState(chatId, 'post_brief:' + id);
      await out.ask(chatId, 'Теперь пришли описание поста — что в нём сказать? /cancel — отмена.');
      return;
    }
    const draft = await store.getDraft(id);
    if (!draft) return out.answerCb(cq.id, 'Черновик не найден', true);
    if (act === 'go') {
      if (['ready', 'publishing', 'maybe_posted', 'published', 'canceled'].includes(draft.status)) return out.answerCb(cq.id, 'Уже обработано', true);
      await out.answerCb(cq.id);
      await out.dropButtons(chatId, cq.message.message_id);
      return advance(id, chatId);
    }
    if (act === 'pub') return publish(id, cq);
    if (act === 'ok' || act === 're') {
      // ответ владельца на «не уверен, вышел ли пост»
      if (draft.status !== 'maybe_posted') return out.answerCb(cq.id, 'Уже решено', true);
      await out.dropButtons(chatId, cq.message.message_id);
      if (act === 'ok') {
        await store.updateDraft(id, { status: 'published', publishedAt: D.now() });
        await out.answerCb(cq.id, 'Записал: пост вышел');
        const chat = await store.getChat(chatId);
        if (chat?.state?.endsWith(':' + id)) await store.setState(chatId, null);
        await out.sendHtml(chatId, '✅ Записал, что пост вышел. Повторно отправлять не буду.');
        return;
      }
      if (!(await store.claimDraft(id, 'maybe_posted', 'ready'))) return out.answerCb(cq.id, 'Уже решено', true);
      return publish(id, cq);
    }
    if (draft.status !== 'ready') return out.answerCb(cq.id, draft.status === 'published' ? 'Пост уже опубликован' : draft.status === 'maybe_posted' ? 'Сначала ответь, вышел ли пост' : 'Черновик уже не активен', true);
    if (act === 'rev') {
      await store.setState(chatId, 'post_rev:' + id);
      await out.answerCb(cq.id);
      await out.ask(chatId, '🔁 Что поменять? Напиши правку, например: «короче», «без эмодзи», «добавь призыв записаться». /cancel — отмена.');
    } else if (act === 'man') {
      await store.setState(chatId, 'post_manual:' + id);
      await out.answerCb(cq.id);
      await out.ask(chatId, '✏️ Пришли готовый текст поста целиком — опубликую как есть, форматирование Telegram сохраню. /cancel — отмена.');
    } else if (act === 'cx') {
      await store.updateDraft(id, { status: 'canceled' });
      await out.answerCb(cq.id, 'Отменено');
      await out.dropButtons(chatId, cq.message.message_id);
      const chat = await store.getChat(chatId);
      if (chat?.state?.endsWith(':' + id)) await store.setState(chatId, null);
      await out.sendHtml(chatId, '🗑 Черновик отменён.');
    }
  }

  return { startPost, onPhoto, fromPhotos, advance, onState, postCallback, channelCallback, showChannels, onChannelMembership, sendPreview, generatePost, deliver };
}
