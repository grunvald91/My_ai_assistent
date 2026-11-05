// Pure validation, aggregation and formatting for external PR monitoring.
// The central Issue queue is public. Never trust PR URLs from issue instructions.
import { createHash } from 'node:crypto';

const ROUTE = /^<!-- superagent-route:v1 repo=(grunvald91\/[A-Za-z0-9_.-]+) mode=write -->$/i;
const TERMINAL = /<!-- superagent-relay:v1 report=[a-f0-9]{20} -->\s*<!-- superagent-result:v1 issue=(\d+) state=ready -->\s*$/i;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?=[/?#\s]|$)/gi;

export function routedWriteIssue(issue) {
  if (issue?.pull_request || String(issue?.user?.login ?? '').toLowerCase() !== 'grunvald91') return null;
  const first = String(issue?.body ?? '').split('\n', 1)[0];
  const match = first.match(ROUTE);
  if (!match || match[1].toLowerCase() === 'grunvald91/ai_growth_os' ||
    match[1].toLowerCase() === 'grunvald91/my_ai_assistent') return null;
  return { issue: Number(issue.number), repo: match[1] };
}

export function trustedExternalPull(comments, issue, repo) {
  for (const c of [...(comments ?? [])].reverse()) {
    if (String(c?.user?.login ?? '').toLowerCase() !== 'grunvald1991') continue;
    if (!TERMINAL.test(String(c.body ?? ''))) continue;
    if (Number(String(c.body).match(TERMINAL)?.[1]) !== Number(issue)) continue;
    const urlMatches = [...String(c.body).matchAll(PR_URL)];
    const match = urlMatches.find(m => (m[1] + '/' + m[2]).toLowerCase() === repo.toLowerCase());
    if (match) return { repo, number: Number(match[3]), url: 'https://github.com/' + repo + '/pull/' + Number(match[3]) };
  }
  return null;
}

export function validAgentPull(pr, repo) {
  if (!pr || !Number.isSafeInteger(Number(pr.number)) || pr.number < 1) return false;
  return String(pr.user?.login ?? '').toLowerCase() === 'grunvald1991' &&
    String(pr.base?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase() &&
    String(pr.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase() &&
    /^agent\/[A-Za-z0-9._/-]+$/.test(String(pr.head?.ref ?? '')) &&
    /^[a-f0-9]{40}$/i.test(String(pr.head?.sha ?? ''));
}

export function prSnapshot(pr, checkRuns, combined, reviews, reviewComments, requested) {
  const sha = String(pr.head.sha);
  if (!Array.isArray(checkRuns?.check_runs) || Number(checkRuns.total_count ?? 0) > checkRuns.check_runs.length) {
    throw new Error('Incomplete PR check-runs page; refusing to report green CI');
  }
  if (!Array.isArray(combined?.statuses) || !Array.isArray(reviews) || !Array.isArray(reviewComments)) {
    throw new Error('Incomplete PR review or status data');
  }
  const runs = checkRuns.check_runs.map(c => ({
    name: String(c.name ?? '').slice(0, 120),
    status: String(c.status ?? 'unknown'),
    conclusion: String(c.conclusion ?? ''),
  })).sort((a,b) => (a.name + a.status).localeCompare(b.name + b.status));
  const legacy = combined.statuses.map(c => ({
    context: String(c.context ?? ''), state: String(c.state ?? 'unknown'),
  })).sort((a,b) => a.context.localeCompare(b.context));
  let ci = 'none';
  const anyFailure = runs.some(x => x.status === 'completed' &&
    !['success', 'neutral', 'skipped'].includes(x.conclusion)) ||
    legacy.some(x => ['error', 'failure'].includes(x.state));
  const anyPending = runs.some(x => x.status !== 'completed') ||
    legacy.some(x => x.state === 'pending');
  if (anyFailure) ci = 'failed';
  else if (anyPending) ci = 'pending';
  else if (runs.length || legacy.length) ci = 'success';

  const latest = new Map();
  for (const review of reviews) {
    const user = String(review?.user?.login ?? '').toLowerCase();
    if (user && user !== 'grunvald1991' && review.state && review.state !== 'PENDING') {
      latest.set(user, { user, state: String(review.state), id: Number(review.id) || 0 });
    }
  }
  const reviewers = [...latest.values()].sort((a,b) => a.user.localeCompare(b.user));
  const requestedUsers = (requested?.users ?? []).map(x => String(x.login ?? '').toLowerCase()).filter(Boolean).sort();
  const requestedTeams = (requested?.teams ?? []).map(x => String(x.slug ?? '').toLowerCase()).filter(Boolean).sort();

  return {
    repo: String(pr.base.repo.full_name), number: Number(pr.number), sha,
    state: String(pr.state), merged: !!(pr.merged || pr.merged_at),
    draft: !!pr.draft, ci, runs, legacy, reviewers,
    requestedUsers, requestedTeams,
    reviewCommentCount: Number(pr.review_comments ?? reviewComments.length),
    latestReviewComment: Math.max(0, ...reviewComments.map(x => Number(x.id) || 0)),
    updatedAt: String(pr.updated_at ?? ''),
  };
}

export function fingerprint(snapshot) {
  // Exclude timestamp: re-fetching the same PR must never generate a duplicate notification.
  const { updatedAt: _ignored, ...stable } = snapshot;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

export function prUpdateComment(issue, snapshot, fp) {
  const state = snapshot.merged ? 'слит' : snapshot.state === 'closed' ? 'закрыт без слияния' :
    snapshot.draft ? 'черновик' : 'открыт';
  const ci = {success:'успешно',pending:'проверки ещё идут',failed:'есть ошибки',none:'проверок нет'}[snapshot.ci] ?? 'неизвестно';
  const changes = snapshot.reviewers.filter(x => x.state === 'CHANGES_REQUESTED').map(x => '@' + x.user);
  const approvals = snapshot.reviewers.filter(x => x.state === 'APPROVED').map(x => '@' + x.user);
  const lines = [
    '### Автоматическое наблюдение за внешним PR',
    '',
    '**PR:** https://github.com/' + snapshot.repo + '/pull/' + snapshot.number,
    '**Состояние:** ' + state + (snapshot.merged ? ' ✅' : ''),
    '**Последний commit:** \`' + snapshot.sha.slice(0, 12) + '\`',
    '**CI:** ' + ci + ' (' + snapshot.runs.length + ' checks, ' + snapshot.legacy.length + ' commit statuses)',
    '**Ревью:** ' + (changes.length ? 'запрошены изменения ' + changes.join(', ') :
      approvals.length ? 'одобрено ' + approvals.join(', ') : 'нет активных требований изменить код'),
    '**Запрошенные ревьюеры:** ' + [...snapshot.requestedUsers.map(x => '@'+x), ...snapshot.requestedTeams.map(x => 'team:'+x)].join(', ').slice(0, 250) || '**Запрошенные ревьюеры:** нет',
    '**Комментарии к коду:** ' + snapshot.reviewCommentCount,
    '',
    'Слежение выполняется на VPS без слияния, деплоя и автоматического изменения ветки.',
    '<!-- superagent-prwatch:v1 issue=' + issue + ' fp=' + fp + ' -->',
  ];
  return lines.join('\n');
}

export function latestPrWatchComment(comments, issue) {
  const re = new RegExp('<!-- superagent-prwatch:v1 issue=' + Number(issue) + ' fp=([0-9a-f]{24}) -->');
  return [...(comments ?? [])].reverse().find(c =>
    String(c.user?.login ?? '').toLowerCase() === 'grunvald1991' && re.test(String(c.body ?? ''))) ?? null;
}
