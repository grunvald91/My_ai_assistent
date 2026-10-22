// actions.js — GitHub Actions из бота: посмотреть последние запуски, нажать «Run workflow» (workflow_dispatch),
// понять, что упало, перезапустить упавшие задачи.
//
// Границы безопасности те же, что у /code: репозиторий самого бота запрещён (проверка по каноническому имени
// из ответа GitHub); запуск — только после кнопки «Запустить» (workflow выполняется с секретами репозитория).
// Нужны права токена: Actions — Read and write (чтение запусков — Read), для правки файлов workflow ещё Workflows.

import { GithubError } from './github.js';
import { escapeHtml, truncate, safeJson, shortTime } from './util.js';

const kb = (rows) => ({ inline_keyboard: rows });

const ICON = { success: '✅', failure: '❌', startup_failure: '❌', timed_out: '⏱', action_required: '✋' };
const WORD = {
  success: 'успешно',
  failure: 'упал',
  startup_failure: 'не стартовал',
  timed_out: 'превышено время',
  cancelled: 'отменён',
  skipped: 'пропущен',
  neutral: 'нейтрально',
  action_required: 'нужно действие',
  stale: 'устарел',
};
export const runIcon = (r) => (r.status === 'completed' ? ICON[r.conclusion] ?? '⚪' : '🟡');
export const runWord = (r) => (r.status === 'completed' ? WORD[r.conclusion] ?? r.conclusion ?? '—' : r.status === 'queued' || r.status === 'pending' || r.status === 'waiting' ? 'в очереди' : 'выполняется');
const isFailed = (r) => r.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion);

export function createActions(D, { gh, isSelf, noToken, fail }) {
  const { store, out } = D;
  const tz = D.cfg.tzOffsetHours;

  const rightsMsg =
    '🚫 У токена нет права на GitHub Actions.\nВ настройках токена GH_PAT добавь <b>Actions</b> — Read and write (для правки файлов в .github/workflows — ещё <b>Workflows</b> — Read and write), ' +
    'обнови секрет GH_PAT в репозитории бота и перезапусти деплой.';

  async function guard(chatId, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GithubError && e.kind === 'forbidden') {
        await out.sendHtml(chatId, rightsMsg);
        return undefined;
      }
      if (e instanceof GithubError && e.kind === 'notfound') {
        await out.sendHtml(chatId, '🔎 GitHub не нашёл репозиторий или workflow (404). Проверь имя, ветку и что у токена есть доступ к репозиторию.');
        return undefined;
      }
      return fail(chatId, e);
    }
  }

  async function show(chatId, editMsgId, html, markup) {
    if (editMsgId) {
      try {
        await out.editHtml(chatId, editMsgId, html, markup);
        return;
      } catch {
        /* сообщение не редактируется — пришлём новое */
      }
    }
    await out.sendHtml(chatId, html, { reply_markup: markup });
  }

  /** Активный репозиторий (канонический, не бот). null — уже объяснили пользователю. */
  async function activeRepo(chatId) {
    if (!gh()) {
      await out.sendHtml(chatId, noToken());
      return null;
    }
    const full = await store.getSetting('gh_repo');
    if (!full) {
      await out.sendHtml(chatId, 'Сначала выбери репозиторий: /gh или <code>/repo владелец/имя</code>');
      return null;
    }
    const repo = await gh().getRepo(full);
    if (isSelf(repo.full_name)) {
      await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя. Выбери другой: /gh');
      return null;
    }
    return repo;
  }

  /** Workflow репозитория + пометка, есть ли у файла триггер workflow_dispatch (иначе «Run workflow» не существует). */
  async function loadWorkflows(repo) {
    const r = await gh().listWorkflows(repo.full_name);
    const active = (r?.workflows ?? []).filter((w) => w.state === 'active');
    return Promise.all(
      active.slice(0, 12).map(async (w) => {
        let dispatch = false;
        try {
          dispatch = /\bworkflow_dispatch\b/.test(await gh().getFile(repo.full_name, w.path, repo.default_branch));
        } catch {
          /* файл не прочитался — считаем, что кнопки нет */
        }
        return { id: w.id, name: w.name, path: w.path, dispatch };
      }),
    );
  }

  // ───────── панель /runs ─────────

  async function panel(chatId, editMsgId) {
    await guard(chatId, async () => {
      const repo = await activeRepo(chatId);
      if (!repo) return;
      const [runsRes, wfs] = await Promise.all([gh().listRuns(repo.full_name, 6), loadWorkflows(repo)]);
      const runs = runsRes?.workflow_runs ?? [];
      await store.setSetting('gh_wf', JSON.stringify(wfs));

      const lines = runs.map(
        (r) =>
          `${runIcon(r)} <a href="${escapeHtml(r.html_url)}">${escapeHtml(truncate(r.name || r.display_title || 'run', 40))}</a> #${r.run_number} · ${escapeHtml(r.head_branch ?? '')} · ${escapeHtml(r.event ?? '')} · ${runWord(r)} · ${shortTime(Date.parse(r.created_at) / 1000, tz)}`,
      );
      const noBtn = wfs.filter((w) => !w.dispatch);
      let html = `⚙️ <b>${escapeHtml(repo.full_name)}</b> — GitHub Actions\n\n`;
      html += lines.length ? '<b>Последние запуски:</b>\n' + lines.join('\n') : 'Запусков пока не было.';
      if (!wfs.length) html += '\n\nWorkflow в репозитории нет. Могу создать: <code>/code создай workflow, который …</code>';
      else if (wfs.some((w) => w.dispatch)) {
        html += '\n\n<b>Run workflow</b> — выбери, что запустить (на ветке <code>' + escapeHtml(repo.default_branch) + '</code>).';
        html += '\nДругая ветка или параметры: <code>/runs файл.yml ветка имя=значение</code>';
      }
      if (noBtn.length) html += `\n\nБез кнопки запуска (нет триггера workflow_dispatch): ${noBtn.map((w) => '<code>' + escapeHtml(w.path.split('/').pop()) + '</code>').join(', ')}`;

      const rows = [];
      wfs.forEach((w, i) => {
        if (w.dispatch) rows.push([{ text: truncate('▶️ ' + w.name, 60), callback_data: 'x:w:' + i }]);
      });
      for (const r of runs.filter(isFailed).slice(0, 2)) rows.push([{ text: truncate(`🔍 Что упало: #${r.run_number} ${r.name ?? ''}`, 60), callback_data: 'x:j:' + r.id }]);
      rows.push([{ text: '🔄 Обновить', callback_data: 'x:ru' }]);
      await show(chatId, editMsgId, html, kb(rows));
    });
  }

  // ───────── запуск ─────────

  async function askConfirm(chatId, repo, wf, ref, inputs) {
    await store.setSetting('gh_run_pending', JSON.stringify({ repo: repo.full_name, id: wf.id, name: wf.name, path: wf.path, ref, inputs }));
    const inp = Object.entries(inputs ?? {});
    await out.sendHtml(
      chatId,
      `▶️ Запустить <b>${escapeHtml(wf.name)}</b> (<code>${escapeHtml(wf.path)}</code>)\nрепозиторий <code>${escapeHtml(repo.full_name)}</code>, ветка <code>${escapeHtml(ref)}</code>` +
        (inp.length ? '\nпараметры: ' + inp.map(([k, v]) => `<code>${escapeHtml(k)}=${escapeHtml(v)}</code>`).join(' ') : '') +
        '\n\n⚠️ Workflow выполнится с секретами репозитория и может, например, выкатить релиз. Запускаем?',
      { reply_markup: kb([[{ text: '▶️ Запустить', callback_data: 'x:go', style: 'success' }, { text: '✖️ Отмена', callback_data: 'x:wx', style: 'danger' }]]) },
    );
  }

  /** /runs  или  /runs <workflow> [ветка] [ключ=значение …] */
  async function command(chatId, arg) {
    if (!arg) return panel(chatId);
    await guard(chatId, async () => {
      const repo = await activeRepo(chatId);
      if (!repo) return;
      const tokens = arg.trim().split(/\s+/);
      const q = tokens.shift().toLowerCase();
      const inputs = {};
      let ref = null;
      for (const t of tokens) {
        const i = t.indexOf('=');
        if (i > 0) inputs[t.slice(0, i)] = t.slice(i + 1);
        else if (!ref) ref = t;
      }
      const wfs = await loadWorkflows(repo);
      const file = (w) => w.path.split('/').pop().toLowerCase();
      const wf = wfs.find((w) => file(w) === q || w.path.toLowerCase() === q || w.name.toLowerCase() === q) ?? wfs.find((w) => file(w).includes(q) || w.name.toLowerCase().includes(q));
      if (!wf) {
        await out.sendHtml(chatId, `Не нашёл workflow «${escapeHtml(q)}». Список: /runs`);
        return;
      }
      if (!wf.dispatch) {
        await out.sendHtml(chatId, `У <code>${escapeHtml(wf.path)}</code> нет триггера <code>workflow_dispatch</code> — вручную его не запустить. Могу добавить: <code>/code добавь workflow_dispatch в ${escapeHtml(wf.path)}</code>`);
        return;
      }
      await askConfirm(chatId, repo, wf, ref || repo.default_branch, inputs);
    });
  }

  async function dispatchPending(cq) {
    const chatId = cq.message.chat.id;
    const p = safeJson(await store.getSetting('gh_run_pending'), null);
    await out.dropButtons(chatId, cq.message.message_id);
    if (!p) return out.answerCb(cq.id, 'Запрос устарел — открой /runs заново', true);
    await store.setSetting('gh_run_pending', null); // одна кнопка — один запуск
    await out.answerCb(cq.id, 'Запускаю…');
    await guard(chatId, async () => {
      const repo = await gh().getRepo(p.repo);
      if (isSelf(repo.full_name)) {
        await out.sendHtml(chatId, '🚫 Репозиторий самого бота трогать нельзя.');
        return;
      }
      try {
        await gh().dispatch(repo.full_name, p.id, p.ref, p.inputs);
      } catch (e) {
        if (e instanceof GithubError && e.kind === 'invalid') {
          await out.sendHtml(chatId, `⚠️ GitHub не принял запуск: ${escapeHtml(e.message)}\nПроверь ветку и параметры (<code>/runs файл.yml ветка имя=значение</code>).`);
          return;
        }
        throw e;
      }
      await D.log('actions_dispatch', chatId, { repo: repo.full_name, workflow: p.path, ref: p.ref });
      // Запуск появляется не мгновенно — один раз заглядываем через пару секунд, чтобы дать ссылку
      let link = '';
      try {
        await D.sleep?.(3000);
        const r = (await gh().listWorkflowRuns(repo.full_name, p.id, { event: 'workflow_dispatch', branch: p.ref }))?.workflow_runs?.[0];
        if (r && D.now() - Date.parse(r.created_at) / 1000 < 120) link = `\n<a href="${escapeHtml(r.html_url)}">Запуск #${r.run_number}</a> · ${runWord(r)}`;
      } catch {
        /* ссылка — приятное дополнение, не обязательная часть */
      }
      await out.sendHtml(chatId, `✅ Запущено: <b>${escapeHtml(p.name)}</b> на ветке <code>${escapeHtml(p.ref)}</code>.${link}\nСтатус: /runs`);
    });
  }

  // ───────── что упало / перезапуск ─────────

  async function jobs(chatId, runId) {
    await guard(chatId, async () => {
      const repo = await activeRepo(chatId);
      if (!repo) return;
      const r = await gh().getJobs(repo.full_name, runId);
      const list = r?.jobs ?? [];
      const bad = list.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'cancelled');
      let html = `🔍 <b>Запуск ${escapeHtml(String(runId))}</b>\n\n`;
      if (!list.length) html += 'Задач нет.';
      for (const j of list) {
        html += `${j.status === 'completed' ? ICON[j.conclusion] ?? '⚪' : '🟡'} ${escapeHtml(j.name)}\n`;
        for (const s of (j.steps ?? []).filter((x) => x.conclusion === 'failure')) html += `    ↳ упал шаг: <code>${escapeHtml(truncate(s.name, 80))}</code>\n`;
      }
      const link = list[0]?.html_url ? `\n<a href="${escapeHtml(list[0].html_url)}">Открыть логи на GitHub</a> (текст логов я не скачиваю)` : '';
      await out.sendHtml(chatId, html + link, {
        
        ...(bad.length ? { reply_markup: kb([[{ text: '♻️ Перезапустить упавшие', callback_data: 'x:rr:' + runId }]]) } : {}),
      });
    });
  }

  async function rerun(cq, runId) {
    const chatId = cq.message.chat.id;
    await out.dropButtons(chatId, cq.message.message_id);
    await out.answerCb(cq.id, 'Перезапускаю…');
    await guard(chatId, async () => {
      const repo = await activeRepo(chatId);
      if (!repo) return;
      await gh().rerunFailed(repo.full_name, runId);
      await D.log('actions_rerun', chatId, { repo: repo.full_name, run: runId });
      await out.sendHtml(chatId, '♻️ Упавшие задачи запущены заново. Статус: /runs');
    });
  }

  // ───────── кнопки x:w / go / wx / ru / j / rr ─────────

  async function callback(cq, parts) {
    const [act, arg] = parts;
    const chatId = cq.message.chat.id;
    if (act === 'ru') {
      await out.answerCb(cq.id, 'Обновляю…');
      return panel(chatId, cq.message.message_id);
    }
    if (act === 'w') {
      await out.answerCb(cq.id);
      const wfs = safeJson(await store.getSetting('gh_wf'), []);
      const wf = wfs[Number(arg)];
      if (!wf) return out.sendHtml(chatId, 'Список устарел — открой /runs заново.');
      await guard(chatId, async () => {
        const repo = await activeRepo(chatId);
        if (repo) await askConfirm(chatId, repo, wf, repo.default_branch, {});
      });
      return undefined;
    }
    if (act === 'go') return dispatchPending(cq);
    if (act === 'wx') {
      await store.setSetting('gh_run_pending', null);
      await out.dropButtons(chatId, cq.message.message_id);
      return out.answerCb(cq.id, 'Отменено');
    }
    if (act === 'j') {
      await out.answerCb(cq.id);
      return jobs(chatId, arg);
    }
    if (act === 'rr') return rerun(cq, arg);
    return out.answerCb(cq.id);
  }

  return { command, panel, callback };
}

export const ACTION_ACTS = new Set(['w', 'go', 'wx', 'ru', 'j', 'rr']);
