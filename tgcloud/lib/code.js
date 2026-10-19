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
import { escapeHtml, truncate, uid, safeJson, utf8Encode } from './util.js';

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
    '3. Права: <b>Contents</b> — Read and write, <b>Pull requests</b> — Read and write, Metadata — Read; чтобы создавать GitHub Actions — ещё <b>Workflows</b> — Read and write.\n' +
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
      await out.sendHtml(chatId, '🧑‍💻 Опиши задачу: что сделать в репозитории. /cancel — отмена.');
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

  async function runTask(chatId, task) {
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

      // 2) изменения
      await out.sendHtml(chatId, `✍️ Читал файлов: ${contents.length}. Пишу код — это может занять минуту…`);
      await out.typing(chatId);
      const user =
        `ЗАДАНИЕ:\n${task}\n\n` +
        `ВСЕ ФАЙЛЫ (пути):\n${cands.map((f) => f.path).join('\n') || '(пусто)'}\n\n` +
        contents.map((c) => `=== СОДЕРЖИМОЕ ${c.path} ===\n${c.text}\n=== КОНЕЦ ${c.path} ===`).join('\n\n');
      const res = await core.generate({
        model,
        messages: [{ role: 'system', content: codeSystem({ repo: repo.full_name, branch, empty: tree.empty }) }, { role: 'user', content: user }],
        maxTokens: cfg.maxTokensCode,
        stream: true,
      });
      await prepareDraft(chatId, { task, repo, branch, tree, text: res.text, finish: res.finish });
    } catch (e) {
      await fail(chatId, e);
    }
  }

  async function prepareDraft(chatId, { task, repo, branch, tree, text, finish }) {
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
      return;
    }

    const secrets = [...new Set(files.flatMap((f) => findSecrets(f.content)))];
    if (secrets.length) {
      await out.sendHtml(chatId, `🛑 В коде нашлись секреты (${escapeHtml(secrets.join(', '))}) — такое я не коммичу. Переформулируй задачу: ключи должны браться из переменных окружения.`);
      await D.log('code_secret_blocked', chatId, { repo: repo.full_name });
      return;
    }

    if (!files.length && !deletes.length) {
      await out.sendHtml(chatId, '🤷 Изменений нет.\n\n' + escapeHtml(ch.summary || truncate(text, 1500) || 'Модель не предложила правок.') + (problems.length ? '\n\n⚠️ ' + escapeHtml(problems.join('; ')) : ''));
      return;
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
    };
    const id = uid();
    await store.createDraft({ id, kind: 'code', brief: truncate(task, 2000, ''), text: JSON.stringify(plan), format: 'md', status: 'ready', rev: 1, createdAt: D.now() });

    const list = [
      ...files.map((f) => `${f.action === 'create' ? '➕' : '✏️'} <code>${escapeHtml(f.path)}</code> (${kb1(f.bytes)})`),
      ...deletes.map((p) => `🗑 <code>${escapeHtml(p)}</code>`),
    ].join('\n');
    const rows = tree.empty
      ? [[{ text: `⬆️ Закоммитить в ${branch}`, callback_data: 'x:main:' + id }]]
      : [[{ text: '🌿 Ветка + Pull Request', callback_data: 'x:pr:' + id }], [{ text: `⬆️ Сразу в ${branch}`, callback_data: 'x:main:' + id }]];
    rows.push([{ text: '📄 Показать код', callback_data: 'x:show:' + id }, { text: '✖️ Отмена', callback_data: 'x:cx:' + id }]);

    await out.sendHtml(
      chatId,
      `🧑‍💻 <b>${escapeHtml(repo.full_name)}</b> · ${repo.private ? 'приватный' : 'публичный'} · ветка <code>${escapeHtml(branch)}</code>\n` +
        `<b>Коммит:</b> ${escapeHtml(plan.commit)}\n\n${escapeHtml(truncate(ch.summary, 1200))}\n\n<b>Файлы (${files.length + deletes.length}):</b>\n${list}` +
        (warnings.length ? '\n\n⚠️ ' + escapeHtml(warnings.join('; ')) : '') +
        '\n\nНичего не отправлено. Выбери действие:',
      { reply_markup: kb(rows) },
    );
    await D.log('code_draft', chatId, { id, repo: repo.full_name, files: files.length });
  }

  // ───────── кнопки x:* ─────────

  async function callback(cq, parts) {
    const [act, id] = parts;
    const chatId = cq.message.chat.id;

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
          const branch = `claude/${slug(plan.commit)}-${d.id.slice(-4)}`;
          await g.createRef(name, branch, commit.sha);
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
          }
          resultHtml = prUrl
            ? `✅ Pull Request создан: ${escapeHtml(prUrl)}`
            : `✅ Ветка <code>${escapeHtml(branch)}</code> создана, но PR открыть не получилось: https://github.com/${escapeHtml(name)}/tree/${escapeHtml(branch)}`;
        }
      }
      await store.updateDraft(d.id, { status: 'published', publishedAt: D.now(), link: truncate(resultHtml.replace(/<[^>]+>/g, ''), 300, '') });
      await D.log('code_pushed', chatId, { repo: name, mode, files: plan.files.length + plan.deletes.length });
      await out.sendHtml(chatId, resultHtml);
    } catch (e) {
      await store.updateDraft(d.id, { status: 'ready' });
      if (e instanceof GithubError) {
        await out.sendHtml(chatId, escapeHtml(e.userMessage) + '\n\nИзменения сохранены — нажми кнопку ещё раз, когда исправишь причину.', { reply_markup: kb([[{ text: '🔁 Повторить', callback_data: `x:${mode}:${d.id}` }]]) });
        return;
      }
      throw e;
    }
  }

  return { showGh, setRepo, startTask, onState, callback, runTask };
}
