// github.js — минимальный клиент GitHub REST API (через платформенный fetch). Чистый модуль:
// fetch и токен приходят снаружи, поэтому тестируется заглушкой.

import { base64Encode, utf8Encode } from './util.js';

export class GithubError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind; // auth | forbidden | notfound | conflict | invalid | rate | upstream | network
    this.status = status;
  }

  get userMessage() {
    switch (this.kind) {
      case 'auth':
        return '🔑 GitHub не принял токен (401). Проверь секрет GH_PAT: токен мог истечь или быть отозван.';
      case 'forbidden':
        return '🚫 GitHub отказал в доступе (403): у токена нет нужных прав на этот репозиторий. Нужны Contents и Pull requests: Read and write (для GitHub Actions — ещё Actions: Read and write).';
      case 'rate':
        return '⏳ GitHub просит подождать: исчерпан лимит запросов.';
      case 'notfound':
        return '🔎 GitHub не нашёл репозиторий или файл (404). Проверь имя и что у токена есть доступ к этому репозиторию.';
      case 'conflict':
        return '⚠️ Конфликт в GitHub (409): ' + this.message;
      case 'invalid':
        return '⚠️ GitHub отклонил запрос (422): ' + this.message;
      case 'upstream':
        return '🔌 GitHub сейчас недоступен. Попробуй позже.';
      default:
        return '🌐 Не получилось связаться с GitHub' + (this.message ? ` (${this.message.slice(0, 160)})` : '') + '. Попробуй ещё раз; если повторяется — платформа могла временно не пускать запросы на api.github.com.';
    }
  }
}

const seg = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export function createGithub({ fetch, token, base = 'https://api.github.com' }) {
  async function req(method, path, body, { raw = false } = {}) {
    const send = () =>
      fetch(base + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'my-ai-assistant-bot',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let res;
    try {
      try {
        res = await send();
      } catch (e) {
        if (method !== 'GET') throw e; // повторяем только чтение: запись/запуск дважды нельзя
        res = await send(); // разовый сбой сети платформы
      }
    } catch (e) {
      throw new GithubError('network', String(e?.message ?? e));
    }
    if (!res.ok) {
      let msg = '';
      try {
        msg = String(JSON.parse(await res.text())?.message ?? '');
      } catch {
        /* тело не JSON */
      }
      const s = res.status;
      if (s === 401) throw new GithubError('auth', msg, s);
      if (s === 403 || s === 429) throw new GithubError(/rate limit/i.test(msg) || s === 429 ? 'rate' : 'forbidden', msg, s);
      if (s === 404) throw new GithubError('notfound', msg, s);
      if (s === 409) throw new GithubError('conflict', msg, s);
      if (s === 422) throw new GithubError('invalid', msg, s);
      if (s >= 500) throw new GithubError('upstream', msg, s);
      throw new GithubError('invalid', msg || 'HTTP ' + s, s);
    }
    if (raw) return res.text();
    if (res.status === 204) return null;
    return res.json();
  }

  const repoPath = (full) => '/repos/' + full.split('/').map(encodeURIComponent).join('/');

  return {
    me: () => req('GET', '/user'),
    listRepos: () => req('GET', '/user/repos?sort=pushed&per_page=10&affiliation=owner,collaborator,organization_member'),
    getRepo: (full) => req('GET', repoPath(full)),

    /** Дерево файлов ветки. Пустой репозиторий → { empty: true, files: [] }. */
    async getTree(full, branch) {
      try {
        const r = await req('GET', `${repoPath(full)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        return { empty: false, truncated: !!r.truncated, files: (r.tree ?? []).filter((t) => t.type === 'blob').map((t) => ({ path: t.path, size: t.size ?? 0, sha: t.sha })) };
      } catch (e) {
        if (e instanceof GithubError && e.kind === 'conflict') return { empty: true, truncated: false, files: [] }; // «Git Repository is empty»
        throw e;
      }
    },

    getFile: (full, path, ref) => req('GET', `${repoPath(full)}/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`, undefined, { raw: true }),

    listBranches: (full) => req('GET', `${repoPath(full)}/branches?per_page=30`),
    getRef: (full, branch) => req('GET', `${repoPath(full)}/git/ref/heads/${seg(branch)}`),
    getCommit: (full, sha) => req('GET', `${repoPath(full)}/git/commits/${sha}`),
    createBlob: (full, content) => req('POST', `${repoPath(full)}/git/blobs`, { content, encoding: 'utf-8' }),
    createTree: (full, baseTree, tree) => req('POST', `${repoPath(full)}/git/trees`, { base_tree: baseTree, tree }),
    createCommit: (full, message, tree, parents) => req('POST', `${repoPath(full)}/git/commits`, { message, tree, parents }),
    createRef: (full, branch, sha) => req('POST', `${repoPath(full)}/git/refs`, { ref: 'refs/heads/' + branch, sha }),
    updateRef: (full, branch, sha) => req('PATCH', `${repoPath(full)}/git/refs/heads/${seg(branch)}`, { sha, force: false }),
    createPr: (full, { title, head, base, body }) => req('POST', `${repoPath(full)}/pulls`, { title, head, base, body }),

    // ── GitHub Actions
    listWorkflows: (full) => req('GET', `${repoPath(full)}/actions/workflows?per_page=30`),
    /** Запуск workflow_dispatch («Run workflow»). Ответ 204 без тела. */
    dispatch: (full, workflowId, ref, inputs) =>
      req('POST', `${repoPath(full)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, { ref, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) }),
    listRuns: (full, perPage = 6) => req('GET', `${repoPath(full)}/actions/runs?per_page=${perPage}`),
    listWorkflowRuns: (full, workflowId, { event, branch } = {}) =>
      req(
        'GET',
        `${repoPath(full)}/actions/workflows/${encodeURIComponent(workflowId)}/runs?per_page=1` +
          (event ? '&event=' + encodeURIComponent(event) : '') +
          (branch ? '&branch=' + encodeURIComponent(branch) : ''),
      ),
    getJobs: (full, runId) => req('GET', `${repoPath(full)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=30`),
    rerunFailed: (full, runId) => req('POST', `${repoPath(full)}/actions/runs/${encodeURIComponent(runId)}/rerun-failed-jobs`),

    /** Создание файла через Contents API (единственный способ в пустом репозитории). */
    putFile: (full, path, content, message, branch) =>
      req('PUT', `${repoPath(full)}/contents/${seg(path)}`, { message, content: base64Encode(utf8Encode(content)), ...(branch ? { branch } : {}) }),
  };
}
