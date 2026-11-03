// Опциональный мост Telegram → GitHub Issues → DeepSeek Superagent.
// Не запускает DSH внутри Telegram Serverless и не выдаёт прав на прямой push.
// DeepSeek Harness должен быть установлен и настроен отдельно на конкретный репозиторий.
import { GithubError } from './github.js';
import { escapeHtml, truncate, uid, safeJson } from './util.js';

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const TTL = 15 * 60;
const kb = (rows) => ({ inline_keyboard: rows });

export function createSuperagent(D) {
  const { store, out } = D;
  const gh = () => D.github;
  const routeKey = (repo) => 'dsh:route:' + repo.toLowerCase();
  const lastKey = (repo) => 'dsh:last:' + repo.toLowerCase();
  const pendingKey = (id) => 'dsh:pending:' + id;

  async function fail(chatId, e) {
    if (e instanceof GithubError) {
      if (e.kind === 'forbidden') {
        return out.sendHtml(chatId, '🚫 Для /agent токену GH_PAT требуется право <b>Issues: Read and write</b> на выбранный репозиторий. Проверь также права отдельной учётной записи DeepSeek.');
      }
      return out.sendHtml(chatId, escapeHtml(e.userMessage));
    }
    throw e;
  }

  async function selected(chatId) {
    if (!gh()) {
      await out.sendHtml(chatId, '🔑 GitHub не подключён: нужен GH_PAT. Сначала настрой /gh.');
      return null;
    }
    const active = await store.getSetting('gh_repo');
    if (!active) {
      await out.sendHtml(chatId, 'Сначала выбери репозиторий: <code>/repo владелец/имя</code>.');
      return null;
    }
    const repo = await gh().getRepo(active);
    if (D.selfRepo && repo.full_name.toLowerCase() === D.selfRepo.toLowerCase()) {
      await out.sendHtml(chatId, '🚫 Репозиторий самого Telegram-бота исключён. Выбери другой через /repo.');
      return null;
    }
    return repo;
  }

  async function command(chatId, raw) {
    try {
      const repo = await selected(chatId);
      if (!repo) return true;
      const arg = String(raw || '').trim();
      const bound = await store.getSetting(routeKey(repo.full_name));
      if (!arg) {
        await out.sendHtml(chatId,
          '🤖 <b>DeepSeek Superagent</b>\nРепозиторий: <code>' + escapeHtml(repo.full_name) +
          '</code>\nМаршрут: ' + (bound ? '<code>@' + escapeHtml(bound) + '</code>' : 'не задан') +
          '\n\n<code>/agent bind github-login</code> — сохранить логин отдельного агента.\n' +
          '<code>/agent Текст задачи</code> — подготовить GitHub Issue (отправка после подтверждения).\n' +
          '<code>/agent status</code> — проверить последнюю Issue.\n' +
          '<code>/agent unbind</code> — удалить маршрут.\n\n' +
          'Важно: bind не устанавливает и не запускает DeepSeek Harness. На каждый репозиторий нужна настроенная установка DSH.');
        return true;
      }
      if (arg === 'unbind') {
        await store.setSetting(routeKey(repo.full_name), null);
        await out.sendHtml(chatId, 'Маршрут DeepSeek для <code>' + escapeHtml(repo.full_name) + '</code> отключён.');
        return true;
      }
      if (arg.startsWith('bind ')) {
        const login = arg.slice(5).trim().replace(/^@/, '');
        if (!LOGIN.test(login) || login.includes('--') || login.endsWith('-')) {
          await out.sendHtml(chatId, 'Укажи логин GitHub отдельного аккаунта агента: <code>/agent bind login</code>.');
          return true;
        }
        await store.setSetting(routeKey(repo.full_name), login);
        await out.sendHtml(chatId, '✅ Для <code>' + escapeHtml(repo.full_name) + '</code> сохранён адрес <code>@' +
          escapeHtml(login) + '</code>.\nЭто только маршрутизация: проверь установку DSH, доступ аккаунта к репозиторию и allowed list для твоего GitHub-логина.');
        return true;
      }
      if (arg === 'status') {
        const last = safeJson(await store.getSetting(lastKey(repo.full_name)), null);
        if (!last?.number) {
          await out.sendHtml(chatId, 'В этом репозитории пока нет задач, созданных через /agent.');
          return true;
        }
        const issue = await gh().getIssue(repo.full_name, last.number);
        const state = issue.state === 'closed' ? 'закрыта' : 'открыта';
        await out.sendHtml(chatId, '📌 Последняя GitHub Issue: <b>#' + Number(issue.number) +
          '</b> (' + state + ').\n<a href="' + escapeHtml(issue.html_url) +
          '">Открыть обсуждение и ответ агента</a>\n\nСтатус Issue не равен статусу работы DeepSeek. Pull Request проверяй в обсуждении.');
        return true;
      }
      if (!bound) {
        await out.sendHtml(chatId, 'Сначала укажи GitHub-логин отдельного агента: <code>/agent bind login</code>. Это не запускает DSH.');
        return true;
      }
      if (arg.length > 5000) {
        await out.sendHtml(chatId, 'Задание слишком большое (более 5000 символов). Раздели его на отдельные задачи.');
        return true;
      }
      const id = uid();
      await store.setSetting(pendingKey(id), JSON.stringify({
        repo: repo.full_name, login: bound, task: arg, chatId, ts: D.now(), status: 'pending',
      }));
      await out.sendHtml(chatId,
        '🧑‍💻 <b>Подготовлена задача для DeepSeek</b>\nРепозиторий: <code>' + escapeHtml(repo.full_name) +
        '</code>\nАдресат: <code>@' + escapeHtml(bound) + '</code>\n\n' +
        escapeHtml(truncate(arg, 1200)) +
        '\n\nНичего ещё не отправлено. GitHub Issue будет видна участникам репозитория.',
        { reply_markup: kb([
          [{ text: '📨 Создать Issue', callback_data: 'sa:c:' + id, style: 'primary' }],
          [{ text: '✖️ Отмена', callback_data: 'sa:x:' + id }],
        ]) });
      return true;
    } catch (e) {
      await fail(chatId, e);
      return true;
    }
  }

  async function callback(cq, parts) {
    const chatId = cq.message.chat.id;
    if (cq.message.chat.type && cq.message.chat.type !== 'private') {
      return out.answerCb(cq.id, 'Только в личном чате', true);
    }
    const [action, id] = parts;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) return out.answerCb(cq.id, 'Кнопка недействительна', true);
    const key = pendingKey(id);
    const draft = safeJson(await store.getSetting(key), null);
    if (!draft || draft.chatId !== chatId || D.now() - draft.ts > TTL) {
      return out.answerCb(cq.id, 'Задание устарело. Создай заново.', true);
    }
    if (action === 'x' && draft.status === 'pending') {
      await store.setSetting(key, null);
      await out.dropButtons(chatId, cq.message.message_id);
      return out.answerCb(cq.id, 'Отменено');
    }
    if (action !== 'c' || draft.status !== 'pending') {
      return out.answerCb(cq.id, 'Уже обрабатывается или отправлено', true);
    }
    // Потребляем подтверждение ДО записи в GitHub. При неопределённом сетевом сбое
    // не повторяем POST автоматически: иначе можно создать две Issues.
    await store.setSetting(key, JSON.stringify({ ...draft, status: 'sending' }));
    try {
      const repo = await gh().getRepo(draft.repo);
      if (repo.full_name.toLowerCase() !== draft.repo.toLowerCase() ||
          (D.selfRepo && repo.full_name.toLowerCase() === D.selfRepo.toLowerCase())) {
        throw new Error('Изменился или запрещён целевой репозиторий');
      }
      const issue = await gh().createIssue(draft.repo, {
        title: '[Superagent] ' + draft.task.replace(/\s+/g, ' ').slice(0, 96),
        body: '@' + draft.login + '\n\n' + draft.task +
          '\n\n---\nЗадача отправлена владельцем из My AI Assistant. ' +
          'Подготовь изменения в отдельной ветке и Pull Request; не сливай в main без подтверждения.',
      });
      await store.setSetting(lastKey(draft.repo), JSON.stringify({ number: issue.number, url: issue.html_url }));
      await store.setSetting(key, JSON.stringify({ ...draft, status: 'sent', issue: issue.number }));
      await out.dropButtons(chatId, cq.message.message_id);
      await out.answerCb(cq.id, 'Issue создана');
      await out.sendHtml(chatId, '✅ Создана <a href="' + escapeHtml(issue.html_url) + '">Issue #' +
        Number(issue.number) + '</a> в <code>' + escapeHtml(draft.repo) +
        '</code>.\nЭто подтверждает только создание задания, не запуск или успешное выполнение DSH.');
      await D.log('dsh_issue_created', chatId, { repo: draft.repo, issue: issue.number });
    } catch (e) {
      // Неизвестно, дошёл ли POST до GitHub. Предлагаем проверить репозиторий,
      // а не запускать ещё один POST по той же кнопке.
      await store.setSetting(key, JSON.stringify({ ...draft, status: 'unknown' }));
      await out.answerCb(cq.id, 'Проверь GitHub', true);
      await out.sendHtml(chatId, '⚠️ Не могу подтвердить создание GitHub Issue. Проверь список Issues в <code>' +
        escapeHtml(draft.repo) + '</code> перед повторной отправкой, чтобы избежать дублей.');
      if (!(e instanceof GithubError)) throw e;
    }
  }

  return { command, callback };
}
