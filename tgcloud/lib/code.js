// code.js — «пушить код в GitHub»: бот читает нужные файлы чужого репозитория, пишет изменения по заданию
// владельца и после его подтверждения отправляет их веткой + Pull Request (или сразу в основную ветку).
//
// Границы безопасности:
//  • репозиторий самого бота запрещён (проверка по каноническому имени из ответа GitHub, а не по тексту команды);
//  • ничего не пишется без кнопки владельца; по умолчанию — ветка + PR;
//  • перед показом изменения проверяются на секреты (ключи, токены) и небезопасные пути;
//  • содержимое репозитория для модели — данные, а не инструкции.
// Состояние: chats.state = code_task (ждём описание задачи); черновик изменений — в drafts (kind='code').

import { codeSelectSystem, codeSystem } from './persona.js';
import { listCandidates, parseSelection, parseChanges, safePath, findSecrets, slug } from './codeparse.js';
import { GithubError } from './github.js';
import { LlmError } from './llm.js';
import { LimitError } from './core.js';
import { createActions, ACTION_ACTS } from './actions.js';
import { escapeHtml, truncate, uid, safeJson, utf8Encode, dayKey } from './util.js';
import { costUsd } from './models.js';

const kb = (rows) => ({ inline_keyboard: rows });
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200000;
const MAX_TOTAL_BYTES = 600000;
const kb1 = (n) => (n < 1024 ? n + ' Б' : (n / 1024).toFixed(1) + ' КБ');

export function createCode(D) {
  const { store, out, core, cfg } = D;
  const gh = () => D.github;
  const self = () => String(D.selfRepo ?? '').toLowerCase();

  const noToken = () =>
    '🔑 GitHub не подключён.\n\n' +
    '1. GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate.\n' +
    '2. Repository access: <b>All repositories</b> (или выбери нужные; репозиторий бота лучше исключить).\n' +
    '3. Права: <b>Contents</b> — Read and write, <b>Pull requests</b> — Read and write, Metadata — Read; для GitHub Actions ещё <b>Actions</b> — Read and write (запуск Run workflow и статусы) и <b>Workflows</b> — Read and write (создание файлов в .github/workflows).\n' +
    '4. Добавь токен в секреты репозитория бота под именем <code>GH_PAT</code> и перезапусти деплой.';

  /** Репозиторий бота трогать нельзя. fullName — каноническое имя из ответа GitHub. */
  const isSelf = (fullName) => !!self() && String(fullName).toLowerCase() === self();

  async function fail(chatId, e) {
    if (e instanceof GithubError || e instanceof LlmError || e instanceof LimitError) {
      await out.sendHtml(chatId, escapeHtml(e.userMessage));
      return;
    }
    throw e;
  }

  const actions = createActions(D, { gh, isSelf, noToken, fail });

  // ───────── /gh и /repo ─────────

  async function showGh(chatId) {
    if (!gh()) return out.sendHtml(chatId, noToken());
    try {
      const [me, repos] = await Promise.all([gh().me(), gh().listRepos()]);
      const names = repos.map((r) => r.full_name).filter((n) => !isSelf(n));
      await store.setSetting('gh_repos', JSON.stringify(names));
      const cur = await store.getSetting('gh_repo');
      await out.sendHtml(
        chatId,
        `🐙 GitHub: <b>${escapeHtml(me.login)}</b>\nАктивный репозиторий: ${cur ? '<code>' + escapeHtml(cur) + '</code>' : 'не выбран'}\n\n` +
          'Выбери репозиторий ниже (последние по активности) или командой: <code>/repo владелец/имя</code>.\nПотом: <code>/code что нужно сделать</code>.',
        { reply_markup: kb(names.slice(0, 8).map((n, i) => [{ text: truncate(n, 60), callback_data: 'x:r:' + i }])) },
      );
    } catch (e) {
      await fail(chatId, e);
    }
  }

  async function setRepo(chatId, name) {
    if (!gh()) return out.sendHtml(chatId, noToken());
    let full = name.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    try {
      if (!full.includes('/')) full = (await gh().me()).login + '/' + full;
      const repo = await gh().getRepo(full);
      if (isSelf(repo.full_name)) {
        await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя — свой код я не переписываю. Выбери другой.');
        return;
      }
      await store.setSetting('gh_repo', repo.full_name);
      await out.sendHtml(
        chatId,
        `✅ Репозиторий: <code>${escapeHtml(repo.full_name)}</code> (${repo.private ? 'приватный' : 'публичный'}, ветка <code>${escapeHtml(repo.default_branch)}</code>).\nТеперь: <code>/code задание</code>`,
      );
    } catch (e) {
      await fail(chatId, e);
    }
  }

  // ───────── /code ─────────

  async function startTask(chat, arg) {
    const chatId = chat.chatId;
    if (!gh()) return out.sendHtml(chatId, noToken());
    if (!(await store.getSetting('gh_repo'))) {
      await out.sendHtml(chatId, 'Сначала выбери репозиторий: /gh или <code>/repo владелец/имя</code>');
      return;
    }
    if (!arg) {
      await store.setState(chatId, 'code_task');
      await out.ask(chatId, '🧑‍💻 Опиши задачу: что сделать в репозитории. /cancel — отмена.');
      return;
    }
    return runTask(chatId, arg);
  }

  async function onState(msg, chat) {
    if (chat.state !== 'code_task') return false;
    const text = (msg.text ?? '').trim();
    if (!text) return false;
    await store.setState(chat.chatId, null);
    await runTask(chat.chatId, text);
    return true;
  }

  // Вызов бота живёт ~30 с, а код пишется минуту и больше. Поэтому задача идёт шагами:
  // подготовка (репозиторий, файлы) → кусок кода (до cfg.cutAfterMs) → кнопка «Дописать» → … → предпросмотр.
  // Состояние задачи — в настройке code_job: что прочитано и сколько кода уже написано.

  const JOB = 'code_job';
  const CONTINUE_CODE = 'Твой ответ оборвался на полуслове (кончилось время вызова). Продолжи РОВНО с того места, где он закончился: не повторяй уже написанное, не начинай заново, сохраняй тот же формат с маркерами @@@. Если ты уже закончил — выведи только последнюю строку «@@@ END», если файл открыт, иначе ничего.';
  const loadJob = async () => safeJson(await store.getSetting(JOB), null);
  const saveJob = (job) => store.setSetting(JOB, job ? JSON.stringify(job) : null);
  const jobButton = (label) => ({ reply_markup: kb([[{ text: label, callback_data: 'x:cj', style: 'primary' }, { text: '✖️ Отмена', callback_data: 'x:cjx', style: 'danger' }]]) });

  // ───────── статус задачи: четыре разных «готово» ─────────
  // 1 отправлено в Actions → 2 код написан → 3 ты подтвердил → 4 записано в репозиторий (PR/коммит).
  // Одно сообщение редактируется по мере продвижения, чтобы «готово» не означало «отправлено».

  const STEPS = ['Отправлено в GitHub Actions', 'Код написан и проверен ботом', 'Ты подтвердил', 'Записано в репозиторий'];
  /** done — сколько шагов завершено; now — что идёт сейчас (по умолчанию следующий); state: wait | fail | cancel */
  function progressHtml(repoName, done, { state = 'run', note = '' } = {}) {
    const lines = STEPS.map((s, i) => {
      if (i < done) return `✅ ${i + 1}. ${s}`;
      if (i === done) return state === 'fail' ? `❌ ${i + 1}. ${s}` : state === 'cancel' ? `✖️ ${i + 1}. ${s}` : state === 'wait' ? `⏸ ${i + 1}. ${s}` : `⏳ ${i + 1}. ${s}`;
      return `▫️ ${i + 1}. ${s}`;
    });
    return `🧑‍💻 <b>Задача для ${escapeHtml(repoName)}</b>\n${lines.join('\n')}${note ? '\n\n' + note : ''}`;
  }
  async function setProgress(st, done, opts) {
    if (!st?.msgId) return;
    try {
      await out.editHtml(st.chatId, st.msgId, progressHtml(st.repo, done, opts), null);
    } catch (e) {
      console.warn('progress edit failed', e?.message ?? e); // статус — удобство: сбой правки ничего не ломает
    }
  }

  // ───────── тяжёлая часть в GitHub Actions ─────────
  // Обработчик бота живёт ~30 с, GitHub Actions — до 30 минут. Бот только запускает workflow codejob.yml в СВОЁМ репозитории
  // (для этого токену нужно право Actions: Read and write и на репозиторий бота); результат приходит обратно эндпоинтами
  // codejob_part/codejob_done, и дальше всё как обычно: проверка на секреты, предпросмотр, кнопки владельца.

  const WORKFLOW = 'codejob.yml';
  const MAX_TASK_INPUT = 60000; // предел поля workflow_dispatch — 65535 символов

  /** true — задача ушла в Actions. false — не вышло (причина уже показана), дальше идём по шагам внутри бота. */
  async function startRemote(chatId, task) {
    if (!cfg.codeViaActions || !D.selfRepo || task.length > MAX_TASK_INPUT) return false;
    const full = await store.getSetting('gh_repo');
    let repo;
    try {
      repo = await gh().getRepo(full);
      if (isSelf(repo.full_name)) {
        await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя. Выбери другой: /gh');
        return true;
      }
      const selfInfo = await gh().getRepo(D.selfRepo);
      const model = await core.ownerModel();
      const think = await core.thinkLevel();
      const id = uid();
      await store.setSetting('cj:' + id, JSON.stringify({ chatId, task, repo: { full_name: repo.full_name, private: !!repo.private }, branch: repo.default_branch, ts: D.now() }));
      try {
        await gh().dispatch(D.selfRepo, WORKFLOW, selfInfo.default_branch, { job: id, mode: 'run', repo: repo.full_name, branch: repo.default_branch, task, model: model.id, think });
      } catch (e) {
        await store.setSetting('cj:' + id, null);
        throw e;
      }
      const sent = await out.sendHtml(
        chatId,
        progressHtml(repo.full_name, 1, { note: `Код пишется в GitHub Actions — там нет лимита в 30 секунд, обычно 1–5 минут. Дальше пришлю предпросмотр; в репозиторий ничего не попадёт без твоей кнопки.\n<a href="https://github.com/${escapeHtml(D.selfRepo)}/actions/workflows/${WORKFLOW}">Ход выполнения</a>` }),
      );
      if (sent?.message_id) {
        const cur = safeJson(await store.getSetting('cj:' + id), null);
        if (cur) await store.setSetting('cj:' + id, JSON.stringify({ ...cur, statusMsg: sent.message_id }));
      }
      return true;
    } catch (e) {
      if (e instanceof GithubError) {
        await out.sendHtml(chatId, `⚠️ В GitHub Actions задачу запустить не вышло: ${escapeHtml(e.userMessage)}

Чтобы работало без нажатий, дай токену GH_PAT права <b>Actions</b> и <b>Contents</b> (Read and write) ещё и на репозиторий бота. Пока пишу по шагам прямо в боте.`);
        return false;
      }
      throw e;
    }
  }

  async function receiveJobPart(job, i, text) {
    if (!job || !(i >= 0) || !(await store.getSetting('cj:' + job))) return false;
    await store.setSetting(`cj:${job}:${i}`, text);
    return true;
  }

  /** Итог задачи из Actions: error — сообщение о сбое, иначе n частей ответа модели → разбор и предпросмотр. */
  async function finishJob({ job, n, finish, usage, model, error }) {
    const meta = safeJson(await store.getSetting('cj:' + job), null);
    if (!meta) return false;
    const drop = async () => {
      for (let i = 0; i < n; i++) await store.setSetting(`cj:${job}:${i}`, null);
      await store.setSetting('cj:' + job, null);
    };
    const st = meta.statusMsg ? { chatId: meta.chatId, msgId: meta.statusMsg, repo: meta.repo.full_name } : null;
    let finished = false; // дошли до предпросмотра
    try {
      if (error) {
        await setProgress(st, 1, { state: 'fail', note: 'GitHub Actions не справился.' });
        await out.sendHtml(meta.chatId, `❌ Задача в GitHub Actions не удалась: ${escapeHtml(truncate(error, 600))}

Можно повторить: /code`);
        return true;
      }
      let text = '';
      for (let i = 0; i < n; i++) {
        const part = await store.getSetting(`cj:${job}:${i}`);
        if (part == null) {
          await setProgress(st, 1, { state: 'fail', note: 'Ответ дошёл не полностью.' });
          await out.sendHtml(meta.chatId, '❌ Ответ из GitHub Actions дошёл не полностью. Повтори задачу: /code');
          return true;
        }
        text += part;
      }
      if (usage && (usage.in || usage.out)) {
        const m = (await core.getModels()).find((x) => x.id === model);
        await store.addUsage(dayKey(D.now(), core.tz()), usage.in ?? 0, usage.out ?? 0, costUsd(m, usage.in ?? 0, usage.out ?? 0));
      }
      const tree = await gh().getTree(meta.repo.full_name, meta.branch);
      finished = (await prepareDraft(meta.chatId, { task: meta.task, repo: meta.repo, branch: meta.branch, tree, text, finish, status: st })) === true;
      if (!finished) await setProgress(st, 1, { state: 'fail', note: 'Из ответа модели не получилось собрать изменения.' });
      return true;
    } catch (e) {
      if (e instanceof GithubError || e instanceof LlmError || e instanceof LimitError) {
        await setProgress(st, 1, { state: 'fail', note: 'Не удалось подготовить предпросмотр.' });
        await out.sendHtml(meta.chatId, escapeHtml(e.userMessage));
        return true;
      }
      throw e;
    } finally {
      await drop();
    }
  }

  async function runTask(chatId, task) {
    if (await startRemote(chatId, task)) return;
    const t0 = D.t0 ?? Date.now();
    const full = await store.getSetting('gh_repo');
    try {
      const repo = await gh().getRepo(full);
      if (isSelf(repo.full_name)) {
        await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя. Выбери другой: /gh');
        return;
      }
      const branch = repo.default_branch;
      await out.sendHtml(chatId, `🔎 Читаю <code>${escapeHtml(repo.full_name)}</code>…`);
      await out.typing(chatId);

      const tree = await gh().getTree(repo.full_name, branch);
      const cands = listCandidates(tree.files);
      const model = await core.ownerModel();

      // 1) какие файлы читать
      let readPaths = [];
      if (cands.length) {
        const sel = await core.generate({
          model,
          messages: [
            { role: 'system', content: codeSelectSystem() },
            { role: 'user', content: `ЗАДАНИЕ:\n${task}\n\nФАЙЛЫ РЕПОЗИТОРИЯ:\n${cands.map((f) => `${f.path} (${f.size} Б)`).join('\n')}` },
          ],
          maxTokens: 400,
        });
        readPaths = parseSelection(sel.text, cands);
      }
      const contents = [];
      for (const p of readPaths) contents.push({ path: p, text: await gh().getFile(repo.full_name, p, branch) });

      const user =
        `ЗАДАНИЕ:\n${task}\n\n` +
        `ВСЕ ФАЙЛЫ (пути):\n${cands.map((f) => f.path).join('\n') || '(пусто)'}\n\n` +
        contents.map((c) => `=== СОДЕРЖИМОЕ ${c.path} ===\n${c.text}\n=== КОНЕЦ ${c.path} ===`).join('\n\n');
      const job = {
        task,
        repo: { full_name: repo.full_name, private: !!repo.private, default_branch: branch },
        branch,
        tree: { empty: !!tree.empty, files: tree.files.map((f) => ({ path: f.path })) },
        user,
        text: '',
        steps: 0,
        files: contents.length,
      };
      await saveJob(job);

      // на подготовку ушло много времени — не начинаем писать код, который всё равно оборвётся
      if (cfg.cutAfterMs && Date.now() - t0 > cfg.cutAfterMs * 0.6) {
        await out.sendHtml(chatId, `✅ Подготовлено: прочитано файлов — ${contents.length}. Теперь писать код:`, jobButton('✍️ Писать код'));
        return;
      }
      await out.sendHtml(chatId, `✍️ Читал файлов: ${contents.length}. Пишу код…`);
      await writeSlice(chatId, job);
    } catch (e) {
      await fail(chatId, e);
    }
  }

  /** Один кусок кода (до срока вызова). Закончили — предпросмотр; нет — сохраняем написанное и даём кнопку «Дописать». */
  async function writeSlice(chatId, job) {
    const model = await core.ownerModel();
    const messages = [
      { role: 'system', content: codeSystem({ repo: job.repo.full_name, branch: job.branch, empty: job.tree.empty }) },
      { role: 'user', content: job.user },
    ];
    if (job.text) messages.push({ role: 'assistant', content: job.text }, { role: 'user', content: CONTINUE_CODE });
    const streamer = D.draftStreamer ? D.draftStreamer(chatId, { rich: false }) : null;
    if (streamer) await streamer.start();
    let res;
    try {
      res = await core.generate({
        model,
        messages,
        maxTokens: cfg.maxTokensCode,
        stream: true,
        onProgress: streamer?.onProgress,
        think: job.steps ? null : await core.thinkLevel(), // размышления — только на первом куске
      });
    } catch (e) {
      // уже написанное не теряем: можно повторить шаг
      if ((e instanceof LlmError || e instanceof LimitError) && job.text) {
        await out.sendHtml(chatId, escapeHtml(e.userMessage) + `\n\nУже написано ~${kb1(utf8Encode(job.text).length)} кода — оно сохранено.`, jobButton('🔄 Повторить шаг'));
        return;
      }
      if (e instanceof LlmError && e.kind === 'timeout') {
        await out.sendHtml(chatId, escapeHtml(e.userMessage), jobButton('🔄 Повторить'));
        return;
      }
      throw e;
    }
    if (res.cut) {
      job.text += res.text;
      job.steps = (job.steps ?? 0) + 1;
      await saveJob(job);
      await out.sendHtml(chatId, `⏱ Шаг ${job.steps}: написано ~${kb1(utf8Encode(job.text).length)} кода, модель ещё пишет (вызов бота ограничен ~30 секундами). Жми «Дописать».`, jobButton('▶️ Дописать'));
      return;
    }
    const text = job.text + res.text;
    await saveJob(null);
    await prepareDraft(chatId, { task: job.task, repo: job.repo, branch: job.branch, tree: job.tree, text, finish: res.finish });
  }

  async function continueJob(chatId) {
    const job = await loadJob();
    if (!job) return false;
    // защита от двойного нажатия: два куска одновременно испортили бы текст
    if (job.busy && Date.now() - job.busy < 60000) {
      await out.sendHtml(chatId, '⏳ Уже пишу — подожди результата.');
      return true;
    }
    job.busy = Date.now();
    await saveJob(job);
    try {
      job.busy = undefined;
      await writeSlice(chatId, job);
    } catch (e) {
      const j = await loadJob();
      if (j) {
        j.busy = undefined;
        await saveJob(j);
      }
      await fail(chatId, e);
    }
    const j = await loadJob();
    if (j?.busy) {
      j.busy = undefined;
      await saveJob(j);
    }
    return true;
  }

  /** true — предпросмотр отправлен; иначе причина уже показана. */
  async function prepareDraft(chatId, { task, repo, branch, tree, text, finish, status = null }) {
    const ch = parseChanges(text);
    const existing = new Set(tree.files.map((f) => f.path));
    const problems = [];
    const files = [];
    let total = 0;

    for (const f of ch.files) {
      if (!safePath(f.path)) {
        problems.push(`пропущен небезопасный путь «${f.path}»`);
        continue;
      }
      const bytes = utf8Encode(f.content).length;
      if (bytes > MAX_FILE_BYTES) {
        problems.push(`${f.path}: больше ${kb1(MAX_FILE_BYTES)} — пропущен`);
        continue;
      }
      total += bytes;
      files.push({ path: f.path, action: existing.has(f.path) ? 'update' : 'create', content: f.content, bytes });
    }
    const deletes = ch.deletes.filter((p) => {
      if (!safePath(p) || !existing.has(p)) {
        problems.push(`удаление «${p}» пропущено (нет такого файла)`);
        return false;
      }
      return true;
    });

    if (ch.truncated || finish === 'length') problems.push('ответ модели оборвался (слишком много кода за раз) — последний файл отброшен, разбей задачу на части');
    if (files.length > MAX_FILES) {
      problems.push(`файлов больше ${MAX_FILES} — взяты первые ${MAX_FILES}`);
      files.length = MAX_FILES;
    }
    if (total > MAX_TOTAL_BYTES) {
      await out.sendHtml(chatId, `⚠️ Изменения слишком большие (${kb1(total)} > ${kb1(MAX_TOTAL_BYTES)}). Разбей задачу на части.`);
      return false;
    }

    const secrets = [...new Set(files.flatMap((f) => findSecrets(f.content)))];
    if (secrets.length) {
      await out.sendHtml(chatId, `🛑 В коде нашлись секреты (${escapeHtml(secrets.join(', '))}) — такое я не коммичу. Переформулируй задачу: ключи должны браться из переменных окружения.`);
      await D.log('code_secret_blocked', chatId, { repo: repo.full_name });
      return false;
    }

    if (!files.length && !deletes.length) {
      await out.sendHtml(chatId, '🤷 Изменений нет.\n\n' + escapeHtml(ch.summary || truncate(text, 1500) || 'Модель не предложила правок.') + (problems.length ? '\n\n⚠️ ' + escapeHtml(problems.join('; ')) : ''));
      return false;
    }

    const warnings = [...problems];
    if ([...files.map((f) => f.path), ...deletes].some((p) => p.startsWith('.github/workflows/'))) warnings.push('меняются GitHub Actions workflow — проверь внимательно: они выполняются с секретами репозитория');

    const plan = {
      repo: repo.full_name,
      base: branch,
      empty: tree.empty,
      private: !!repo.private,
      commit: truncate(ch.commit || 'Update by assistant', 72, ''),
      summary: ch.summary,
      files: files.map(({ path, action, content }) => ({ path, action, content })),
      deletes,
      status,
    };
    const id = uid();
    await store.createDraft({ id, kind: 'code', brief: truncate(task, 2000, ''), text: JSON.stringify(plan), format: 'md', status: 'ready', rev: 1, createdAt: D.now() });

    const list = [
      ...files.map((f) => `${f.action === 'create' ? '➕' : '✏️'} <code>${escapeHtml(f.path)}</code> (${kb1(f.bytes)})`),
      ...deletes.map((p) => `🗑 <code>${escapeHtml(p)}</code>`),
    ].join('\n');
    const rows = tree.empty
      ? [[{ text: `⬆️ Закоммитить в ${branch}`, callback_data: 'x:main:' + id }]]
      : [[{ text: '🌿 Ветка + Pull Request', callback_data: 'x:pr:' + id, style: 'primary' }], [{ text: `⬆️ Сразу в ${branch}`, callback_data: 'x:main:' + id }]];
    rows.push([{ text: '📄 Показать код', callback_data: 'x:show:' + id }, { text: '✖️ Отмена', callback_data: 'x:cx:' + id, style: 'danger' }]);

    await out.sendHtml(
      chatId,
      `🧑‍💻 <b>${escapeHtml(repo.full_name)}</b> · ${repo.private ? 'приватный' : 'публичный'} · ветка <code>${escapeHtml(branch)}</code>\n` +
        `<b>Коммит:</b> ${escapeHtml(plan.commit)}\n\n${escapeHtml(truncate(ch.summary, 1200))}\n\n<b>Файлы (${files.length + deletes.length}):</b>\n${list}` +
        (warnings.length ? '\n\n⚠️ ' + escapeHtml(warnings.join('; ')) : '') +
        '\n\nНичего не отправлено. Выбери действие:',
      { reply_markup: kb(rows) },
    );
    await D.log('code_draft', chatId, { id, repo: repo.full_name, files: files.length });
    await setProgress(status, 2, { state: 'wait', note: `Код готов: файлов — ${files.length + deletes.length}. <b>В репозиторий пока ничего не записано</b> — жду твою кнопку в предпросмотре ниже.` });
    return true;
  }

  // ───────── просьба написать код обычным сообщением ─────────
  // «создай ветку feature/x в ServGo и залей код» без /code → всё равно запускаем кодовый режим
  // (предпросмотр и кнопки как обычно: ничего не отправляется без нажатия).

  // Задача для кода = в сообщении есть слово про ветку/PR/коммит/репозиторий И глагол действия (в любом месте и порядке),
  // а сообщение не вопрос «объясни, что такое…».
  const GIT_WORDS = /ветк[аиеуыо]|\bbranch\b|pull\s?request|пулл|\bPR\b|коммит|в\s+репозитор|в\s+репо(?![а-я])|\bgit\s+(?:checkout|commit|push|branch)\b|\bfeature\/[\w-]+/i;
  const DO_VERBS = /созда|сдела|залей|залить|запуш|закоммит|добав|напиши|реализу|внеси|подготов|запил|работай|открой|собери|исправь|измени|поправь|обнови|сверста|допиши/i;
  const EXPLAIN = /^\s*(?:расскажи|объясни|что такое|как работает|почему|зачем|в чём разница)/i;
  // «изучи/посмотри репозиторий, ветка dev, и сделай пост» — это чтение, а не запись в репозиторий
  const READ_FIRST = /^\s*(?:изучи|посмотри|прочитай|проанализируй|разбери|оцени|проверь|глянь)/i;
  const WRITE_WORDS = /залей|залить|запуш|закоммит|коммит|pull\s?request|пулл|\bPR\b|созда\S*\s+(?:\S+\s+){0,2}ветк|\bgit\s+(?:checkout|commit|push|branch)\b/i;
  const isCodeTask = (t) =>
    GIT_WORDS.test(t) && DO_VERBS.test(t) && !EXPLAIN.test(t) && (!READ_FIRST.test(t) || WRITE_WORDS.test(t));

  /** Название репозитория в тексте словами: «ai growth os» ≈ ai-growth-os, «ServGo» ≈ servgo. */
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function nameCandidates(text) {
    const w = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const set = new Set();
    for (let i = 0; i < w.length; i++) for (let n = 1; n <= 4 && i + n <= w.length; n++) set.add(w.slice(i, i + n).join(''));
    return set;
  }

  /** true — сообщение обработано как задача для кода. */
  async function maybeAutoTask(chat, text) {
    if (!gh() || !isCodeTask(text)) return false;
    const chatId = chat.chatId;
    try {
      // репозиторий: назван явно (ссылка, владелец/имя) → он; иначе слово из текста, совпавшее с именем репозитория; иначе выбранный
      const BRANCHY = /^(feature|feat|fix|hotfix|bugfix|release|chore|refactor|docs|test|dev)\//i; // «feature/x» — это ветка, а не владелец/имя
      const refs = [URL_REF.exec(text)?.[1], ...[...text.matchAll(new RegExp(NAME_REF.source, 'g'))].map((m) => m[1])].filter((x) => x && !BRANCHY.test(x));
      let repo = null;
      for (const r of refs) {
        try {
          repo = await gh().getRepo(r.replace(/\.git$/i, ''));
          break;
        } catch (e) {
          if (!(e instanceof GithubError && e.kind === 'notfound')) throw e;
        }
      }
      if (!repo) {
        const cands = nameCandidates(text);
        // если названо несколько репозиториев — берём тот, чьё имя длиннее (точнее): «ai growth os» важнее, чем «ServGo» в описании логотипа
        const hit = ((await gh().listAllRepos()) ?? [])
          .filter((r) => {
            const n = norm(r.full_name.split('/')[1]);
            return n.length >= 4 && cands.has(n);
          })
          .sort((a, b) => norm(b.full_name.split('/')[1]).length - norm(a.full_name.split('/')[1]).length)[0];
        if (hit) repo = await gh().getRepo(hit.full_name);
      }
      if (repo) {
        if (isSelf(repo.full_name)) {
          await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя — свой код я не переписываю. Назови другой.');
          return true;
        }
        if ((await store.getSetting('gh_repo')) !== repo.full_name) await store.setSetting('gh_repo', repo.full_name);
      }
      if (!(await store.getSetting('gh_repo'))) {
        await out.sendHtml(chatId, 'Это задача для кода, но я не понял, в каком репозитории. Выбери: /gh или <code>/repo владелец/имя</code> — и повтори просьбу.');
        return true;
      }
      await store.setState(chatId, null);
      await out.sendHtml(chatId, `🧑‍💻 Понял как задачу для кода. Репозиторий: <code>${escapeHtml(await store.getSetting('gh_repo'))}</code> (другой — /repo).`);
      await runTask(chatId, text);
      return true;
    } catch (e) {
      await fail(chatId, e);
      return true;
    }
  }

  // ───────── чтение репозитория для обычного чата ─────────
  // «посмотри репозиторий и сделай пост»: без этого модель в чате не видит GitHub и просит прислать README.
  // Читаем только на чтение, репозиторий бота не трогаем, файлы с секретами в модель не отдаём.

  const KEYWORD = /репозитор|репо(?![а-яa-z])|github|гитхаб|гит\s?хаб/i;
  const ACTION = /посмотр|изуч|прочит|загляни|глянь|проанализ|разбер|пост|реклам|описани|по нему|по ней|по проекту|подключ/i;
  const URL_REF = /github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})/i;
  const NAME_REF = /(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*)(?![\w/-])/;
  const PRIORITY = [
    /^readme(\.\w+)?$/i, /^package\.json$/, /^pyproject\.toml$/, /^go\.mod$/, /^composer\.json$/, /^requirements\.txt$/,
    /^docs?\/[^/]+\.md$/i, /^[^/]+\.md$/i, /^(src|app|lib)\/(index|main|app|bot)\.\w+$/, /^(index|main|app|bot)\.\w+$/,
  ];
  const SECRET_NAME = /(^|\/)(\.env|id_rsa|.*\.pem|.*\.key|.*secret.*|.*credential.*)/i;
  const BRANCH_REF = /(?:ветк[аеуи]|branch)\s+[`"«']?([A-Za-z0-9][\w./-]{0,100})/i;

  /** Файлы по важности: README и манифесты, потом документы и точки входа, потом всё остальное (мелкие и ближе к корню — раньше). */
  function rankFiles(cands) {
    const rank = (f) => {
      const i = PRIORITY.findIndex((re) => re.test(f.path));
      return i === -1 ? PRIORITY.length : i;
    };
    return [...cands].sort((a, b) => rank(a) - rank(b) || a.path.split('/').length - b.path.split('/').length || a.size - b.size || (a.path < b.path ? -1 : 1));
  }

  /** Что прислать модели: ВСЕ текстовые файлы ветки (в пределах окна модели). null — просьбы про репозиторий нет. */
  async function repoContext(text) {
    if (!gh()) return null;
    const t = String(text ?? '');
    const url = URL_REF.exec(t)?.[1];
    const name = NAME_REF.exec(t)?.[1];
    const asked = !!url || (KEYWORD.test(t) && (ACTION.test(t) || !!name));
    if (!asked) {
      // продолжение разговора («перепиши покороче») — прочитанный репозиторий остаётся в контексте, пока не прочитан другой или не сделан /reset
      const st = safeJson(await store.getSetting('repo_ctx'), null);
      return st ? { text: st.text, repo: st.repo } : null;
    }
    try {
      let repo;
      const explicit = (url || name || '').replace(/\.git$/i, '');
      const fallback = await store.getSetting('gh_repo');
      if (explicit) {
        try {
          repo = await gh().getRepo(explicit);
        } catch (e) {
          if (!(e instanceof GithubError && e.kind === 'notfound') || !fallback) throw e;
        }
      }
      if (!repo) {
        if (!fallback) return { error: 'Не вижу, какой репозиторий читать: пришли ссылку или выбери его командой /gh.' };
        repo = await gh().getRepo(fallback);
      }
      if (isSelf(repo.full_name)) return { error: '🚫 Репозиторий самого бота я не читаю. Назови другой.' };

      const branch = BRANCH_REF.exec(t)?.[1] || repo.default_branch;
      await out.sendHtml(D.ownerId, `🔎 Читаю <code>${escapeHtml(repo.full_name)}</code>, ветка <code>${escapeHtml(branch)}</code>…`);
      const tree = await gh().getTree(repo.full_name, branch);

      const model = await core.ownerModel();
      const parts = [];
      let used = 0;
      let skipped = 0;

      /** Читает файлы ветки целиком (пачками по 8 запросов); tag — метка ветки в заголовке файла. */
      const readFiles = async (br, files, tag) => {
        const cands = rankFiles(listCandidates(files, Infinity).filter((f) => !SECRET_NAME.test(f.path)));
        for (let i = 0; i < cands.length; i += 8) {
          const batch = cands.slice(i, i + 8);
          const raws = await Promise.all(batch.map((f) => gh().getFile(repo.full_name, f.path, br).catch(() => null)));
          batch.forEach((f, k) => {
            const raw = raws[k];
            if (raw == null || findSecrets(raw).length) {
              skipped++;
              return;
            }
            used += raw.length;
            parts.push(`\n=== ФАЙЛ ${tag}${f.path} ===\n${raw}\n`);
          });
        }
      };
      await readFiles(branch, tree.files, '');

      // В основной ветке почти пусто, а ветку владелец не называл → читаем и остальные ветки.
      // Файлы, которые там такие же, как в основной (тот же sha), не дублируем.
      let others = '';
      const readBranches = [];
      if ((parts.length <= 3 || used < 3000) && !BRANCH_REF.test(t)) {
        try {
          const names = ((await gh().listBranches(repo.full_name)) ?? []).map((b) => b.name).filter((n) => n !== branch);
          const base = new Map(tree.files.map((f) => [f.path, f.sha]));
          for (const n of names) {
            const bt = await gh().getTree(repo.full_name, n);
            const diff = bt.files.filter((f) => base.get(f.path) !== f.sha);
            await readFiles(n, diff, n + ':');
            readBranches.push(`${n} (отличающихся файлов: ${diff.length})`);
          }
          if (readBranches.length) others = `\nВ основной ветке почти пусто, поэтому прочитаны и остальные ветки — в них только отличия от основной. Заголовок файла вида «ветка:путь». Ветки: ${readBranches.join('; ')}.\n`;
        } catch (e) {
          if (!(e instanceof GithubError)) throw e;
          others = '\n(не удалось прочитать остальные ветки: ' + e.message + ')\n';
        }
      }

      // Единственный жёсткий предел — окно самой модели (≈3 символа на токен, запас под историю и ответ).
      // Ничего молча не отбрасываем: если не влезает — говорим об этом и ждём решения владельца.
      const window = model.ctx || 200000;
      const needTokens = Math.round(used / 3);
      if (needTokens > window - 30000) {
        return {
          error:
            `📚 Репозиторий <b>${escapeHtml(repo.full_name)}</b> (ветка ${escapeHtml(branch)}) — около ${Math.round(needTokens / 1000)} тыс. токенов, а окно модели ${escapeHtml(model.id)} — ${Math.round(window / 1000)} тыс.\n` +
            'Варианты: переключиться на модель с окном побольше (/model — например Claude Opus 5.5, у неё 1 млн) или сказать, какую папку читать.',
          html: true,
        };
      }

      const head =
        `Репозиторий ${repo.full_name} (${repo.private ? 'приватный' : 'публичный'}), ветка ${branch}` +
        (repo.description ? `, описание на GitHub: ${repo.description}` : '') +
        `.\nФайлов в ветке: ${tree.files.length}; прочитано текстовых: ${parts.length}${skipped ? `, пропущено ${skipped} (не читаются или в них секреты)` : ''}.\n` +
        `Пути: ${tree.files.map((f) => f.path).join(', ')}\n${others}`;
      const digest = head + (parts.join('') || '\n(читаемых текстовых файлов нет)\n');
      await store.setSetting('repo_ctx', JSON.stringify({ repo: repo.full_name, ts: D.now(), text: digest }));
      await D.log('repo_read', D.ownerId, { repo: repo.full_name, branch, files: parts.length, chars: used });
      await out.sendHtml(D.ownerId, `📚 Прочитано файлов: ${parts.length} из ${tree.files.length} (~${Math.round(used / 1000)} тыс. символов). Пишу…`);
      return { text: digest, repo: repo.full_name };
    } catch (e) {
      if (e instanceof GithubError) return { error: e.userMessage };
      throw e;
    }
  }

  // ───────── кнопки x:* ─────────

  async function callback(cq, parts) {
    const [act, id] = parts;
    const chatId = cq.message.chat.id;

    if (ACTION_ACTS.has(act)) return actions.callback(cq, parts);

    if (act === 'cj' || act === 'cjx') {
      await out.dropButtons(chatId, cq.message.message_id);
      if (act === 'cjx') {
        await saveJob(null);
        return out.answerCb(cq.id, 'Задача отменена');
      }
      await out.answerCb(cq.id, 'Пишу…');
      if (!(await continueJob(chatId))) await out.sendHtml(chatId, 'Нет начатой задачи — опиши её заново: /code');
      return;
    }

    if (act === 'r') {
      const names = safeJson(await store.getSetting('gh_repos'), []);
      const name = names[Number(id)];
      await out.answerCb(cq.id);
      if (!name) return out.sendHtml(chatId, 'Список устарел — открой /gh заново.');
      return setRepo(chatId, name);
    }

    const d = await store.getDraft(id);
    if (!d || d.kind !== 'code') return out.answerCb(cq.id, 'Черновик не найден', true);
    if (d.status === 'published') return out.answerCb(cq.id, 'Уже отправлено', true);
    if (d.status === 'canceled') return out.answerCb(cq.id, 'Отменено', true);
    const plan = safeJson(d.text, null);
    if (!plan) return out.answerCb(cq.id, 'Черновик повреждён', true);

    if (act === 'cx') {
      await store.updateDraft(id, { status: 'canceled' });
      await setProgress(plan.status, 2, { state: 'cancel', note: 'Отменено тобой — в репозитории ничего не менялось.' });
      await out.answerCb(cq.id, 'Отменено');
      await out.dropButtons(chatId, cq.message.message_id);
      return;
    }
    if (act === 'show') {
      await out.answerCb(cq.id);
      for (const f of plan.files) {
        await D.api.sendDocument({ chat_id: chatId, document: new D.InputFile(utf8Encode(f.content), f.path.split('/').pop(), { type: 'text/plain' }), caption: `${f.action === 'create' ? '➕' : '✏️'} ${f.path}`.slice(0, 1000) });
      }
      if (plan.deletes.length) await out.sendHtml(chatId, '🗑 Удаляются:\n' + plan.deletes.map((p) => '<code>' + escapeHtml(p) + '</code>').join('\n'));
      return;
    }
    if (act === 'pr' || act === 'main') return apply(cq, d, plan, act);
  }

  async function apply(cq, d, plan, mode) {
    const chatId = cq.message.chat.id;
    if (!(await store.claimDraft(d.id, 'ready', 'publishing'))) return out.answerCb(cq.id, 'Уже выполняется', true);
    await out.answerCb(cq.id, 'Отправляю…');
    await out.dropButtons(chatId, cq.message.message_id);
    await setProgress(plan.status, 3, { note: 'Записываю в репозиторий…' });
    const g = gh();
    try {
      // защита ещё раз, по каноническому имени
      const repo = await g.getRepo(plan.repo);
      if (isSelf(repo.full_name)) throw new GithubError('forbidden', 'репозиторий бота');
      const name = repo.full_name;
      const base = plan.base;
      let resultHtml;

      if (plan.empty) {
        // пустой репозиторий: Git Data API недоступен — создаём файлы через Contents API
        for (const f of plan.files) await g.putFile(name, f.path, f.content, plan.commit, undefined);
        resultHtml = `✅ Закоммичено в <code>${escapeHtml(base)}</code>: ${plan.files.length} файл(ов).\nhttps://github.com/${escapeHtml(name)}`;
      } else {
        const ref = await g.getRef(name, base);
        const parent = ref.object.sha;
        const parentCommit = await g.getCommit(name, parent);
        const entries = [];
        for (const f of plan.files) {
          const blob = await g.createBlob(name, f.content);
          entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
        }
        for (const p of plan.deletes) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
        const tree = await g.createTree(name, parentCommit.tree.sha, entries);
        const commit = await g.createCommit(name, plan.commit, tree.sha, [parent]);

        if (mode === 'main') {
          await g.updateRef(name, base, commit.sha);
          resultHtml = `✅ Закоммичено в <code>${escapeHtml(base)}</code>: https://github.com/${escapeHtml(name)}/commit/${commit.sha.slice(0, 7)}`;
        } else {
          // Имя ветки зависит только от черновика, поэтому при повторе после сбоя ветка уже может существовать — это наша ветка:
          // двигаем её на свежий коммит (то же содержимое), а не падаем на «уже существует».
          const branch = `claude/${slug(plan.commit)}-${d.id.slice(-4)}`;
          try {
            await g.createRef(name, branch, commit.sha);
          } catch (e) {
            if (!(e instanceof GithubError && e.kind === 'invalid' && /already exists/i.test(e.message))) throw e;
            await g.updateRef(name, branch, commit.sha, true);
          }
          let prUrl = null;
          try {
            const pr = await g.createPr(name, {
              title: plan.commit,
              head: branch,
              base,
              body: `${plan.summary || ''}\n\n_Подготовлено ИИ-помощником по заданию владельца. Проверь код перед слиянием._`,
            });
            prUrl = pr.html_url;
          } catch (e) {
            if (!(e instanceof GithubError)) throw e;
            // PR из этой ветки уже открыт прошлой попыткой — берём его
            if (e.kind === 'invalid' && /already exists/i.test(e.message)) {
              try {
                prUrl = (await g.findOpenPr(name, branch, base))?.html_url ?? null;
              } catch (e2) {
                if (!(e2 instanceof GithubError)) throw e2;
              }
            }
          }
          resultHtml = prUrl
            ? `✅ Pull Request создан: ${escapeHtml(prUrl)}`
            : `✅ Ветка <code>${escapeHtml(branch)}</code> создана, но PR открыть не получилось: https://github.com/${escapeHtml(name)}/tree/${escapeHtml(branch)}`;
        }
      }
      await store.updateDraft(d.id, { status: 'published', publishedAt: D.now(), link: truncate(resultHtml.replace(/<[^>]+>/g, ''), 300, '') });
      await D.log('code_pushed', chatId, { repo: name, mode, files: plan.files.length + plan.deletes.length });
      await out.sendHtml(chatId, resultHtml);
      await setProgress(plan.status, 4, { note: 'Готово: изменения записаны в репозиторий.' });
    } catch (e) {
      await store.updateDraft(d.id, { status: 'ready' });
      await setProgress(plan.status, 3, { state: 'fail', note: 'Запись не удалась — изменения сохранены, нажми кнопку ещё раз.' });
      if (e instanceof GithubError) {
        await out.sendHtml(chatId, escapeHtml(e.userMessage) + '\n\nИзменения сохранены — нажми кнопку ещё раз, когда исправишь причину.', { reply_markup: kb([[{ text: '🔁 Повторить', callback_data: `x:${mode}:${d.id}` }]]) });
        return;
      }
      throw e;
    }
  }

  return { showGh, setRepo, startTask, onState, callback, runTask, receiveJobPart, finishJob, runsCommand: actions.command, repoContext, maybeAutoTask };
}
