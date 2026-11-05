// superagent.js — поручения DeepSeek Superagent прямо из личного Telegram-чата.
// GitHub Issue — внутренняя очередь; пользователю не нужен GitHub Actions UI.
// Текущая версия Superagent принимает задания только в Ai_growth_os.
import { escapeHtml, truncate } from './util.js';
import { findSecrets } from './codeparse.js';

export const AGENT_REPO = 'grunvald91/Ai_growth_os';
export const AGENT_ACCOUNT = 'Grunvald1991';
const WATCH_WORKFLOW = 'superagent-watch.yml';
const ACK_MARKER = /<!--\s*dsh-superagent:[\da-f]+\s*-->/i;
const WORK_VERBS = /исправ|поправ|добав|внес[иь]|созда|сдела|реализ|передела|перепиш|измени|изменит|обнов|сверста|настрой|интегрир|подготов[ьи]|закоммит|открой\s+(?:pr|pull request)|сделай\s+(?:pr|pull request)/i;

export function parseAgentRequest(text) {
  const source = String(text ?? '').trim();
  let m = /^(?:поручи|передай|отправь|дай)\s+(?:(?:это|такую|новую)\s+)?(?:(?:задачу|задание|работу)\s+)?(?:моему\s+)?(?:код(?:овому)?\s+)?(?:агенту|суперагенту|deepseek(?:[-\s]?агенту)?|superagent)\s*[,.:—–-]?\s*/i.exec(source);
  if (!m) m = /^(?:агент|суперагент|deepseek[-\s]?агент|superagent)\s*[,.:—–-]\s*/i.exec(source);
  if (!m) m = /^запусти\s+(?:моего\s+)?(?:агента|суперагента|superagent)(?:\s+(?:с\s+заданием|на\s+задачу))?\s*[,.:—–-]?\s*/i.exec(source);
  return m ? source.slice(m[0].length).trim() : null;
}

export function agentTaskType(text) {
  return WORK_VERBS.test(text) ? 'code-change' : 'report-only';
}

function unsupportedRepository(text) {
  const links = [...String(text).matchAll(/(?:https?:\/\/github\.com\/)?(grunvald91\/[a-z0-9_.-]+)/gi)];
  return links.some((m) => m[1].toLowerCase() !== AGENT_REPO.toLowerCase());
}

function resultComment(comments) {
  return (comments ?? []).find((c) =>
    String(c?.user?.login ?? '').toLowerCase() === AGENT_ACCOUNT.toLowerCase() &&
    !!String(c?.body ?? '').trim() && !ACK_MARKER.test(String(c.body))
  ) ?? null;
}

export function createSuperagent(D) {
  const { store, out } = D;
  const keyFor = (issue) => 'agent:issue:' + issue;
  const urlFor = (issue) => 'https://github.com/' + AGENT_REPO + '/issues/' + issue;
  const gh = () => D.github;

  async function task(chatId, raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
      await store.setState(chatId, 'agent_task');
      await out.sendHtml(chatId, '🛠 <b>Что поручить агенту?</b>\nПросто напиши задачу следующим сообщением. Я сам передам её, а результат верну сюда.\nПока агент работает с <code>Ai_growth_os</code>.');
      return true;
    }
    if (/^(?:статус|status|проверить|проверь)$/i.test(text)) return status(chatId);
    if (!gh() || !D.selfRepo) {
      await out.sendHtml(chatId, '⚠️ GitHub не подключён к боту. Проверю настройку токена GH_PAT после деплоя.');
      return true;
    }
    if (text.length > 6000) {
      await out.sendHtml(chatId, 'Задание превышает 6000 символов — пришли более короткую формулировку.');
      return true;
    }
    if (unsupportedRepository(text)) {
      await out.sendHtml(chatId, '⚠️ Сейчас Superagent принимает задачи только для <code>grunvald91/Ai_growth_os</code>. Другой репозиторий не буду подменять им.');
      return true;
    }
    if (findSecrets(text).length) {
      await out.sendHtml(chatId, '🔒 В задании обнаружен ключ или токен. Не отправляю его в публичный GitHub Issue. Убери секрет и повтори.');
      return true;
    }
    const type = agentTaskType(text);
    const title = '[Telegram] ' + truncate(text.replace(/\s+/g, ' ').split(/[.!?\n]/)[0], 135);
    const body = [
      '@' + AGENT_ACCOUNT,
      '',
      '## Задание от владельца через My AI Assistant',
      '',
      text,
      '',
      '## Правила исполнения',
      '',
      type === 'report-only'
        ? 'Только чтение, анализ и отчёт комментарием в этом Issue. Не менять код или файлы, не создавать PR, не запускать деплой.'
        : 'Разрешены изменения файлов только в отдельной ветке с Pull Request. Не сливать PR в main, не запускать деплой, не менять production, секреты и пользовательские данные. Отправить ссылку на PR в этом Issue.',
      '',
      'Задача передана автоматически из личного Telegram-чата владельца.',
    ].join('\n');

    // Одно создание Issue: не повторяем POST при сетевой ошибке во избежание дублей.
    let issue;
    try {
      issue = await gh().createIssue(AGENT_REPO, { title, body });
    } catch (e) {
      await out.sendHtml(chatId, '⚠️ Не получилось передать задание агенту: ' + escapeHtml(e?.userMessage ?? 'ошибка GitHub') + '.');
      return true;
    }
    const number = Number(issue?.number);
    if (!Number.isSafeInteger(number) || number <= 0) {
      await out.sendHtml(chatId, '⚠️ GitHub принял запрос, но не вернул номер Issue. Не отправляю повторно, чтобы не создать дубль.');
      return true;
    }
    await store.setSetting(keyFor(number), JSON.stringify({ chatId, title, type, status: 'sent', at: D.now() }));
    await store.setSetting('agent:last:' + chatId, String(number));
    const link = urlFor(number);
    let tracking = true;
    try {
      await gh().dispatch(D.selfRepo, WATCH_WORKFLOW, 'main', { issue: String(number), chat_id: String(chatId) });
    } catch (e) {
      tracking = false;
      await D.log?.('superagent_watch_error', chatId, { issue: number, reason: String(e?.kind ?? 'error') });
    }
    await D.log?.('superagent_sent', chatId, { issue: number, type });
    await out.sendHtml(chatId,
      '✅ <b>Передал задачу агенту.</b>\n' +
      'Проект: <code>Ai_growth_os</code>\n' +
      'Режим: ' + (type === 'report-only' ? 'проверка и отчёт' : 'изменения через PR') + '\n' +
      '<a href="' + link + '">Открыть задачу #' + number + '</a>\n\n' +
      (tracking ? 'Результат пришлю сюда, когда агент закончит.' :
        '⚠️ Автоуведомление не запустилось; задача у агента уже есть. Узнать результат: /agent статус.')
    );
    return true;
  }

  async function deliver({ issue, commentId = null, timeout = false }) {
    const n = Number(issue);
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    const stored = await store.getSetting(keyFor(n));
    if (!stored) return false; // Не уведомляем о задачах, которых бот не создавал.
    let state;
    try { state = JSON.parse(stored); } catch { return false; }
    const chatId = Number(state.chatId);
    if (!D.isOwner(chatId)) return false;
    if (state.status === 'done') return true;

    if (timeout) {
      if (state.status !== 'timeout') {
        await out.sendHtml(chatId, '⏳ <b>Superagent всё ещё работает над задачей #' + n + '.</b>\n<a href="' + urlFor(n) + '">Посмотреть состояние</a>. Чтобы проверить позже, напиши <code>/agent статус</code>.');
        await store.setSetting(keyFor(n), JSON.stringify({ ...state, status: 'timeout' }));
      }
      return true;
    }
    const comments = await gh().listIssueComments(AGENT_REPO, n);
    let found = resultComment(comments);
    if (commentId != null) found = found && String(found.id) === String(commentId) ? found : null;
    if (!found) return false;
    const report = truncate(String(found.body).replace(/<!--[\s\S]*?-->/g, '').trim(), 3000);
    await out.sendHtml(chatId,
      '✅ <b>Агент ответил по задаче #' + n + '.</b>\n\n' +
      escapeHtml(report) + '\n\n' +
      '<a href="' + urlFor(n) + '">Полный отчёт, обсуждение и PR</a>'
    );
    await store.setSetting(keyFor(n), JSON.stringify({ ...state, status: 'done', commentId: found.id }));
    await D.log?.('superagent_completed', chatId, { issue: n, commentId: found.id });
    return true;
  }

  async function status(chatId) {
    const last = Number(await store.getSetting('agent:last:' + chatId));
    if (!last) {
      await out.sendHtml(chatId, 'Пока нет отправленных задач. Напиши <code>/agent задача</code> или «Поручи агенту ...».');
      return true;
    }
    try {
      if (await deliver({ issue: last })) return true;
    } catch (e) {
      await D.log?.('superagent_status_error', chatId, { issue: last, reason: String(e?.kind ?? 'error') });
    }
    const stored = await store.getSetting(keyFor(last));
    let state = {};
    try { state = JSON.parse(stored ?? '{}'); } catch { /* ignore */ }
    await out.sendHtml(chatId,
      '🕓 <b>Задача #' + last + ' в работе.</b>\n' +
      escapeHtml(String(state.title ?? '')) + '\n' +
      '<a href="' + urlFor(last) + '">GitHub Issue</a>'
    );
    return true;
  }

  async function maybeAutoTask(chat, text) {
    const content = parseAgentRequest(text);
    if (content === null) return false;
    await task(chat.chatId, content);
    return true;
  }

  async function onState(msg, chat) {
    await store.setState(chat.chatId, null);
    return task(chat.chatId, msg.text);
  }

  return { command: task, maybeAutoTask, onState, deliver, status };
}
