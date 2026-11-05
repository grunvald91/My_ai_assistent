// cards.js — server-authoritative UI cards for Telegram inline keyboards.
// The view model (kind/title/lines/actions) is transport-agnostic, so HTMLBubbles
// can be added later without migrating persistent state or guessing an API.
import { escapeHtml, safeJson, truncate } from './util.js';

const MAX_TASKS = 40;
const PAGE_SIZE = 8;
const TITLE_LIMIT = 160;
const kb = (rows) => ({ inline_keyboard: rows });

export function renderTelegramCard(card) {
  const lines = (card.lines ?? []).map((line) => escapeHtml(line));
  const header = '<b>' + escapeHtml(card.title) + '</b>';
  return {
    html: [header, ...lines].join('\n'),
    markup: kb(card.actions ?? []),
  };
}

function taskItems(board) {
  const data = safeJson(board?.data, { items: [] });
  if (!Array.isArray(data?.items)) return [];
  return data.items.filter((x) => x && typeof x.text === 'string' && typeof x.done === 'boolean')
    .slice(0, MAX_TASKS).map((x) => ({ text: x.text, done: x.done }));
}

export function createCards(D) {
  const { store, out } = D;

  async function board(chatId) {
    return store.ensureUiCard({
      id: 'tasks_' + chatId, ownerId: chatId, chatId, kind: 'tasks',
      data: JSON.stringify({ items: [] }), now: D.now(),
    });
  }

  async function modify(chatId, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await board(chatId);
      const items = taskItems(current);
      const updated = change(items);
      if (!updated) return { ok: false, current };
      if (await store.updateUiCard(current.id, current.version, JSON.stringify({ items: updated }), D.now())) {
        return { ok: true, current: await store.getUiCard(current.id) };
      }
    }
    return { ok: false, current: await board(chatId) };
  }

  async function addTask(chatId, raw) {
    const title = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > TITLE_LIMIT) {
      await out.sendHtml(chatId, 'Название задачи должно быть от 1 до 160 символов. Попробуй: <code>/task add Позвонить клиенту</code>');
      return true;
    }
    let full = false;
    const result = await modify(chatId, (items) => {
      if (items.length >= MAX_TASKS) { full = true; return null; }
      return [...items, { text: title, done: false }];
    });
    if (!result.ok) {
      await out.sendHtml(chatId, full ? 'Достигнут предел 40 задач. Завершённые задачи пока остаются в списке.' : 'Карточку одновременно изменили. Попробуй снова.');
      return true;
    }
    await show(chatId, 'tasks');
    return true;
  }

  async function cardFor(chatId, kind, page = 0) {
    if (kind === 'home') {
      const current = await board(chatId);
      const items = taskItems(current);
      const done = items.filter((x) => x.done).length;
      const memories = await store.listMemories(['owner']);
      return {
        kind, title: '🧭 Моя панель',
        lines: [
          'Задачи: ' + done + '/' + items.length + ' выполнено',
          'Факты в памяти: ' + memories.length,
          'Данные задач хранятся на сервере и не зависят от этого сообщения.',
        ],
        actions: [
          [{ text: '✅ Задачи', callback_data: 'ui:tasks:0' }, { text: '🧠 Память', callback_data: 'ui:memory' }],
          [{ text: '📅 Календарь', callback_data: 'ui:calendar' }, { text: '🚆 Маршруты', callback_data: 'ui:routes' }],
          [{ text: '🤖 Агент', callback_data: 'ui:agent' }, { text: '🔄 Обновить', callback_data: 'ui:home' }],
        ],
      };
    }
    if (kind === 'tasks') {
      const current = await board(chatId);
      const items = taskItems(current);
      const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      const p = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, pages - 1));
      const start = p * PAGE_SIZE;
      const slice = items.slice(start, start + PAGE_SIZE);
      const actions = slice.map((item, i) => [{
        text: (item.done ? '✅ ' : '▫️ ') + truncate(item.text, 45),
        callback_data: 'ui:toggle:' + current.version + ':' + (start + i) + ':' + p,
      }]);
      if (pages > 1) {
        actions.push([
          ...(p > 0 ? [{ text: '⬅️', callback_data: 'ui:tasks:' + (p - 1) }] : []),
          { text: (p + 1) + '/' + pages, callback_data: 'ui:tasks:' + p },
          ...(p + 1 < pages ? [{ text: '➡️', callback_data: 'ui:tasks:' + (p + 1) }] : []),
        ]);
      }
      actions.push([{ text: '➕ Добавить задачу', callback_data: 'ui:add' }]);
      actions.push([{ text: '⬅️ Панель', callback_data: 'ui:home' }, { text: '🔄 Обновить', callback_data: 'ui:tasks:' + p }]);
      return {
        kind, revision: current.version, title: '✅ Задачи',
        lines: [
          items.length ? 'Выполнено: ' + items.filter((x) => x.done).length + ' из ' + items.length : 'Список пуст.',
          'Нажми на задачу, чтобы изменить её статус.',
          'Добавить текстом: /task add Название',
        ],
        actions,
      };
    }
    if (kind === 'memory') {
      const facts = await store.listMemories(['owner', 'biz']);
      return {
        kind, title: '🧠 Память',
        lines: [
          facts.length ? 'Всего фактов: ' + facts.length : 'Сохранённых фактов нет.',
          ...facts.slice(-7).map((x) => x.id + '. ' + truncate(x.text, 170)),
          'Добавить: /remember текст. Удалить: /forget номер.',
        ],
        actions: [[{ text: '⬅️ Панель', callback_data: 'ui:home' }, { text: '🔄 Обновить', callback_data: 'ui:memory' }]],
      };
    }
    if (kind === 'calendar') return {
      kind, title: '📅 Календарь',
      lines: ['Подключение Google Calendar в этом боте пока не реализовано. События здесь не выдумываются.'],
      actions: [[{ text: '⬅️ Панель', callback_data: 'ui:home' }]],
    };
    if (kind === 'routes') return {
      kind, title: '🚆 Маршруты',
      lines: ['Поиск поездок доступен через обычный запрос боту. Сохранение маршрутов в этой панели пока не подключено.', 'Пример: Как добраться из Сочи в Адлер завтра?'],
      actions: [[{ text: '⬅️ Панель', callback_data: 'ui:home' }]],
    };
    return {
      kind: 'agent', title: '🤖 ИИ-агент',
      lines: ['Задачи агенту сейчас выдаются текстовой командой:', '/agent задание', 'Отслеживание всех поручений в одной карточке появится после подключения хранилища заданий.'],
      actions: [[{ text: '⬅️ Панель', callback_data: 'ui:home' }]],
    };
  }

  async function show(chatId, kind = 'home', editMessageId = null, page = 0) {
    const card = await cardFor(chatId, kind, page);
    const { html, markup } = renderTelegramCard(card);
    if (editMessageId) {
      try {
        await out.editHtml(chatId, editMessageId, html, markup);
        return true;
      } catch { /* old message/markup: send a new one */ }
    }
    await out.sendHtml(chatId, html, { reply_markup: markup });
    return true;
  }

  async function command(chatId, cmd, arg = '') {
    if (cmd === 'panel') return show(chatId, 'home');
    if (cmd === 'tasks') return show(chatId, 'tasks');
    if (cmd === 'task') {
      const m = /^add\s+([\s\S]+)$/i.exec(arg.trim());
      if (m) return addTask(chatId, m[1]);
      await out.sendHtml(chatId, 'Добавить: <code>/task add Название задачи</code>. Открыть список: /tasks');
      return true;
    }
    return false;
  }

  async function onState(msg) {
    const chatId = msg.chat.id;
    await store.setState(chatId, null);
    return addTask(chatId, msg.text ?? '');
  }

  async function callback(cq, parts) {
    const chatId = cq.message.chat.id;
    if (cq.message.chat.type !== 'private' || cq.from?.id !== chatId) {
      await out.answerCb(cq.id, 'Панель доступна только в личном чате', true);
      return true;
    }
    const [action, revision, index, page] = parts;
    const id = cq.message.message_id;
    if (action === 'add') {
      await store.setState(chatId, 'ui_add_task');
      await out.answerCb(cq.id);
      await out.sendHtml(chatId, '➕ Напиши название задачи следующим сообщением (до 160 символов). Отмена: /cancel');
      return true;
    }
    if (action === 'toggle') {
      const current = await board(chatId);
      const p = Number(page);
      const idx = Number(index);
      if (!Number.isSafeInteger(idx) || idx < 0 || !Number.isSafeInteger(Number(revision)) || current.version !== Number(revision)) {
        await out.answerCb(cq.id, 'Карточка изменилась — обновляю');
        return show(chatId, 'tasks', id, Number.isSafeInteger(p) ? p : 0);
      }
      const changed = await modify(chatId, (items) => {
        if (idx >= items.length) return null;
        items[idx] = { ...items[idx], done: !items[idx].done };
        return items;
      });
      await out.answerCb(cq.id, changed.ok ? 'Готово' : 'Карточка изменилась — обновляю');
      return show(chatId, 'tasks', id, Number.isSafeInteger(p) ? p : 0);
    }
    const pages = action === 'tasks' ? Number(revision) : 0;
    const allowed = new Set(['home', 'tasks', 'memory', 'calendar', 'routes', 'agent']);
    if (!allowed.has(action)) {
      await out.answerCb(cq.id, 'Неизвестная кнопка');
      return true;
    }
    await out.answerCb(cq.id);
    return show(chatId, action, id, Number.isSafeInteger(pages) ? pages : 0);
  }

  return { show, command, callback, onState };
}
