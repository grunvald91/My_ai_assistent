// Shared result protocol between tgcloud and GitHub Actions watcher.
// Native DSH appends <!-- dsh-superagent:... --> to EVERY outgoing comment.
// Never interpret those markers or ordinary comments as a completed task.
const TERMINAL_MARKER = /(?:^|\n)<!--\s*superagent-relay:v1\s+report=([0-9a-f]{20})\s*-->\s*\n<!--\s*superagent-result:v1\s+issue=(\d+)\s+state=(ready|blocked|failed|dropped)\s*-->(?=\s*(?:\n<!--\s*dsh-superagent:[0-9a-f]+\s*-->)?\s*$)/i;

export function parseTerminalResult(body, issue) {
  const match = String(body ?? '').match(TERMINAL_MARKER);
  return match && match[2] === String(issue) ? { issue: Number(match[2]), state: match[3].toLowerCase() } : null;
}

export function finalAgentComment(comments, issue, login = 'Grunvald1991') {
  return (Array.isArray(comments) ? comments : []).filter(comment =>
    String(comment?.user?.login ?? '').toLowerCase() === login.toLowerCase() &&
    !!parseTerminalResult(comment?.body, issue)
  ).at(-1) ?? null;
}
