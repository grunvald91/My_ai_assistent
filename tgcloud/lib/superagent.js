// superagent.js — поручения DeepSeek Superagent прямо из личного Telegram-чата.
// GitHub Issue — внутренняя очередь; пользователю не нужен GitHub Actions UI.
// Центральная очередь Issue остаётся в Ai_growth_os; рабочий репозиторий выбирается для каждого задания.
import { escapeHtml, truncate } from './util.js';
import { findSecrets } from './codeparse.js';
import { finalAgentComment, parseTerminalResult } from './superagent-result.js';

export const AGENT_REPO = 'grunvald91/Ai_growth_os';
export const AGENT_ACCOUNT = 'Grunvald1991';
const WATCH_WORKFLOW = 'superagent-watch.yml';
// Only explicitly terminal messages may complete Telegram tracking. Native DSH markers occur on EVERY reply.
const STATUS_CONTEXT = 'superagent/multirepo-ready';
const STATUS_DESCRIPTION = 'superagent-multirepo-v2';
const STATUS_MAX_AGE_S = 10 * 60;
const ROUTE_MARKER = 'superagent-route:v1';
const AGENT_REPO_ALIASES = {
  bookingbot: 'booking_bot', booking_bot: 'booking_bot',
  aigrowthos: 'Ai_growth_os', ai_growth_os: 'Ai_growth_os',
  smena: 'SMENA', sushef: 'Sushef', flightbot: 'flight_bot', flight_bot: 'flight_bot',
};
const GITHUB_URL = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?=[/?#\s]|$)/gi;
const REPO_REFERENCE = /(?:^|[^\w./-])(grunvald91\/[A-Za-z0-9._-]+)(?=[^\w./-]|$)/gi;
const REPO_NAME = /^grunvald91\/[A-Za-z0-9._-]+$/i;
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

export function extractTargetPull(body, target) {
  const refs = [...String(body ?? '').matchAll(/https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)(?=[/?#\s]|$)/gi)];
  const selected = refs.find(m => (m[1] + '/' + m[2]).toLowerCase() === String(target).toLowerCase());
  return selected ? { repo: target, number: Number(selected[3]) } : null;
}

/** Explicit repo reference wins over chat default; ambiguous multi-repo requests fail closed. */
export function requestedAgentRepository(text) {
  const source = String(text ?? '');
  const refs = [];
  // Collect every GitHub URL, not only our own account; foreign owners must never silently fall back.
  for (const match of source.matchAll(GITHUB_URL)) {
    const owner = match[1], name = match[2];
    if (owner.toLowerCase() !== 'grunvald91') return { repo: null, ambiguous: false, unsupported: true };
    refs.push(owner + '/' + name);
  }
  for (const match of source.matchAll(REPO_REFERENCE)) refs.push(match[1]);
  const short = /(?:^|\s)(?:в|для|репозитории|репозитория|repo)\s+(?:репозитории\s+)?([A-Za-z][A-Za-z0-9_-]*)\b/i.exec(source)?.[1]?.toLowerCase();
  if (short && AGENT_REPO_ALIASES[short]) refs.push('grunvald91/' + AGENT_REPO_ALIASES[short]);
  const distinct = [...new Map(refs.map(name => [name.toLowerCase(), name])).values()];
  return { repo: distinct.length === 1 ? distinct[0] : null, ambiguous: distinct.length > 1 };
}

function permittedTarget(repo) {
  return REPO_NAME.test(repo) && repo.toLowerCase() !== 'grunvald91/my_ai_assistent';
}


export function createSuperagent(D) {
  const { store, out } = D;
  const keyFor = (issue) => 'agent:issue:' + issue;
  const selectedKey = (chatId) => 'agent:repo:' + chatId; 
  async function remoteReady() {
    // GitHub status is posted by the VPS itself after verifying DSH live settings.
    // A static Telegram flag or a stale status is NOT sufficient.
    const statuses = await gh().listCommitStatuses(AGENT_REPO, 'main');
    const latest = (Array.isArray(statuses) ? statuses : [])
      .filter(s => s?.context === STATUS_CONTEXT)
      .sort((a, b) => Date.parse(b?.created_at ?? '') - Date.parse(a?.created_at ?? ''))[0];
    if (!latest) return false;
    const age = D.now() - Date.parse(latest?.created_at ?? '') / 1000;
    return latest.state === 'success' && latest.description === STATUS_DESCRIPTION &&
      String(latest?.creator?.login ?? '').toLowerCase() === AGENT_ACCOUNT.toLowerCase() &&
      Number.isFinite(age) && age >= 0 && age <= STATUS_MAX_AGE_S;
  }
  const urlFor = (issue) => 'https://github.com/' + AGENT_REPO + '/issues/' + issue;
  const gh = () => D.github;

  async function task(chatId, raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
      await store.setState(chatId, 'agent_task');
      await out.sendHtml(chatId, '🛠 <b>Что поручить агенту?</b>\nПросто напиши задачу следующим сообщением. Я сам передам её, а результат верну сюда.\nПо умолчанию: <code>Ai_growth_os</code>. Выбор другого проекта: <code>/agent repo grunvald91/booking_bot</code> или укажи ссылку на репозиторий в задании.');
      return true;
    }
    if (/^(?:статус|status|проверить|проверь)$/i.test(text)) return status(chatId);
    const readiness = /^(?:multirepo|мультирепо)\s+(on|off|status)$/i.exec(text);
    if (readiness) {
      const action = readiness[1].toLowerCase();
      if (action === 'off') await store.setSetting('agent:multi_repo_disabled', '1');
      if (action === 'on') await store.setSetting('agent:multi_repo_disabled', '0');
      const disabled = (await store.getSetting('agent:multi_repo_disabled')) === '1';
      let ready = false;
      try { ready = !!gh() && await remoteReady(); } catch { /* server cannot be verified */ }
      await out.sendHtml(chatId, 'Многорепозиторная работа: <b>' +
        (disabled ? 'приостановлена владельцем' : ready ? 'сервер подтверждён' : 'сервер не подтверждён') + '</b>.' +
        '\nСервер должен сам публиковать свежую проверку конфигурации DSH. Команда on снимает только ручную паузу, но не отключает проверку сервера.');
      return true;
    }
    const choose = /^(?:repo|репозиторий)\s+(.+)$/i.exec(text);
    if (choose) {
      const name = choose[1].trim();
      if (/^(?:default|по умолчанию|сброс)$/i.test(name)) {
        await store.setSetting(selectedKey(chatId), AGENT_REPO);
        await out.sendHtml(chatId, '✅ Репозиторий агента по умолчанию: <code>' + AGENT_REPO + '</code>.');
        return true;
      }
      if (!permittedTarget(name)) {
        await out.sendHtml(chatId, '⚠️ Укажи репозиторий в формате <code>grunvald91/имя</code> (кроме репозитория самого бота).');
        return true;
      }
      if (!gh()) {
        await out.sendHtml(chatId, '⚠️ GitHub не подключён к боту.');
        return true;
      }
      try {
        const selected = await gh().getRepo(name);
        if (!permittedTarget(selected.full_name)) throw new Error('Target repository is not permitted');
        await store.setSetting(selectedKey(chatId), selected.full_name);
        await out.sendHtml(chatId, '✅ Агент будет работать с <code>' + escapeHtml(selected.full_name) + '</code>. Задачи: <code>/agent задача</code>.');
      } catch {
        await out.sendHtml(chatId, '⚠️ Не удалось проверить доступ к <code>' + escapeHtml(name) + '</code>. Выбор не изменён.');
      }
      return true;
    }
    if (!gh() || !D.selfRepo) {
      await out.sendHtml(chatId, '⚠️ GitHub не подключён к боту. Проверю настройку токена GH_PAT после деплоя.');
      return true;
    }
    if (text.length > 6000) {
      await out.sendHtml(chatId, 'Задание превышает 6000 символов — пришли более короткую формулировку.');
      return true;
    }
    const requested = requestedAgentRepository(text);
    if (requested.unsupported) {
      await out.sendHtml(chatId, '⚠️ В задании есть ссылка на GitHub-репозиторий другого владельца. Нельзя автоматически заменить его текущим проектом.');
      return true;
    }
    if (requested.ambiguous) {
      await out.sendHtml(chatId, '⚠️ В задании указано несколько репозиториев. Выбери один целевой репозиторий для этого Issue.');
      return true;
    }
    const targetName = requested.repo ?? (await store.getSetting(selectedKey(chatId))) ?? AGENT_REPO;
    if (!permittedTarget(targetName)) {
      await out.sendHtml(chatId, '⚠️ Репозиторий недопустим. Укажи <code>grunvald91/имя</code>, кроме репозитория самого бота.');
      return true;
    }
    let target;
    try {
      target = await gh().getRepo(targetName);
      if (!permittedTarget(target.full_name)) throw new Error('Invalid canonical repository');
    } catch {
      await out.sendHtml(chatId, '⚠️ Не могу подтвердить доступ к репозиторию <code>' + escapeHtml(targetName) + '</code>. Задание не отправлено.');
      return true;
    }
    if (target.private && target.full_name.toLowerCase() !== AGENT_REPO.toLowerCase()) {
      await out.sendHtml(chatId, '🔒 Целевой репозиторий приватный, а очередь ' +
        '<code>' + AGENT_REPO + '</code> публичная. Не отправляю детали задания в публичный Issue. ' +
        'Для приватных проектов потребуется отдельная приватная очередь.');
      return true;
    }
    if (target.full_name.toLowerCase() !== AGENT_REPO.toLowerCase()) {
      const disabled = (await store.getSetting('agent:multi_repo_disabled')) === '1';
      let ready = false;
      try { ready = !disabled && await remoteReady(); } catch { /* fail closed */ }
      if (!ready) {
        await out.sendHtml(chatId, '⚠️ Нет свежего подтверждения работающей Multi-Repo конфигурации DSH на сервере. ' +
          'Задание не отправлено. Проверь сервер и команду <code>/agent multirepo status</code>.');
        return true;
      }
    }
    if (target.full_name.toLowerCase() !== AGENT_REPO.toLowerCase()) {
      try {
        const access = await gh().getRepoCollaboratorPermission(target.full_name, AGENT_ACCOUNT);
        if (!['write', 'maintain', 'admin'].includes(String(access?.permission ?? '').toLowerCase())) {
          await out.sendHtml(chatId, '⚠️ У аккаунта агента <code>' + AGENT_ACCOUNT +
            '</code> нет права Write в <code>' + escapeHtml(target.full_name) +
            '</code>. Добавь его как соавтора с доступом на запись. Задание не отправлено.');
          return true;
        }
      } catch {
        await out.sendHtml(chatId, '⚠️ Не удалось проверить права аккаунта агента на <code>' +
          escapeHtml(target.full_name) + '</code>. Задание не отправлено.');
        return true;
      }
    }
    if (/superagent-result:v1/i.test(text)) {
      await out.sendHtml(chatId, '⚠️ Служебный маркер результата нельзя помещать в текст поручения.');
      return true;
    }
    if (findSecrets(text).length) {
      await out.sendHtml(chatId, '🔒 В задании обнаружен ключ или токен. Не отправляю его в публичный GitHub Issue. Убери секрет и повтори.');
      return true;
    }
    const type = agentTaskType(text);
    const title = '[Telegram][' + target.full_name.split('/')[1] + '] ' + truncate(text.replace(/\s+/g, ' ').split(/[.!?\n]/)[0], 110);
    const body = [
      '<!-- ' + ROUTE_MARKER + ' repo=' + target.full_name + ' -->',
      '@' + AGENT_ACCOUNT,
      '',
      '## Целевой репозиторий',
      '',
      '`' + target.full_name + '` — рабочий проект. Issue создан в `' + AGENT_REPO + '` только для маршрутизации и отчётов.',
      'Используй подготовленную рабочую копию целевого репозитория. Если она не соответствует указанному проекту, остановись и сообщи об ошибке.',
      'ВАЖНО: внешние PR не привязываются через pr_number штатного DSH; передай его полный URL в summary и вызывай orchestrator_report без pr_number.',
      'Когда работа завершена (ready/blocked/failed/dropped), оставь в ЭТОМ Issue отдельный заключительный комментарий от аккаунта агента:',
      '`<!-- superagent-result:v1 issue=ISSUE_NUMBER state=ready -->` (или blocked/failed/dropped).',
      'Заменяй ISSUE_NUMBER на реальный номер текущего Issue. До маркера дай понятный итог и URL PR, если он есть.',
      'Не добавляй этот маркер в подтверждения начала работы или промежуточные комментарии.',

      '',
      '## Задание от владельца через My AI Assistant',
      '',
      text,
      '',
      '## Правила исполнения',
      '',
      type === 'report-only'
        ? 'Только чтение, анализ и отчёт комментарием в этом Issue. Не менять код или файлы, не создавать PR, не запускать деплой.'
        : 'Разрешены изменения файлов только в отдельной ветке целевого репозитория ' + target.full_name + ' с Pull Request именно в него. Не изменять код репозитория-очереди ' + AGENT_REPO + ' (если он не целевой). Не сливать PR в main, не запускать деплой, не менять production, секреты и пользовательские данные. Отправить ссылку на PR в этом Issue.',
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
    await store.setSetting(keyFor(number), JSON.stringify({ chatId, title, type, repo: target.full_name, status: 'sent', at: D.now() }));
    await store.setSetting('agent:last:' + chatId, String(number));
    const link = urlFor(number);
    let tracking = true;
    try {
      await gh().dispatch(D.selfRepo, WATCH_WORKFLOW, 'main', { issue: String(number), chat_id: String(chatId) });
    } catch (e) {
      tracking = false;
      await D.log?.('superagent_watch_error', chatId, { issue: number, reason: String(e?.kind ?? 'error') });
    }
    await D.log?.('superagent_sent', chatId, { issue: number, type, repo: target.full_name });
    await out.sendHtml(chatId,
      '✅ <b>Передал задачу агенту.</b>\n' +
      'Проект: <code>' + escapeHtml(target.full_name) + '</code>\n' +
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
    let found = finalAgentComment(comments, n, AGENT_ACCOUNT);
    if (commentId != null) found = found && String(found.id) === String(commentId) ? found : null;
    if (!found) return false;
    const resultState = parseTerminalResult(found.body, n)?.state ?? 'unknown';
    const report = truncate(String(found.body).replace(/<!--[\s\S]*?-->/g, '').trim(), 3000);
    const pull = extractTargetPull(found.body, state.repo ?? AGENT_REPO);
    await out.sendHtml(chatId,
      (resultState === 'ready' ? '✅ <b>Агент завершил задачу #' : 'ℹ️ <b>Агент закончил попытку выполнить задачу #') + n +
      ' (' + escapeHtml(resultState) + ').</b>\nПроект: <code>' + escapeHtml(state.repo ?? AGENT_REPO) + '</code>\n\n' +
      escapeHtml(report) + '\n\n' +
      '<a href="' + urlFor(n) + '">Полный отчёт, обсуждение и PR</a>'
    );
    await store.setSetting(keyFor(n), JSON.stringify({ ...state, status: 'done', resultState, commentId: found.id, ...(pull ? { pull } : {}) }));
    await D.log?.('superagent_completed', chatId, { issue: n, commentId: found.id });
    return true;
  }

  async function status(chatId) {
    const last = Number(await store.getSetting('agent:last:' + chatId));
    if (!last) {
      await out.sendHtml(chatId, 'Пока нет отправленных задач. Напиши <code>/agent задача</code> или «Поручи агенту ...».');
      return true;
    }
    const previous = await store.getSetting(keyFor(last));
    let saved = {};
    try { saved = JSON.parse(previous ?? '{}'); } catch { /* ignore */ }
    if (saved.status === 'done') {
      let prStatus = '';
      if (saved.pull?.repo && Number.isSafeInteger(saved.pull?.number) && gh()) {
        try {
          const pr = await gh().getPull(saved.pull.repo, saved.pull.number);
          const stage = pr?.merged || pr?.merged_at ? 'слит' : pr?.state === 'closed' ? 'закрыт без слияния' : pr?.draft ? 'черновик' : 'открыт';
          prStatus = '\nPR: <a href="https://github.com/' + escapeHtml(saved.pull.repo) + '/pull/' +
            saved.pull.number + '">#' + saved.pull.number + '</a> — ' + stage;
        } catch { prStatus = '\n⚠️ Не удалось проверить состояние внешнего PR в GitHub.'; }
      }
      const kind = saved.resultState === 'ready' ? 'выполнена' : 'завершилась со статусом ' + escapeHtml(saved.resultState ?? 'неизвестно');
      await out.sendHtml(chatId, 'ℹ️ <b>Задача #' + last + ' ' + kind +
        '.</b>\nПроект: <code>' + escapeHtml(saved.repo ?? AGENT_REPO) + '</code>' + prStatus +
        '\n<a href="' + urlFor(last) + '">Прочитать отчёт</a>');
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
      '🕓 <b>Задача #' + last + ' в работе.</b>\nПроект: <code>' + escapeHtml(state.repo ?? AGENT_REPO) + '</code>\n' +
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
