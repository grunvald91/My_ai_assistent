// app.js — сборка бота и маршрутизация апдейтов. Все зависимости приходят в D (см. deps.js),
// поэтому тесты запускают тот же код на настоящей БД с заглушками Telegram и ClaudeHub.
//
// D: { api, store, llm, cfg, now(), sleep(ms), ownerIds: number[], InputFile }

import { createOut } from './out.js';
import { createCore } from './core.js';
import { createChat } from './chat.js';
import { createPosts } from './posts.js';
import { createBusiness } from './business.js';
import { createReplies } from './replies.js';
import { createCommands } from './commands.js';
import { createCode } from './code.js';
import { createGithub } from './github.js';
import { displayName, escapeHtml, parseCommand } from './util.js';

const OWN_STATE = /^(post_|style:|example:)/;

export function createApp(base) {
  const D = { ...base };
  const { store, cfg } = D;
  D.ownerIds = (base.ownerIds ?? []).filter((n) => Number.isFinite(n));
  D.ownerId = D.ownerIds[0] ?? null;
  D.isOwner = (id) => id != null && D.ownerIds.includes(id);
  D.log = (type, chatId, payload) => store.log(type, chatId, payload, D.now());

  D.selfRepo = base.selfRepo ?? '';
  D.github = base.ghToken ? createGithub({ fetch: base.fetch, token: base.ghToken }) : null;
  D.out = createOut(D);
  D.core = createCore(D);
  const { out, core } = D;
  const chatMod = createChat(D);
  D.notifyOwnerOnce = chatMod.notifyOwnerOnce;
  const posts = createPosts(D);
  const business = createBusiness(D);
  const replies = createReplies(D);
  const code = createCode(D);
  D.repoContext = code.repoContext; // чат читает репозиторий по просьбе владельца
  const commands = createCommands(D, { posts, business, replies, code });

  // ───────── кто я ─────────

  let me = null;
  async function ensureBot() {
    if (me) return me;
    const [u, i] = [await store.getSetting('bot_username'), await store.getSetting('bot_id')];
    if (u && i) return (me = { username: u, id: Number(i) });
    const info = await D.api.getMe();
    await store.setSetting('bot_username', info.username ?? '');
    await store.setSetting('bot_id', info.id);
    return (me = { username: info.username ?? '', id: info.id });
  }

  // ───────── вход ─────────

  /** Главная точка: type — тип апдейта (имя обработчика), payload — его содержимое, ctx — второй аргумент платформы. */
  async function handle(type, payload, ctx) {
    const updateId = ctx?.update?.update_id;
    if (updateId != null && !(await store.beginUpdate(updateId, D.now(), cfg.updateRunLockSec))) {
      return; // дубль апдейта или он уже обрабатывается
    }
    try {
      await dispatch(type, payload);
    } catch (e) {
      await onFailure(type, payload, e);
    }
    if (updateId != null) await store.finishUpdate(updateId);
    await maintenance();
  }

  async function dispatch(type, p) {
    switch (type) {
      case 'message':
        return onMessage(p);
      case 'callback_query':
        return onCallback(p);
      case 'business_connection':
        return business.onConnection(p);
      case 'business_message':
        return business.onMessage(p);
      case 'my_chat_member':
        return onMyChatMember(p);
      case 'stopped_message_generation':
        return store.setStop(`${p.chat.id}:${p.draft_id}`, D.now());
      default:
        return undefined;
    }
  }

  async function onFailure(type, p, e) {
    console.error('handler failed', type, e);
    const chatId = p?.chat?.id ?? p?.message?.chat?.id ?? null;
    await D.log('error', chatId, { type, message: String(e?.description ?? e?.message ?? e).slice(0, 300) });
    // сообщаем только владельцу и в его личном чате
    const where = type === 'message' ? p?.chat : type === 'callback_query' ? p?.message?.chat : null;
    const who = type === 'message' ? p?.from : p?.from;
    if (where?.type === 'private' && D.isOwner(who?.id)) {
      try {
        await out.sendHtml(where.id, '⚠️ Что-то пошло не так. Ошибка записана в журнал — попробуй ещё раз.');
      } catch {
        /* нечего делать */
      }
    }
  }

  /** Раз в час: чистка служебных таблиц. */
  async function maintenance() {
    try {
      const t = D.now();
      const last = Number(await store.getSetting('gc_ts')) || 0;
      if (t - last < 3600) return;
      await store.setSetting('gc_ts', t);
      await store.pruneUpdates(t - cfg.updatesKeepSec);
      await store.pruneJournal(cfg.journalKeep);
      await store.pruneProposals(t - cfg.proposalTtlSec);
      await store.pruneStops(t - 3600);
    } catch (e) {
      console.warn('maintenance failed', e?.message ?? e);
    }
  }

  // ───────── сообщения ─────────

  async function onMessage(msg) {
    if (!msg?.chat || msg.from?.is_bot) return;
    const type = msg.chat.type;
    if (type === 'private') return onPrivate(msg);
    if (type === 'group' || type === 'supergroup') return onGroup(msg);
  }

  /** Личка: владелец — полный доступ; остальным вежливый отказ (не чаще раза в час). */
  async function onPrivate(msg) {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    const bot = await ensureBot();

    if (!D.ownerIds.length) {
      return stranger(msg, bot, `⚙️ Бот ещё не настроен: не указан владелец.\n\nТвой Telegram ID: <code>${fromId}</code>\nДобавь его в GitHub → Settings → Secrets and variables → Actions (секрет или переменная) как <code>OWNER_IDS</code> и запусти деплой ещё раз.`);
    }
    if (!D.isOwner(fromId)) {
      return stranger(msg, bot, '🔒 Это личный бот, он отвечает только своему владельцу.');
    }

    const chat = await store.ensureChat(chatId, { type: 'private', title: displayName(msg.from) }, D.now());
    if (!(await store.getSetting('owner_name'))) await store.setSetting('owner_name', msg.from.first_name ?? '');
    await commands.ensureCommands();

    // фото → поток постов (в том числе альбомы)
    if (msg.photo) {
      let c = chat;
      if (chat.state && !chat.state.startsWith('post_brief:')) {
        await store.setState(chatId, null);
        c = { ...chat, state: null };
      }
      return posts.onPhoto(msg, c);
    }

    const text = msg.text;
    if (!text) {
      await out.sendHtml(chatId, 'Пока понимаю текст и фото (фото — для постов в каналы). Остальное, увы, пропускаю.');
      return;
    }

    const cmd = parseCommand(text, bot.username);
    if (cmd?.foreign) return;
    if (cmd) {
      if (chat.state && cmd.cmd !== 'cancel') await store.setState(chatId, null);
      const handled = await commands.run(cmd.cmd, cmd.arg, msg, chat);
      if (!handled) await out.sendHtml(chatId, `Не знаю команду /${escapeHtml(cmd.cmd)}. Список: /help`);
      return;
    }

    if (chat.state) {
      if (await dispatchState(msg, chat)) return;
    }

    await chatMod.answerOwner(msg, chat, text);
  }

  async function dispatchState(msg, chat) {
    const st = chat.state ?? '';
    if (OWN_STATE.test(st)) return posts.onState(msg, chat);
    if (st.startsWith('biz_')) return business.onState(msg, chat);
    if (st.startsWith('draft_rev:')) return replies.onState(msg, chat);
    if (st === 'code_task') return code.onState(msg, chat);
    await store.setState(chat.chatId, null); // неизвестное состояние — сбрасываем
    return false;
  }

  async function stranger(msg, bot, text) {
    const cmd = parseCommand(msg.text ?? '', bot.username);
    if (cmd?.foreign) return;
    if (cmd?.cmd === 'id') {
      await out.sendHtml(msg.chat.id, `Твой Telegram ID: <code>${msg.from?.id}</code>`);
      return;
    }
    const r = await store.hit('stranger:' + msg.from?.id, Math.floor(D.now() / 3600), 1);
    if (r.allowed) {
      await out.sendHtml(msg.chat.id, text);
      await D.log('stranger', msg.chat.id, { user: msg.from?.id });
    }
  }

  // ───────── группы ─────────

  async function onGroup(msg) {
    if (!D.ownerIds.length) return;
    const chatId = msg.chat.id;
    const bot = await ensureBot();
    const fromOwner = D.isOwner(msg.from?.id);
    const chat = await store.ensureChat(chatId, { type: msg.chat.type, title: msg.chat.title ?? null }, D.now());

    const text = (msg.text ?? msg.caption ?? '').trim();
    const cmd = parseCommand(text, bot.username);
    if (cmd?.foreign) return;

    // команды владельца в группе (кроме /ask, который доступен всем участникам)
    if (cmd && cmd.cmd !== 'ask') {
      if (fromOwner) await commands.run(cmd.cmd, cmd.arg, msg, chat);
      return;
    }

    const mode = chat.groupMode;
    if (mode === 'off' || !text) return;
    if (await core.paused()) return;

    const mention = !!bot.username && new RegExp('@' + bot.username + '(?![A-Za-z0-9_])', 'i').test(text);
    const replyToBot = msg.reply_to_message?.from?.id === bot.id;
    const addressed = !!cmd || mention || replyToBot;

    let q = cmd ? cmd.arg : text;
    if (mention) q = q.replace(new RegExp('@' + bot.username + '(?![A-Za-z0-9_])', 'ig'), '').replace(/\s+/g, ' ').trim();
    if (cmd && !q) {
      await out.sendText({ chatId, text: 'Напиши вопрос после /ask, например: /ask как лучше назвать курс?', replyTo: msg.message_id, threadId: msg.is_topic_message ? msg.message_thread_id : undefined });
      return;
    }
    if (!q) q = '(упомянули без вопроса)';

    if (mode === 'mention' && !addressed) {
      // молчим, но запоминаем реплику: так ответ «по запросу» будет учитывать, о чём шёл разговор
      await store.addMessage({ chatKey: String(chatId), role: 'user', name: displayName(msg.from), text: chatMod.quoteOf(msg) + text, ts: D.now() });
      await store.trimMessages(String(chatId), 120);
      return;
    }
    await chatMod.answerGroup(msg, chat, q, addressed ? 'mention' : 'all');
  }

  // ───────── кнопки ─────────

  async function onCallback(cq) {
    if (!D.isOwner(cq.from?.id)) {
      await out.answerCb(cq.id, 'Только для владельца', true);
      return;
    }
    if (!cq.message || !cq.data) {
      await out.answerCb(cq.id);
      return;
    }
    const parts = String(cq.data).split(':');
    try {
      switch (parts[0]) {
        case 'm':
        case 'g':
        case 't':
        case 'rc':
        case 'mem':
        case 'fa':
          return await commands.callback(cq, parts);
        case 'p':
          return await posts.postCallback(cq, parts.slice(1));
        case 'c':
          return await posts.channelCallback(cq, parts.slice(1));
        case 'b':
          return await business.callback(cq, parts.slice(1));
        case 'd':
          return await replies.callback(cq, parts.slice(1));
        case 'x':
          return await code.callback(cq, parts.slice(1));
        case 'r': {
          const chatId = cq.message.chat.id;
          await out.answerCb(cq.id, 'Повторяю…');
          await out.dropButtons(chatId, cq.message.message_id);
          if (!(await chatMod.retryLast(chatId))) await out.sendHtml(chatId, 'Нечего повторять — напиши сообщение ещё раз.');
          return undefined;
        }
        default:
          return await out.answerCb(cq.id);
      }
    } catch (e) {
      await out.answerCb(cq.id, 'Ошибка, попробуй ещё раз', true);
      throw e;
    }
  }

  // ───────── изменения членства бота ─────────

  async function onMyChatMember(upd) {
    const chat = upd.chat;
    const status = upd.new_chat_member?.status;
    const fromId = upd.from?.id;
    if (!D.ownerIds.length) return;

    if (chat.type === 'channel') {
      if (status === 'administrator' && !D.isOwner(fromId)) {
        await D.log('foreign_channel_left', chat.id, { by: fromId });
        try {
          await D.api.leaveChat({ chat_id: chat.id });
        } catch {
          /* уже вышли */
        }
        return;
      }
      return posts.onChannelMembership(upd);
    }

    if (chat.type === 'group' || chat.type === 'supergroup') {
      const added = status === 'member' || status === 'administrator';
      if (added) {
        if (!D.isOwner(fromId)) {
          await D.log('foreign_group_left', chat.id, { by: fromId });
          try {
            await D.api.leaveChat({ chat_id: chat.id });
          } catch {
            /* уже вышли */
          }
          return;
        }
        const wasIn = ['member', 'administrator'].includes(upd.old_chat_member?.status);
        const row = await store.ensureChat(chat.id, { type: chat.type, title: chat.title ?? null }, D.now());
        if (!wasIn) {
          await store.updateChat(chat.id, { groupMode: 'mention' });
          await out.toOwner(
            `👥 Меня добавили в «${escapeHtml(chat.title ?? '')}». Режим: <b>по запросу</b> — отвечаю, когда меня упомянут, ответят мне или напишут /ask.\nНастроить: /group`,
          );
        } else if (row.groupMode === 'off') {
          return; // права поменялись — режим не трогаем
        }
      } else if (status === 'left' || status === 'kicked') {
        await store.ensureChat(chat.id, { type: chat.type, title: chat.title ?? null }, D.now());
        await store.updateChat(chat.id, { groupMode: 'off' });
        await out.toOwner(`👥 Я больше не в группе «${escapeHtml(chat.title ?? '')}».`);
      }
    }
  }

  return { handle, dispatch, commands, posts, business, replies, code, chat: chatMod, core, out, D };
}
