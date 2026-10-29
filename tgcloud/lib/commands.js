// commands.js — команды владельца и их кнопки: /model, /memory, /group, /usage, /limit, /export и др.
// Все команды доступны только владельцу (проверка в app.js). В группах работает короткий список.

import { COMMANDS_VERSION, OWNER_COMMANDS, PUBLIC_COMMANDS, GROUP_COMMANDS, GROUP_MODES, THINK_LEVELS } from './config.js';
import { PROVIDER_ORDER, priceLabel } from './models.js';
import { dayKey, monthKey, escapeHtml, truncate, utf8Encode } from './util.js';

const GROUP_OK = new Set(['model', 'memory', 'remember', 'forget', 'reset', 'group', 'draft', 'cancel', 'id', 'help']);
const MODE_TEXT = {
  off: '⚫ выкл — молчу',
  mention: '🟡 по запросу — отвечаю, когда меня упомянули, ответили мне или написали /ask',
  all: '🟢 на все сообщения — отвечаю на каждое',
};
const MODE_SHORT = { off: '⚫ Выкл', mention: '🟡 По запросу', all: '🟢 На все' };

const THINK_TEXT = { off: '⚪ Выкл', low: '🟢 Низкий', medium: '🟡 Средний', high: '🔴 Высокий' };
const THINK_LABEL = { off: 'Выкл', low: 'Низкий', medium: 'Средний', high: 'Высокий' };
const THINK_ALIAS = { off: 'off', выкл: 'off', 'выключить': 'off', нет: 'off', low: 'low', низкий: 'low', medium: 'medium', средний: 'medium', high: 'high', высокий: 'high' };

const kb = (rows) => ({ inline_keyboard: rows });
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const usd = (n) => '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2));

/** "500k" → 500000, "1.5m" → 1500000, "250000" → 250000. */
export function parseAmount(s) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([kкmм])?\s*$/i.exec(String(s ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const mult = !m[2] ? 1 : /[kк]/i.test(m[2]) ? 1e3 : 1e6;
  return Math.round(n * mult);
}

export function createCommands(D, mods) {
  const { store, out, core, cfg, llm } = D;
  const { business, posts, replies, code } = mods;

  const HELP =
    '🤖 <b>Я твой ИИ-помощник</b> — работаю на результат: чем больше зарабатываешь ты, тем лучше для нас обоих. Помогаю с деньгами, текстами, перепиской и всем остальным.\n\n' +
    '<b>Просто пиши</b> — отвечу. Ответ приходит «набегающим» текстом; кнопка «Стоп» останавливает его.\n\n' +
    '<b>Основное</b>\n' +
    '/model — выбрать модель ИИ\n' +
    '/think — уровень размышлений: выкл / низкий / средний / высокий\n' +
    '/auto — автоподбор модели: простые вопросы отвечает быстрая дешёвая, сложные — выбранная\n' +
    '/search — поиск в интернете (Exa): бот сам решает, когда он нужен\n' +
    '/bg — тяжёлые модели (Opus) отвечают в фоне, без лимита 30 секунд\n' +
    '/post — пост в канал (пришли фото и описание)\n' +
    '📎 Пришли фото или файл (PDF, Word, Excel, PowerPoint, текст, код) с вопросом в подписи — разберу. Без подписи — напиши вопрос следом. Для поста: подпись со словом «пост».\n' +
    '/channels — каналы и их стиль\n' +
    '/group — как отвечать в группах: выкл / по запросу / на все\n' +
    '/business — ответы от моего имени в личке (Telegram Business)\n' +
    '/gh · /repo · /code — писать код и пушить в твои репозитории (кроме бота)\n' +
    '/runs — GitHub Actions: последние запуски и кнопка Run workflow\n\n' +
    '<b>Память</b>\n' +
    '/memory — что я помню · /remember текст · /forget номер\n' +
    '/remember_biz текст — факт для ответов собеседникам (цены, условия)\n' +
    '/reset — очистить историю чата · /forget_all — стереть всё\n\n' +
    '<b>Контроль</b>\n' +
    '/usage — расход и баланс · /limit — дневной лимит\n' +
    '/stop и /resume — пауза в группах и Business · /export — выгрузка данных\n\n' +
    '<b>В группе</b>\n' +
    'Ответь на сообщение командой /draft — подготовлю тебе черновик ответа за тебя. Участники могут спросить меня через @упоминание, ответ на моё сообщение или /ask.';

  // ───────── служебное ─────────

  /** Один раз на версию списка обновляет меню команд в Telegram. */
  async function ensureCommands() {
    const cur = await store.getSetting('commands_version');
    if (String(cur) === String(COMMANDS_VERSION)) return;
    const toList = (a) => a.map(([command, description]) => ({ command, description }));
    try {
      await D.api.setMyCommands({ commands: toList(PUBLIC_COMMANDS) });
      await D.api.setMyCommands({ commands: toList(GROUP_COMMANDS), scope: { type: 'all_group_chats' } });
      for (const id of D.ownerIds) {
        await D.api.setMyCommands({ commands: toList(OWNER_COMMANDS), scope: { type: 'chat', chat_id: id } });
      }
      await store.setSetting('commands_version', COMMANDS_VERSION);
    } catch (e) {
      console.warn('setMyCommands failed', e?.message ?? e); // не критично: попробуем при следующем апдейте
    }
  }

  // ───────── роутер команд ─────────

  /** true — команда обработана (в т.ч. отказом). */
  async function run(cmd, arg, msg, chat) {
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    if (!isPrivate && !GROUP_OK.has(cmd)) {
      await out.sendHtml(chatId, 'Эта команда работает в личном чате со мной.');
      return true;
    }
    switch (cmd) {
      case 'start':
      case 'help':
        await out.sendHtml(chatId, HELP);
        return true;
      case 'id':
        await out.sendHtml(chatId, `Твой Telegram ID: <code>${msg.from?.id}</code>\nID этого чата: <code>${chatId}</code>`);
        return true;
      case 'cancel':
        await store.setState(chatId, null);
        await out.sendHtml(chatId, 'Отменено.');
        return true;
      case 'model':
        return model(msg, chat, arg);
      case 'think':
        return think(chatId, arg);
      case 'auto':
        return auto(chatId, arg);
      case 'bg':
        return D.bg.command(chatId, arg);
      case 'search':
        return D.exa.command(chatId, arg);
      case 'memory':
        return memory(msg);
      case 'remember':
        return remember(msg, arg, isPrivate ? 'owner' : 'group:' + chatId);
      case 'remember_biz':
        return remember(msg, arg, 'biz');
      case 'forget':
        return forget(msg, arg);
      case 'reset':
        await resetContext(chatId);
        await out.sendHtml(chatId, '🧹 История этого чата очищена. Факты (/memory) остались.');
        return true;
      case 'forget_all':
        await out.sendHtml(chatId, '⚠️ Стереть <b>всю</b> память: историю всех чатов, сводки и факты? Каналы, их стили и настройки останутся. Это нельзя отменить.', {
          reply_markup: kb([[{ text: '🗑 Да, стереть', callback_data: 'fa:y', style: 'danger' }, { text: 'Отмена', callback_data: 'fa:n' }]]),
        });
        return true;
      case 'group':
        return isPrivate ? groupList(chatId) : groupPanel(chatId, chatId);
      case 'draft':
        await replies.start(msg, chat, arg);
        return true;
      case 'business':
        await business.showSettings(chatId);
        return true;
      case 'gh':
        await code.showGh(chatId);
        return true;
      case 'repo':
        if (!arg) await code.showGh(chatId);
        else await code.setRepo(chatId, arg);
        return true;
      case 'runs':
        await code.runsCommand(chatId, arg);
        return true;
      case 'code':
        await code.startTask(chat, arg);
        return true;
      case 'post':
        await posts.startPost(chat, arg);
        return true;
      case 'channels':
        await posts.showChannels(chatId);
        return true;
      case 'usage':
        return usage(chatId);
      case 'limit':
        return limit(chatId, arg);
      case 'stop':
        await store.setSetting('paused', '1');
        await D.log('paused', chatId, {});
        await out.sendHtml(chatId, '⏸ Пауза. В группах и от твоего имени я молчу. С тобой в личке продолжаю общаться. Вернуть: /resume');
        return true;
      case 'resume':
        await store.setSetting('paused', null);
        await D.log('resumed', chatId, {});
        await out.sendHtml(chatId, '▶️ Снова в работе.');
        return true;
      case 'export':
        return exportData(chatId);
      default:
        return false;
    }
  }

  // ───────── /model ─────────

  async function modelHome(chatId, chat, editMsgId) {
    const models = await core.getModels();
    const cur = await core.resolveModel(chat);
    const isDefault = !chat?.model;
    const counts = new Map();
    for (const m of models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    const providers = PROVIDER_ORDER.filter((p) => counts.has(p));
    const html =
      `🧠 <b>Модель этого чата</b>: <code>${escapeHtml(cur.id)}</code>${isDefault ? ' (по умолчанию)' : ''}\n` +
      (cur.down ? '⚠️ Сервис сообщает, что эта модель сейчас недоступна.\n' : '') +
      `\nВсего моделей: ${models.length}. Выбери производителя:`;
    const rows = [];
    for (let i = 0; i < providers.length; i += 2) {
      rows.push(providers.slice(i, i + 2).map((p) => ({ text: `${p} (${counts.get(p)})`, callback_data: 'm:p:' + PROVIDER_ORDER.indexOf(p) })));
    }
    rows.push([{ text: '↩️ По умолчанию', callback_data: 'm:d' }, { text: '🔄 Обновить список', callback_data: 'm:u' }]);
    return show(chatId, editMsgId, html, kb(rows));
  }

  async function modelProvider(chatId, chat, provIdx, editMsgId) {
    const models = await core.getModels();
    const prov = PROVIDER_ORDER[provIdx];
    const cur = await core.resolveModel(chat);
    const rows = [];
    models.forEach((m, i) => {
      if (m.provider !== prov) return;
      const price = priceLabel(m);
      rows.push([{ text: truncate(`${m.id === cur.id ? '✅ ' : m.down ? '🔴 ' : ''}${m.name}${price ? ' · ' + price : ''}`, 60), callback_data: 'm:s:' + i }]);
    });
    rows.splice(30);
    rows.push([{ text: '⬅️ Назад', callback_data: 'm:b' }]);
    return show(chatId, editMsgId, `🧠 <b>${escapeHtml(prov)}</b> — выбери модель (цена за 1M токенов вход/выход, 🔴 — сейчас недоступна):`, kb(rows));
  }

  async function show(chatId, editMsgId, html, markup) {
    if (editMsgId) {
      try {
        await out.editHtml(chatId, editMsgId, html, markup);
        return true;
      } catch {
        /* сообщение не редактируется — пришлём новое */
      }
    }
    await out.sendHtml(chatId, html, { reply_markup: markup });
    return true;
  }

  async function model(msg, chat, arg) {
    const chatId = msg.chat.id;
    if (!arg) return modelHome(chatId, chat);
    const models = await core.getModels();
    const q = arg.trim().toLowerCase();
    const found = models.find((m) => m.id.toLowerCase() === q) ?? models.find((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (!found) {
      await out.sendHtml(chatId, `Не нашёл модель «${escapeHtml(arg)}». Список: /model`);
      return true;
    }
    await store.updateChat(chatId, { model: found.id });
    await out.sendHtml(chatId, `✅ Модель этого чата: <code>${escapeHtml(found.id)}</code>${found.down ? '\n⚠️ Сервис сообщает, что она сейчас недоступна.' : ''}`);
    return true;
  }

  /** История чата, сводка и прочитанный репозиторий — всё, что раздувает контекст. Факты (/memory) остаются. */
  async function resetContext(chatId) {
    await store.clearMessages(String(chatId));
    await store.updateChat(chatId, { summary: null, summaryUpto: 0 });
    await store.setSetting('repo_ctx', null);
  }

  // ───────── /think ─────────

  async function thinkPanel(chatId, editMsgId) {
    const level = await core.thinkLevel();
    const b = cfg.thinkBudgets;
    const model = await core.resolveModel(await store.getChat(chatId));
    const html =
      `🧠 <b>Уровень размышлений</b>: ${THINK_TEXT[level]}\n\n` +
      'Чем выше, тем дольше модель «думает» перед ответом: лучше для сложного кода и расчётов, но медленнее и дороже (размышления оплачиваются как обычные токены ответа).\n\n' +
      `Низкий — до ${fmtInt(b.low)} токенов на раздумья, средний — до ${fmtInt(b.medium)}, высокий — до ${fmtInt(b.high)}.\n` +
      'Действует в личном чате и в /code. В группах, постах и ответах за тебя размышления выключены — там важна скорость.\n\n' +
      (model.thinking
        ? `Текущая модель <code>${escapeHtml(model.id)}</code> размышления поддерживает.`
        : `⚠️ Текущая модель <code>${escapeHtml(model.id)}</code> размышления не поддерживает — уровень сработает на другой (/model).`);
    return show(chatId, editMsgId, html, kb([THINK_LEVELS.map((l) => ({ text: (l === level ? '● ' : '') + THINK_LABEL[l], callback_data: 't:' + l }))]));
  }

  async function think(chatId, arg) {
    if (!arg) {
      await thinkPanel(chatId);
      return true;
    }
    const level = THINK_ALIAS[arg.trim().toLowerCase()];
    if (!level) {
      await out.sendHtml(chatId, 'Уровни: выкл, низкий, средний, высокий. Например: <code>/think высокий</code> — или нажми кнопки: /think');
      return true;
    }
    await store.setSetting('think', level);
    await out.sendHtml(chatId, `🧠 Уровень размышлений: ${THINK_TEXT[level]}`);
    return true;
  }

  // ───────── /auto ─────────

  async function autoPanel(chatId, editMsgId) {
    const on = (await store.getSetting('auto')) === '1';
    const html =
      `⚡ <b>Автоподбор модели</b>: ${on ? '🟢 включён' : '⚪ выключен'}\n\n` +
      'Включён: на короткие простые вопросы («что такое…», «какая столица…») отвечает быстрая и дешёвая модель. ' +
      'Всё сложное — код, анализ, длинные просьбы, файлы и фото, а также когда включены размышления (/think) — отвечает модель, выбранная в /model.\n\n' +
      'Когда ответила быстрая, под ответом написано об этом, и есть кнопка «Ответить сильной» — повторит вопрос выбранной моделью.\n\n' +
      'Выключен: всегда отвечает выбранная модель.';
    return show(chatId, editMsgId, html, kb([[{ text: on ? '⚪ Выключить' : '🟢 Включить', callback_data: 'au:' + (on ? 'off' : 'on'), style: on ? undefined : 'success' }]]));
  }

  async function auto(chatId, arg) {
    const a = String(arg ?? '').trim().toLowerCase();
    if (!a) return autoPanel(chatId);
    if (['on', 'вкл', 'включить', 'да'].includes(a)) await store.setSetting('auto', '1');
    else if (['off', 'выкл', 'выключить', 'нет'].includes(a)) await store.setSetting('auto', null);
    else return out.sendHtml(chatId, 'Так: <code>/auto вкл</code> или <code>/auto выкл</code> — или нажми кнопки: /auto').then(() => true);
    return autoPanel(chatId);
  }

  // ───────── память ─────────

  async function memory(msg) {
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    const scopes = isPrivate ? ['owner', 'biz'] : ['group:' + chatId];
    const rows = await store.listMemories(scopes);
    if (!rows.length) {
      await out.sendHtml(
        chatId,
        isPrivate
          ? '🧠 Фактов пока нет. Добавь: /remember текст (для меня) или /remember_biz текст (для ответов собеседникам). Иногда я сам предложу запомнить что-то полезное.'
          : '🧠 Фактов этой группы пока нет. Добавь: /remember текст',
      );
      return true;
    }
    const label = { owner: '👤', biz: '💼' };
    const lines = rows.map((r) => `${label[r.scope] ?? '👥'} <b>${r.id}.</b> ${escapeHtml(truncate(r.text, 300))}`);
    const chunks = [];
    let cur = '';
    for (const l of lines) {
      if ((cur + '\n' + l).length > 3500) {
        chunks.push(cur);
        cur = l;
      } else cur = cur ? cur + '\n' + l : l;
    }
    chunks.push(cur);
    for (let i = 0; i < chunks.length; i++) {
      const head = i === 0 ? '🧠 <b>Что я помню</b>' + (isPrivate ? ' (👤 для меня, 💼 для ответов за тебя)' : '') + '\n\n' : '';
      const tail = i === chunks.length - 1 ? '\n\nУдалить: /forget номер' : '';
      await out.sendHtml(chatId, head + chunks[i] + tail);
    }
    return true;
  }

  async function remember(msg, arg, scope) {
    const chatId = msg.chat.id;
    const text = arg.replace(/\s+/g, ' ').trim();
    if (!text) {
      await out.sendHtml(chatId, 'Напиши факт после команды, например: <code>/remember мой канал про недвижимость, аудитория — инвесторы</code>');
      return true;
    }
    if (text.length > 500) {
      await out.sendHtml(chatId, 'Слишком длинно (больше 500 символов). Раздели на несколько фактов.');
      return true;
    }
    if ((await store.countMemories(scope)) >= cfg.memoryLimit) {
      await out.sendHtml(chatId, `Память заполнена (${cfg.memoryLimit} фактов). Удали ненужное: /memory → /forget номер`);
      return true;
    }
    await store.addMemory(scope, text, 'explicit', D.now());
    await out.sendHtml(chatId, scope === 'biz' ? '💾 Запомнил для ответов от твоего имени.' : '💾 Запомнил.');
    return true;
  }

  async function forget(msg, arg) {
    const chatId = msg.chat.id;
    const id = Number(arg.replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) {
      await out.sendHtml(chatId, 'Укажи номер факта из /memory, например: <code>/forget 12</code>');
      return true;
    }
    const ok = await store.deleteMemory(id);
    await out.sendHtml(chatId, ok ? '🗑 Забыл.' : 'Факта с таким номером нет.');
    return true;
  }

  // ───────── /group ─────────

  async function groupList(chatId) {
    const groups = await store.listGroupChats();
    if (!groups.length) {
      await out.sendHtml(
        chatId,
        '👥 Групп пока нет. Добавь меня в группу (я сам увижу это) — по умолчанию я там буду отвечать «по запросу».\n\nДля режима «на все сообщения» отключи у бота режим приватности: @BotFather → Bot Settings → Group Privacy → Turn off.',
      );
      return true;
    }
    const rows = groups.map((g) => [{ text: truncate(`${g.title ?? g.chatId} · ${MODE_SHORT[g.groupMode] ?? g.groupMode}`, 60), callback_data: 'g:o:' + g.chatId }]);
    await out.sendHtml(chatId, '👥 <b>Группы</b>. Выбери, чтобы настроить:', { reply_markup: kb(rows) });
    return true;
  }

  async function groupPanel(viewChatId, groupId, editMsgId) {
    const g = await store.getChat(groupId);
    if (!g) {
      await out.sendHtml(viewChatId, 'Такой группы нет в моём списке.');
      return true;
    }
    const mode = g.groupMode;
    const html =
      `👥 <b>${escapeHtml(g.title ?? String(g.chatId))}</b>\n\n` +
      `Режим: <b>${MODE_SHORT[mode] ?? mode}</b>\n` +
      GROUP_MODES.map((m) => `${m === mode ? '▶️' : '▫️'} ${MODE_TEXT[m]}`).join('\n') +
      '\n\n💡 Для режима «на все» у бота должен быть отключён режим приватности (@BotFather → Group Privacy → Turn off), иначе Telegram не покажет мне обычные сообщения.' +
      `\n\n🙈 Ответы только автору (эфемерные, бета): <b>${g.ephemeral ? 'да' : 'нет'}</b>` +
      `\n🔔 Копии ответов тебе в личку: <b>${g.notifyOwner ? 'да' : 'нет'}</b>`;
    const rows = [
      GROUP_MODES.map((m) => ({ text: (m === mode ? '● ' : '') + MODE_SHORT[m], callback_data: `g:m:${groupId}:${m}` })),
      [{ text: `🙈 Только автору: ${g.ephemeral ? 'вкл' : 'выкл'}`, callback_data: 'g:e:' + groupId }],
      [{ text: `🔔 Копии мне: ${g.notifyOwner ? 'вкл' : 'выкл'}`, callback_data: 'g:n:' + groupId }],
    ];
    if (viewChatId !== groupId) rows.push([{ text: '⬅️ К списку групп', callback_data: 'g:l' }]);
    return show(viewChatId, editMsgId, html, kb(rows));
  }

  // ───────── /usage /limit /export ─────────

  async function usage(chatId) {
    const t = D.now();
    const tz = core.tz();
    const today = await core.todayUsage();
    const month = await store.sumUsage(monthKey(t, tz));
    const limit = await core.dailyLimit();
    const used = today.tokensIn + today.tokensOut;
    const bal = await llm.balance();
    const html =
      `📊 <b>Расход</b>\n\n` +
      `<b>Сегодня</b>: ${fmtInt(today.requests)} запросов, ${fmtInt(used)} токенов (вход ${fmtInt(today.tokensIn)} / выход ${fmtInt(today.tokensOut)}), ≈ ${usd(today.costUsd)}\n` +
      `Дневной лимит: ${fmtInt(limit)} токенов — использовано ${Math.min(100, Math.round((used / limit) * 100))}%\n\n` +
      `<b>За месяц</b>: ${fmtInt(month.requests)} запросов, ${fmtInt(month.tokensIn + month.tokensOut)} токенов, ≈ ${usd(month.costUsd)}\n` +
      (bal ? `\n💳 <b>Баланс ClaudeHub</b>: ${fmtMoney(bal.balance)} ${escapeHtml(bal.currency === 'RUB' ? '₽' : bal.currency)}\n` : '') +
      '\n<i>Стоимость — оценка по прайсу моделей; точные списания смотри в кабинете ClaudeHub.</i>';
    await out.sendHtml(chatId, html);
    return true;
  }

  const fmtMoney = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  async function limit(chatId, arg) {
    const cur = await core.dailyLimit();
    if (!arg) {
      await out.sendHtml(chatId, `Дневной лимит: <b>${fmtInt(cur)}</b> токенов. Изменить: <code>/limit 800k</code>`);
      return true;
    }
    const n = parseAmount(arg);
    if (!n || n < 10000 || n > 100000000) {
      await out.sendHtml(chatId, 'Укажи число от 10 000 до 100 000 000, можно с «k» или «m»: <code>/limit 800k</code>');
      return true;
    }
    await store.setSetting('daily_limit', n);
    await out.sendHtml(chatId, `✅ Дневной лимит: ${fmtInt(n)} токенов.`);
    return true;
  }

  async function exportData(chatId) {
    const data = await store.exportAll();
    const json = JSON.stringify({ exportedAt: D.now(), ...data }, null, 2);
    const name = `assistant-export-${dayKey(D.now(), core.tz())}.json`;
    await D.api.sendDocument({
      chat_id: chatId,
      document: new D.InputFile(utf8Encode(json), name, { type: 'application/json' }),
      caption: '📦 Выгрузка данных: чаты, история, факты, каналы, черновики, расход, журнал.',
    });
    await D.log('export', chatId, { bytes: json.length });
    return true;
  }

  // ───────── кнопки ─────────

  async function callback(cq, parts) {
    const [kind, a, b, c] = parts;
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;

    if (kind === 'm') {
      const chat = await store.getChat(chatId);
      if (a === 'p') {
        await out.answerCb(cq.id);
        return modelProvider(chatId, chat, Number(b), msgId);
      }
      if (a === 'b') {
        await out.answerCb(cq.id);
        return modelHome(chatId, chat, msgId);
      }
      if (a === 'd') {
        await store.updateChat(chatId, { model: null });
        await out.answerCb(cq.id, 'Модель по умолчанию');
        return modelHome(chatId, await store.getChat(chatId), msgId);
      }
      if (a === 'u') {
        await core.getModels({ force: true });
        await out.answerCb(cq.id, 'Список обновлён');
        return modelHome(chatId, chat, msgId);
      }
      if (a === 's') {
        const models = await core.getModels();
        const m = models[Number(b)];
        if (!m) return out.answerCb(cq.id, 'Список изменился, открой /model заново', true);
        await store.updateChat(chatId, { model: m.id });
        await out.answerCb(cq.id, 'Выбрано: ' + truncate(m.name, 150));
        return modelProvider(chatId, await store.getChat(chatId), PROVIDER_ORDER.indexOf(m.provider), msgId);
      }
      return;
    }

    if (kind === 'rc') {
      // кнопки под ответом: rc:x — убрать репозиторий из контекста, rc:r — сбросить весь контекст
      if (a === 'r') await resetContext(chatId);
      else await store.setSetting('repo_ctx', null);
      await out.answerCb(cq.id, a === 'r' ? '🧹 Контекст сброшен' : '📦 Репозиторий убран из контекста');
      // убираем только свои кнопки; «💾 Запомнить» и прочее остаётся
      const rows = (cq.message.reply_markup?.inline_keyboard ?? []).filter((r) => !r.some((b) => String(b.callback_data).startsWith('rc:')));
      try {
        await out.call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } });
      } catch {
        /* сообщение могло устареть — не страшно */
      }
      return;
    }

    if (kind === 'au') {
      await store.setSetting('auto', a === 'on' ? '1' : null);
      await out.answerCb(cq.id, a === 'on' ? 'Включён' : 'Выключен');
      return autoPanel(chatId, msgId);
    }

    if (kind === 't') {
      if (!THINK_LEVELS.includes(a)) return out.answerCb(cq.id);
      await store.setSetting('think', a);
      await out.answerCb(cq.id, THINK_TEXT[a]);
      return thinkPanel(chatId, msgId);
    }

    if (kind === 'g') {
      if (a === 'l') {
        await out.answerCb(cq.id);
        const groups = await store.listGroupChats();
        const rows = groups.map((g) => [{ text: truncate(`${g.title ?? g.chatId} · ${MODE_SHORT[g.groupMode] ?? g.groupMode}`, 60), callback_data: 'g:o:' + g.chatId }]);
        return show(chatId, msgId, '👥 <b>Группы</b>. Выбери, чтобы настроить:', kb(rows));
      }
      const gid = Number(b);
      const g = await store.getChat(gid);
      if (!g || !['group', 'supergroup'].includes(g.type)) return out.answerCb(cq.id, 'Группа не найдена', true);
      if (a === 'leave') {
        await out.call('leaveChat', { chat_id: gid });
        await store.updateChat(gid, { groupMode: 'off' });
        await D.log('group_left_by_owner', gid, {});
        await out.answerCb(cq.id, 'Вышел из группы');
        await out.dropButtons(chatId, msgId);
        await out.sendHtml(chatId, `🚪 Я вышел из группы «${escapeHtml(g.title ?? String(gid))}».`);
        return;
      }
      if (a === 'o') {
        await out.answerCb(cq.id);
        return groupPanel(chatId, gid, msgId);
      }
      if (a === 'm') {
        if (!GROUP_MODES.includes(c)) return out.answerCb(cq.id);
        await store.updateChat(gid, { groupMode: c });
        await D.log('group_mode', gid, { mode: c });
        await out.answerCb(cq.id, MODE_SHORT[c]);
        return groupPanel(chatId, gid, msgId);
      }
      if (a === 'e') {
        await store.updateChat(gid, { ephemeral: !g.ephemeral });
        await out.answerCb(cq.id, !g.ephemeral ? 'Отвечаю только автору' : 'Отвечаю всем');
        return groupPanel(chatId, gid, msgId);
      }
      if (a === 'n') {
        await store.updateChat(gid, { notifyOwner: !g.notifyOwner });
        await out.answerCb(cq.id, !g.notifyOwner ? 'Буду присылать копии' : 'Копии выключены');
        return groupPanel(chatId, gid, msgId);
      }
      return;
    }

    if (kind === 'mem') {
      // mem:y:<id> / mem:n:<id> — предложение бота «запомнить?»
      const p = await store.takeProposal(b);
      await out.dropButtons(chatId, msgId);
      if (!p) return out.answerCb(cq.id, 'Предложение устарело', true);
      if (a === 'y') {
        if ((await store.countMemories(p.scope)) >= cfg.memoryLimit) return out.answerCb(cq.id, 'Память заполнена, удали лишнее: /memory', true);
        await store.addMemory(p.scope, p.text, 'confirmed', D.now());
        return out.answerCb(cq.id, '💾 Запомнил');
      }
      return out.answerCb(cq.id, 'Ок, не запоминаю');
    }

    if (kind === 'fa') {
      await out.dropButtons(chatId, msgId);
      if (a === 'y') {
        await store.wipeMemory();
        await D.log('forget_all', chatId, {});
        await out.answerCb(cq.id, 'Стёрто');
        await out.sendHtml(chatId, '🗑 Вся память стёрта: история, сводки и факты.');
      } else {
        await out.answerCb(cq.id, 'Отменено');
      }
    }
  }

  return { run, callback, ensureCommands, HELP };
}
