// cards.js — server-authoritative UI cards for Telegram inline keyboards.
// The view model (kind/title/lines/actions) is transport-agnostic, so HTMLBubbles
// can be added later without migrating persistent state or guessing an API.
import { escapeHtml, safeJson, truncate, utf8Encode } from './util.js';
import { ASSISTANT_WIDGET_HTML } from './widget-html.js';

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
  let deliveryCheckedAt = -Infinity;
  let deliveryAvailable = false;

  async function board(chatId) {
    return store.ensureUiCard({
      id: 'tasks_' + chatId, ownerId: chatId, chatId, kind: 'tasks',
      data: JSON.stringify({ items: [] }), now: D.now(),
    });
  }

  async function modify(chatId, change, expectedVersion = null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await board(chatId);
      if (expectedVersion !== null && current.version !== expectedVersion) return { ok: false, current };
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
    const agent = await D.superagent.taskSummary(chatId);
    return {
      kind: 'agent', title: '🤖 Серверный Superagent',
      lines: [
        'Проект: ' + agent.repo,
        agent.issue ? 'Последняя задача: #' + agent.issue + ' · ' + agent.status : 'По этому проекту ещё нет поручений.',
        'Можно писать: «Сделай ревью», «Исправляй», «Запусти тесты».',
      ],
      actions: [
        [{ text: '📁 Сменить проект', callback_data: 'ui:agent_action:pick' }],
        [{ text: '🔎 Ревью', callback_data: 'ui:agent_action:review' }, { text: '🛠 Исправить', callback_data: 'ui:agent_action:fix' }],
        [{ text: '📊 Статус', callback_data: 'ui:agent_action:status' }, { text: '⬅️ Панель', callback_data: 'ui:home' }],
        ...(agent.issue ? [[{ text: '📋 GitHub Issue #' + agent.issue, url: 'https://github.com/grunvald91/Ai_growth_os/issues/' + agent.issue }]] : []),
      ],
    };
  }

  /** 10.4's per-message chat_data and answers are both max 1024 UTF-8 bytes. */
  async function widgetState(chatId, kind = 'home', page = 0, note = '') {
    const saved = await board(chatId);
    const items = taskItems(saved);
    const done = items.filter((x) => x.done).length;
    const state = { k: kind, v: saved.version, n: items.length, d: done };
    if (kind === 'home') {
      state.m = (await store.listMemories(['owner'])).length;
    } else if (kind === 'tasks') {
      const size = 6;
      const pages = Math.max(1, Math.ceil(items.length / size));
      const p = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
      state.page = p;
      state.pages = pages;
      state.rev = saved.version;
      state.items = items.slice(p * size, (p + 1) * size)
        .map((item, n) => ({ i: p * size + n, t: truncate(item.text, 55), d: item.done ? 1 : 0 }));
    } else if (kind === 'memory') {
      const facts = await store.listMemories(['owner', 'biz']);
      state.m = facts.length;
      state.facts = facts.slice(-4).map((f) => f.id + '. ' + truncate(f.text, 65));
    } else if (kind === 'agent') {
      const task = await D.superagent.taskSummary(chatId);
      state.agent = { repo: truncate(task.repo.split('/').pop(), 40), issue: task.issue ?? 0, status: truncate(task.status, 32) };
    } else {
      state.info = kind === 'calendar'
        ? 'Google Calendar ещё не подключён. Действия и события не выдумываются.'
        : kind === 'routes'
          ? 'Поездку можно найти обычным запросом боту. Сохранение маршрутов в панели ещё не подключено.'
          : '/agent задание — управление агентом. Мониторинг поручений в этой карточке пока не подключён.';
    }
    if (note) state.note = truncate(note, 65);
    // Telegram counts UTF-8 bytes, not JavaScript string.length.
    let json = JSON.stringify(state);
    if (utf8Encode(json).length > 1000 && state.items) {
      state.items.forEach((item) => { item.t = truncate(item.t, 24); });
      json = JSON.stringify(state);
    }
    if (utf8Encode(json).length > 1000 && state.facts) {
      state.facts = state.facts.slice(-2).map((x) => truncate(x, 35));
      json = JSON.stringify(state);
    }
    if (utf8Encode(json).length > 1024) throw new Error('widget chat_data exceeds 1024 bytes');
    return json;
  }

  /** A supported sendWidget method is not enough: the webhook must also
   * receive widget_query, otherwise all controls time out. Fail closed.
   */
  async function widgetDeliveryReady(chatId) {
    if (D.cfg?.widgetsEnabled === false) return false;
    if (D.now() - deliveryCheckedAt < 60) return deliveryAvailable;
    deliveryCheckedAt = D.now();
    deliveryAvailable = false;
    try {
      const info = await out.call('getWebhookInfo', {});
      const updates = info?.allowed_updates;
      deliveryAvailable = Array.isArray(updates) &&
        ['widget_query', 'shared_widget_query'].every((name) => updates.includes(name));
      if (!deliveryAvailable) await D.log('widget_webhook_not_ready', chatId, {
        allowed: Array.isArray(updates) ? updates.filter((x) => /widget_query/.test(x)) : null,
      });
    } catch (e) {
      await D.log('widget_webhook_probe_failed', chatId, {
        reason: String(e?.description ?? e?.message ?? e).slice(0, 160),
      });
    }
    return deliveryAvailable;
  }

  async function trySendWidget(chatId, kind, page) {
    if (!(await widgetDeliveryReady(chatId))) return false;
    try {
      const sent = await out.call('sendWidget', {
        chat_id: chatId, html: ASSISTANT_WIDGET_HTML,
        width: 320, height: 0, allow_queries: true,
        chat_data: await widgetState(chatId, kind, page),
        caption: 'My AI Assistant · Если виджет не виден: /panel_text',
      });
      if (!sent || !Number.isSafeInteger(sent.message_id)) throw new Error('sendWidget did not return a message_id');
      return true;
    } catch (e) {
      await D.log('widget_send_fallback', chatId, {
        code: e?.code ?? null,
        reason: String(e?.description ?? e?.message ?? e).slice(0, 180),
      });
      return false;
    }
  }

  /** Called from the serverless widget_query handler, not callback_query. */
  async function widgetQuery(q) {
    if (!q?.id) return;
    const answer = async (data) => {
      const args = { widget_query_id: q.id };
      if (data !== undefined) args.data = data;
      return out.call('answerWidgetQuery', args);
    };
    const safeAnswer = async (data) => {
      try { await answer(data); }
      catch (e) {
        await D.log('widget_answer_failed', q.chat?.id ?? null, {
          code: e?.code ?? null,
          reason: String(e?.description ?? e?.message ?? e).slice(0, 150),
        });
      }
    };
    if (!q.chat || q.chat.type !== 'private' ||
        !Number.isSafeInteger(q.message_id) ||
        q.chat.id !== q.from?.id || !D.isOwner(q.from?.id)) {
      return safeAnswer();
    }

    const chatId = q.chat.id;
    let kind = 'home';
    let page = 0;
    let note = '';
    let addPrompt = false;
    let agentAction = null;
    const parts = String(q.data ?? '').split(':');
    try {
      if (parts[0] !== 'w') return safeAnswer();
      const action = parts[1];
      if (['home', 'memory', 'calendar', 'routes', 'agent'].includes(action) && parts.length === 2) {
        kind = action;
      } else if (action === 'tasks' && parts.length === 3 && /^\d{1,3}$/.test(parts[2])) {
        kind = 'tasks';
        page = Number(parts[2]);
      } else if (action === 'sync' && parts.length === 4 &&
        ['home', 'tasks', 'memory', 'calendar', 'routes', 'agent'].includes(parts[2]) &&
        /^\d{1,3}$/.test(parts[3])) {
        kind = parts[2];
        page = Number(parts[3]);
      } else if (action === 'agent_action' && parts.length === 3 && ['pick', 'review', 'fix', 'status'].includes(parts[2])) {
        kind = 'agent';
        agentAction = parts[2];
        note = 'Команда принята, подробности придут сообщением в чат.';
      } else if (action === 'add' && parts.length === 2) {
        kind = 'tasks';
        await store.setState(chatId, 'ui_add_task');
        addPrompt = true;
        note = 'Жду название задачи отдельным сообщением.';
      } else if (action === 'toggle' && parts.length === 5 &&
        /^\d{1,10}$/.test(parts[2]) && /^\d{1,3}$/.test(parts[3]) && /^\d{1,3}$/.test(parts[4])) {
        kind = 'tasks';
        const revision = Number(parts[2]);
        const index = Number(parts[3]);
        page = Number(parts[4]);
        if (index < page * 6 || index >= (page + 1) * 6) {
          note = 'Устаревшая карточка — обновлена.';
        } else {
          const changed = await modify(chatId, (items) => {
            if (index >= items.length) return null;
            items[index] = { ...items[index], done: !items[index].done };
            return items;
          }, revision);
          if (!changed.ok) note = 'Карточка обновилась — попробуй ещё раз.';
        }
      } else return safeAnswer();

      const data = await widgetState(chatId, kind, page, note);
      // Resolve the short-lived widget query first. Message-state edits are
      // separately best-effort and must not make a successful mutation timeout.
      await safeAnswer(data);
      try {
        await out.call('editMessageWidgetData', {
          chat_id: chatId, message_id: q.message_id, chat_data: data,
        });
      } catch (e) {
        if (!/not modified/i.test(String(e?.description ?? e?.message ?? e))) {
          await D.log('widget_edit_fail', chatId, { code: e?.code ?? null,
            reason: String(e?.description ?? e?.message ?? e).slice(0, 140) });
        }
      }
      if (agentAction) {
        try { await agentOperation(chatId, agentAction); }
        catch (e) { await D.log('widget_agent_action_failed', chatId, { action: agentAction, reason: String(e?.message ?? e).slice(0, 120) }); }
      }
      if (addPrompt) {
        try {
          await out.sendHtml(chatId, '➕ Напиши название задачи следующим сообщением. Отмена: /cancel');
        } catch (e) {
          await D.log('widget_add_prompt_fail', chatId, { reason: String(e?.message ?? e).slice(0, 140) });
        }
      }
    } catch (e) {
      await D.log('widget_query_fail', chatId, { reason: String(e?.message ?? e).slice(0, 150) });
      return safeAnswer(); // Never leave a valid query waiting for 15 seconds.
    }
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
    if (await trySendWidget(chatId, kind, page)) return true;
    await out.sendHtml(chatId, html, { reply_markup: markup });
    return true;
  }

  async function command(chatId, cmd, arg = '') {
    if (cmd === 'panel') return show(chatId, 'home');
    if (cmd === 'panel_text') {
      const rendered = renderTelegramCard(await cardFor(chatId, 'home'));
      await out.sendHtml(chatId, rendered.html, { reply_markup: rendered.markup });
      return true;
    }
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

  async function agentOperation(chatId, action) {
    if (action === 'pick') return D.code.showGh(chatId);
    if (action === 'review') return D.superagent.command(chatId, 'Сделай ревью кода');
    if (action === 'fix') return D.superagent.command(chatId, 'Исправляй');
    if (action === 'status') return D.superagent.status(chatId);
    return false;
  }

  async function callback(cq, parts) {
    const chatId = cq.message.chat.id;
    if (cq.message.chat.type !== 'private' || cq.from?.id !== chatId) {
      await out.answerCb(cq.id, 'Панель доступна только в личном чате', true);
      return true;
    }
    const [action, revision, index, page] = parts;
    const id = cq.message.message_id;
    if (action === 'agent_action') {
      await out.answerCb(cq.id);
      if (!['pick', 'review', 'fix', 'status'].includes(revision)) return true;
      await agentOperation(chatId, revision);
      return true;
    }
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
      }, Number(revision));
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

  return { show, command, callback, onState, widgetQuery, widgetState };
}
