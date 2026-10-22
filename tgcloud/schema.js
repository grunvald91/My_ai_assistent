// schema.js — таблицы бота (SQLite платформы Telegram Serverless).
//
// Правила платформы: внешних ключей нет (связи — обычные колонки, целостность в коде),
// удаление таблиц/колонок только через .deprecated(), типы колонок не меняем.
// Времена хранятся как unix-секунды (integer), заполняются кодом.

import { table, integer, text, boolean, json, real, index } from 'sdk/db';

// ── Настройки (ключ-значение): пауза, модель по умолчанию, кеш списка моделей, лимиты…
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ── Чаты: личка владельца, группы. Здесь же модель чата, сводка (память ур. 2),
//    трёхпозиционный режим группы и «состояние диалога» (ждём текст поста и т.п.).
export const chats = table('chats', {
  chatId: integer('chat_id').primaryKey(),
  type: text('type').notNull().default('private'),
  title: text('title'),
  model: text('model'),
  summary: text('summary'),
  summaryUpto: integer('summary_upto').notNull().default(0), // id последнего сообщения, вошедшего в сводку
  groupMode: text('group_mode').notNull().default('off'), // off | mention | all
  ephemeral: boolean('ephemeral').notNull().default(false), // отвечать «только автору» (эфемерные сообщения)
  notifyOwner: boolean('notify_owner').notNull().default(false), // присылать владельцу копии ответов в группе
  state: text('state'),
  stateData: text('state_data'),
  lastReplyAt: integer('last_reply_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
});

// ── Память ур. 1: последние сообщения. chat_key = id чата, для Business-чатов «b:<id>».
export const messages = table(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatKey: text('chat_key').notNull(),
    role: text('role').notNull(), // user | assistant
    name: text('name'),
    text: text('text').notNull(),
    model: text('model'),
    tokens: integer('tokens').notNull().default(0),
    ts: integer('ts').notNull().default(0),
  },
  (t) => ({ byChat: index('idx_messages_chat').on(t.chatKey, t.id) }),
);

// ── Память ур. 3: долговременные факты. scope: owner | biz | group:<chatId>
export const memories = table(
  'memories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope').notNull(),
    text: text('text').notNull(),
    source: text('source').notNull().default('explicit'), // explicit (команда) | confirmed (предложил бот, владелец подтвердил)
    createdAt: integer('created_at').notNull().default(0),
  },
  (t) => ({ byScope: index('idx_memories_scope').on(t.scope) }),
);

// Предложения бота «запомнить это?» — ждут нажатия кнопки владельцем.
export const proposals = table('proposals', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull().default(0),
});

// ── Память ур. 4: каналы владельца и их стиль.
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull().unique(),
  title: text('title'),
  username: text('username'),
  style: text('style'),
  examples: json('examples'),
  active: boolean('active').notNull().default(true),
  createdAt: integer('created_at').notNull().default(0),
});

// ── Черновики: посты в каналы (kind=post) и ответы в группу «от меня» (kind=reply).
export const drafts = table('drafts', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull().default('post'),
  channelId: integer('channel_id'), // channels.id
  targetChatId: integer('target_chat_id'), // куда публикуем
  replyToMessageId: integer('reply_to_message_id'),
  threadId: integer('thread_id'),
  brief: text('brief'), // задание владельца
  text: text('text'), // текущий текст
  format: text('format').notNull().default('md'), // md — от модели (Markdown); html — вручную от владельца
  status: text('status').notNull().default('new'),
  // new | await_channel | await_brief | ready | await_revision | await_manual | publishing | maybe_posted | published | canceled | error
  previewMessageId: integer('preview_message_id'),
  publishedMessageId: integer('published_message_id'),
  link: text('link'),
  rev: integer('rev').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
  publishedAt: integer('published_at'),
});

export const draftPhotos = table(
  'draft_photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    draftId: text('draft_id').notNull(),
    fileId: text('file_id').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => ({ byDraft: index('idx_draft_photos_draft').on(t.draftId) }),
);

// ── Telegram Business (ответы от моего имени в личных чатах).
export const bizConnections = table('biz_connections', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  userChatId: integer('user_chat_id'),
  canReply: boolean('can_reply').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: integer('created_at').notNull().default(0),
});

export const bizChats = table('biz_chats', {
  chatId: integer('chat_id').primaryKey(),
  connId: text('conn_id'),
  mode: text('mode'), // null = по умолчанию из настроек | off | confirm | auto
  contactName: text('contact_name'),
  updatedAt: integer('updated_at').notNull().default(0),
});

export const bizDrafts = table('biz_drafts', {
  id: text('id').primaryKey(),
  chatId: integer('chat_id').notNull(),
  connId: text('conn_id').notNull(),
  contactName: text('contact_name'),
  inText: text('in_text'),
  text: text('text'),
  status: text('status').notNull().default('pending'), // pending | editing | sent | skipped
  createdAt: integer('created_at').notNull().default(0),
});

// ── Расход и лимиты.
export const usage = table('usage', {
  day: text('day').primaryKey(), // YYYY-MM-DD (по часовому поясу владельца)
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  requests: integer('requests').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
});

// Счётчики «не чаще N раз за окно» (лимит запросов в минуту, ответы в группе).
export const rates = table('rates', {
  key: text('key').primaryKey(),
  win: integer('win').notNull().default(0),
  n: integer('n').notNull().default(0),
});

// ── Журнал действий (без полного текста переписки).
export const journal = table(
  'journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    chatId: integer('chat_id'),
    payload: json('payload'),
    ts: integer('ts').notNull().default(0),
  },
  (t) => ({ byTs: index('idx_journal_ts').on(t.ts) }),
);

// ── Защита от повторной обработки одного и того же апдейта.
export const updates = table('updates', {
  updateId: integer('update_id').primaryKey(),
  status: text('status').notNull().default('run'), // run | done
  ts: integer('ts').notNull().default(0),
});

// Нажатия кнопки «Стоп» при стриминге ответа: ключ «chatId:draftId».
export const stops = table('stops', {
  key: text('key').primaryKey(),
  ts: integer('ts').notNull().default(0),
});
