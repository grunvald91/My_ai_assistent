// store.js — весь доступ к базе данных (SQLite платформы) в одном месте.
// Каждая функция — маленькая и однотипная. Все вызовы db асинхронные (всегда await).
// Времена (now) передаются снаружи в unix-секундах — так проще тестировать.

import { db } from 'sdk';
import { eq, and, gt, lt, desc, asc, inArray, like, sql } from 'sdk/db';
import * as T from '../schema.js';

const one = (row) => row ?? null;

// ───────────── настройки ─────────────

/** Самый лёгкий запрос к БД: «пульс» для отслеживания срока, пока вызов ждёт ответа модели (см. llm.js withDeadline). */
export async function ping() {
  await db.get(sql`SELECT 1 AS x`);
}

export async function getSetting(key) {
  const r = one(await db.select().from(T.settings).where(eq(T.settings.key, key)).get());
  return r ? r.value : null;
}

export async function getSettings(keys) {
  const rows = await db.select().from(T.settings).where(inArray(T.settings.key, keys)).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** setSetting(key, null) удаляет значение. */
export async function setSetting(key, value) {
  if (value === null || value === undefined) {
    await db.delete(T.settings).where(eq(T.settings.key, key)).run();
    return;
  }
  const v = String(value);
  await db
    .insert(T.settings)
    .values({ key, value: v })
    .onConflictDoUpdate({ target: T.settings.key, set: { value: v } })
    .run();
}

// ───────────── чаты ─────────────

export async function getChat(chatId) {
  return one(await db.select().from(T.chats).where(eq(T.chats.chatId, chatId)).get());
}

/** Создаёт запись чата при первом контакте и обновляет название/тип, если изменились. */
export async function ensureChat(chatId, { type = 'private', title = null }, now) {
  await db
    .insert(T.chats)
    .values({ chatId, type, title, updatedAt: now })
    .onConflictDoNothing({ target: T.chats.chatId })
    .run();
  const row = await getChat(chatId);
  if (row && (row.type !== type || (title && row.title !== title))) {
    await db.update(T.chats).set({ type, title: title ?? row.title, updatedAt: now }).where(eq(T.chats.chatId, chatId)).run();
    return getChat(chatId);
  }
  return row;
}

export async function updateChat(chatId, patch) {
  await db.update(T.chats).set(patch).where(eq(T.chats.chatId, chatId)).run();
}

export async function listChats(type) {
  const q = db.select().from(T.chats);
  return type ? q.where(eq(T.chats.type, type)).orderBy(asc(T.chats.title)).all() : q.orderBy(asc(T.chats.title)).all();
}

export async function listGroupChats() {
  return db.select().from(T.chats).where(inArray(T.chats.type, ['group', 'supergroup'])).orderBy(asc(T.chats.title)).all();
}

/** Состояние диалога: «ждём то-то». state=null очищает. Если записи чата ещё нет — создаёт (личный чат). */
export async function setState(chatId, state, data = null) {
  const st = state ?? null;
  const sd = data == null ? null : typeof data === 'string' ? data : JSON.stringify(data);
  await db
    .insert(T.chats)
    .values({ chatId, type: 'private', state: st, stateData: sd })
    .onConflictDoUpdate({ target: T.chats.chatId, set: { state: st, stateData: sd } })
    .run();
}

// ───────────── сообщения (память ур. 1) ─────────────

export async function addMessage({ chatKey, role, name = null, text, model = null, tokens = 0, ts }) {
  await db.insert(T.messages).values({ chatKey, role, name, text, model, tokens, ts }).run();
}

/** Последние `limit` сообщений после afterId, по возрастанию. */
export async function getHistory(chatKey, afterId, limit) {
  const rows = await db
    .select()
    .from(T.messages)
    .where(and(eq(T.messages.chatKey, chatKey), gt(T.messages.id, afterId)))
    .orderBy(desc(T.messages.id))
    .limit(limit)
    .all();
  return rows.reverse();
}

export async function countAfter(chatKey, afterId) {
  return db.$count(T.messages, and(eq(T.messages.chatKey, chatKey), gt(T.messages.id, afterId)));
}

export async function oldestAfter(chatKey, afterId, n) {
  return db
    .select()
    .from(T.messages)
    .where(and(eq(T.messages.chatKey, chatKey), gt(T.messages.id, afterId)))
    .orderBy(asc(T.messages.id))
    .limit(n)
    .all();
}

export async function deleteUpTo(chatKey, id) {
  await db.delete(T.messages).where(and(eq(T.messages.chatKey, chatKey), lt(T.messages.id, id + 1))).run();
}

/** Удаляет одно сообщение истории (например, ответ быстрой модели перед повтором сильной). */
export async function deleteMessage(chatKey, id) {
  await db.delete(T.messages).where(and(eq(T.messages.chatKey, chatKey), eq(T.messages.id, id))).run();
}

export async function clearMessages(chatKey) {
  await db.delete(T.messages).where(eq(T.messages.chatKey, chatKey)).run();
}

/** Ограничение срока хранения исходной переписки группы. */
export async function pruneMessagesBefore(chatKey, beforeTs) {
  await db.delete(T.messages).where(and(eq(T.messages.chatKey, chatKey), lt(T.messages.ts, beforeTs))).run();
}

/** Жёсткий потолок размера истории чата — на случай, если сжатие в сводку не сработало. */
export async function trimMessages(chatKey, keep) {
  const edge = one(
    await db
      .select({ id: T.messages.id })
      .from(T.messages)
      .where(eq(T.messages.chatKey, chatKey))
      .orderBy(desc(T.messages.id))
      .limit(1)
      .offset(keep)
      .get(),
  );
  if (edge) await deleteUpTo(chatKey, edge.id);
}

// ───────────── факты (память ур. 3) ─────────────

export async function addMemory(scope, text, source, now) {
  await db.insert(T.memories).values({ scope, text, source, createdAt: now }).run();
}

export async function listMemories(scopes) {
  return db.select().from(T.memories).where(inArray(T.memories.scope, scopes)).orderBy(asc(T.memories.id)).all();
}

export async function countMemories(scope) {
  return db.$count(T.memories, eq(T.memories.scope, scope));
}

export async function deleteMemory(id) {
  const r = await db.delete(T.memories).where(eq(T.memories.id, id)).run();
  return Number(r?.rowsAffected ?? 0) > 0;
}

export async function addProposal(id, scope, text, now) {
  await db.insert(T.proposals).values({ id, scope, text, createdAt: now }).run();
}

/** Забирает предложение (и удаляет его). */
export async function takeProposal(id) {
  const row = one(await db.select().from(T.proposals).where(eq(T.proposals.id, id)).get());
  if (row) await db.delete(T.proposals).where(eq(T.proposals.id, id)).run();
  return row;
}

export async function pruneProposals(before) {
  await db.delete(T.proposals).where(lt(T.proposals.createdAt, before)).run();
}

/** /forget_all: стирает историю, сводки и факты (каналы, посты, настройки остаются). */
export async function wipeMemory() {
  await db.delete(T.messages).run();
  await db.delete(T.memories).run();
  await db.delete(T.proposals).run();
  // Аналитические сводки — тоже память; /forget_all удаляет их и отключает наблюдение.
  await db.delete(T.settings).where(like(T.settings.key, 'group_report:%')).run();
  await db.delete(T.settings).where(like(T.settings.key, 'group_observe:%')).run();
  await db.update(T.chats).set({ summary: null, summaryUpto: 0 }).run();
}

// ───────────── каналы (память ур. 4) ─────────────

export async function listChannels() {
  return db.select().from(T.channels).where(eq(T.channels.active, true)).orderBy(asc(T.channels.id)).all();
}

export async function getChannel(id) {
  return one(await db.select().from(T.channels).where(eq(T.channels.id, id)).get());
}

export async function getChannelByChat(chatId) {
  return one(await db.select().from(T.channels).where(eq(T.channels.chatId, chatId)).get());
}

export async function upsertChannel({ chatId, title, username }, now) {
  await db
    .insert(T.channels)
    .values({ chatId, title: title ?? null, username: username ?? null, active: true, createdAt: now })
    .onConflictDoUpdate({ target: T.channels.chatId, set: { title: title ?? null, username: username ?? null, active: true } })
    .run();
  return getChannelByChat(chatId);
}

export async function updateChannel(id, patch) {
  await db.update(T.channels).set(patch).where(eq(T.channels.id, id)).run();
}

export async function deactivateChannelByChat(chatId) {
  await db.update(T.channels).set({ active: false }).where(eq(T.channels.chatId, chatId)).run();
}

// ───────────── черновики постов / ответов ─────────────

export async function createDraft(d) {
  await db.insert(T.drafts).values(d).run();
}

export async function getDraft(id) {
  return one(await db.select().from(T.drafts).where(eq(T.drafts.id, id)).get());
}

export async function updateDraft(id, patch) {
  await db.update(T.drafts).set(patch).where(eq(T.drafts.id, id)).run();
}

/** Атомарно переводит черновик из одного из статусов from в to. true — если именно мы его «забрали». */
export async function claimDraft(id, from, to) {
  const r = await db
    .update(T.drafts)
    .set({ status: to })
    .where(and(eq(T.drafts.id, id), inArray(T.drafts.status, Array.isArray(from) ? from : [from])))
    .run();
  return Number(r?.rowsAffected ?? 0) > 0;
}

export async function addDraftPhoto(draftId, fileId, n) {
  await db.insert(T.draftPhotos).values({ draftId, fileId, n }).run();
}

/** Удаляет строки draft_photos по id (только их: параллельно могли добавиться новые). */
export async function deleteDraftPhotos(ids) {
  if (!ids.length) return;
  await db.delete(T.draftPhotos).where(inArray(T.draftPhotos.id, ids)).run();
}

export async function listDraftPhotos(draftId) {
  return db
    .select()
    .from(T.draftPhotos)
    .where(eq(T.draftPhotos.draftId, draftId))
    .orderBy(asc(T.draftPhotos.n), asc(T.draftPhotos.id))
    .all();
}

// ───────────── Telegram Business ─────────────

export async function getBizConnection(id) {
  return one(await db.select().from(T.bizConnections).where(eq(T.bizConnections.id, id)).get());
}

export async function listBizConnections() {
  return db.select().from(T.bizConnections).orderBy(asc(T.bizConnections.createdAt)).all();
}

export async function upsertBizConnection({ id, userId, userChatId, canReply, enabled }, now) {
  await db
    .insert(T.bizConnections)
    .values({ id, userId, userChatId: userChatId ?? null, canReply: !!canReply, enabled: !!enabled, createdAt: now })
    .onConflictDoUpdate({
      target: T.bizConnections.id,
      set: { userId, userChatId: userChatId ?? null, canReply: !!canReply, enabled: !!enabled },
    })
    .run();
}

export async function getBizChat(chatId) {
  return one(await db.select().from(T.bizChats).where(eq(T.bizChats.chatId, chatId)).get());
}

export async function touchBizChat({ chatId, connId, contactName }, now) {
  await db
    .insert(T.bizChats)
    .values({ chatId, connId, contactName: contactName ?? null, updatedAt: now })
    .onConflictDoUpdate({ target: T.bizChats.chatId, set: { connId, contactName: contactName ?? null, updatedAt: now } })
    .run();
  return getBizChat(chatId);
}

export async function setBizMode(chatId, mode, now) {
  await db.update(T.bizChats).set({ mode, updatedAt: now }).where(eq(T.bizChats.chatId, chatId)).run();
}

export async function listBizChats(limit = 10) {
  return db.select().from(T.bizChats).orderBy(desc(T.bizChats.updatedAt)).limit(limit).all();
}

export async function createBizDraft(d) {
  await db.insert(T.bizDrafts).values(d).run();
}

export async function getBizDraft(id) {
  return one(await db.select().from(T.bizDrafts).where(eq(T.bizDrafts.id, id)).get());
}

export async function updateBizDraft(id, patch) {
  await db.update(T.bizDrafts).set(patch).where(eq(T.bizDrafts.id, id)).run();
}

export async function claimBizDraft(id, from, to) {
  const r = await db
    .update(T.bizDrafts)
    .set({ status: to })
    .where(and(eq(T.bizDrafts.id, id), inArray(T.bizDrafts.status, Array.isArray(from) ? from : [from])))
    .run();
  return Number(r?.rowsAffected ?? 0) > 0;
}

// ───────────── расход и лимиты ─────────────

export async function addUsage(day, tokensIn, tokensOut, costUsd) {
  await db
    .insert(T.usage)
    .values({ day, tokensIn, tokensOut, requests: 1, costUsd })
    .onConflictDoUpdate({
      target: T.usage.day,
      set: {
        tokensIn: sql`${T.usage.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${T.usage.tokensOut} + ${tokensOut}`,
        requests: sql`${T.usage.requests} + 1`,
        costUsd: sql`${T.usage.costUsd} + ${costUsd}`,
      },
    })
    .run();
}

export async function getUsage(day) {
  return one(await db.select().from(T.usage).where(eq(T.usage.day, day)).get());
}

/** Сумма за месяц; monthPrefix — «YYYY-MM». */
export async function sumUsage(monthPrefix) {
  const rows = await db.select().from(T.usage).where(like(T.usage.day, monthPrefix + '%')).all();
  const s = { tokensIn: 0, tokensOut: 0, requests: 0, costUsd: 0 };
  for (const r of rows) {
    s.tokensIn += r.tokensIn;
    s.tokensOut += r.tokensOut;
    s.requests += r.requests;
    s.costUsd += r.costUsd;
  }
  return s;
}

/** «Не чаще limit раз за окно win». Возвращает { allowed, n }. */
export async function hit(key, win, limit) {
  const row = one(await db.select().from(T.rates).where(eq(T.rates.key, key)).get());
  if (!row || row.win !== win) {
    await db
      .insert(T.rates)
      .values({ key, win, n: 1 })
      .onConflictDoUpdate({ target: T.rates.key, set: { win, n: 1 } })
      .run();
    return { allowed: limit >= 1, n: 1 };
  }
  if (row.n >= limit) return { allowed: false, n: row.n };
  await db.update(T.rates).set({ n: row.n + 1 }).where(eq(T.rates.key, key)).run();
  return { allowed: true, n: row.n + 1 };
}

// ───────────── журнал ─────────────

export async function log(type, chatId, payload, now) {
  try {
    await db.insert(T.journal).values({ type, chatId: chatId ?? null, payload: payload ?? null, ts: now }).run();
  } catch (e) {
    console.error('journal write failed', e);
  }
}

export async function pruneJournal(keep) {
  const edge = one(await db.select({ id: T.journal.id }).from(T.journal).orderBy(desc(T.journal.id)).limit(1).offset(keep).get());
  if (edge) await db.delete(T.journal).where(lt(T.journal.id, edge.id + 1)).run();
}

export async function recentJournal(limit = 20) {
  return db.select().from(T.journal).orderBy(desc(T.journal.id)).limit(limit).all();
}

// ───────────── защита от повторной обработки апдейта ─────────────

/** true — апдейт наш, обрабатываем; false — уже обработан или обрабатывается другим вызовом. */
/** Однократное действие: true — только у первого вызова с этим ключом (вставка строки; повторная упрётся в ключ). */
export async function claimOnce(key, now) {
  try {
    await db.insert(T.rates).values({ key, win: now, n: 1 }).run();
    return true;
  } catch {
    return false; // уже было (или параллельный вызов успел раньше)
  }
}

export async function beginUpdate(updateId, now, lockSec) {
  const row = one(await db.select().from(T.updates).where(eq(T.updates.updateId, updateId)).get());
  if (row) {
    if (row.status === 'done') return false;
    if (now - row.ts < lockSec) return false;
    await db.update(T.updates).set({ ts: now }).where(eq(T.updates.updateId, updateId)).run();
    return true;
  }
  try {
    await db.insert(T.updates).values({ updateId, status: 'run', ts: now }).run();
  } catch {
    return false; // параллельный вызов успел вставить раньше
  }
  return true;
}

export async function finishUpdate(updateId) {
  await db.update(T.updates).set({ status: 'done' }).where(eq(T.updates.updateId, updateId)).run();
}

export async function pruneUpdates(before) {
  await db.delete(T.updates).where(lt(T.updates.ts, before)).run();
}

// ───────────── кнопка «Стоп» ─────────────

export async function setStop(key, now) {
  await db.insert(T.stops).values({ key, ts: now }).onConflictDoUpdate({ target: T.stops.key, set: { ts: now } }).run();
}

export async function isStopped(key) {
  return !!one(await db.select().from(T.stops).where(eq(T.stops.key, key)).get());
}

export async function pruneStops(before) {
  await db.delete(T.stops).where(lt(T.stops.ts, before)).run();
}

// ───────────── экспорт ─────────────

export async function exportAll() {
  const data = {};
  const dump = async (name, t, limit = 5000) => {
    data[name] = await db.select().from(t).limit(limit).all();
  };
  await dump('chats', T.chats);
  await dump('messages', T.messages);
  await dump('memories', T.memories);
  await dump('channels', T.channels);
  await dump('drafts', T.drafts);
  await dump('draft_photos', T.draftPhotos);
  await dump('biz_connections', T.bizConnections);
  await dump('biz_chats', T.bizChats);
  await dump('usage', T.usage);
  await dump('journal', T.journal, 500);
  const settings = await db.select().from(T.settings).all();
  data.settings = settings.filter((s) => s.key !== 'models_cache');
  return data;
}

