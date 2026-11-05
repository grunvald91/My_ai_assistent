#!/usr/bin/env node
// VPS heartbeat invokes this script on its five-minute cadence. Read-only on target PRs;
// posts only status snapshots to the central public Issue queue, never merges or edits code.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  routedWriteIssue, trustedExternalPull, validAgentPull, prSnapshot,
  fingerprint, prUpdateComment
} from './superagent-pr-watch-core.mjs';

const HUB = 'grunvald91/Ai_growth_os';
const cli = String(process.env.DSH_AGENT_GH_CLI ?? 'gh');
const root = process.env.DSH_MULTI_REPO_STATE_DIR;
if (!root?.startsWith('/srv/dsh-agent/')) throw new Error('Private DSH state directory must be absolute under /srv/dsh-agent');
const path = join(root, 'external-pr-watch.json');
mkdirSync(root, { recursive: true, mode: 0o700 });

function gh(args) {
  return execFileSync(cli, ['api', ...args], {
    encoding: 'utf8', timeout: 35000, maxBuffer: 12 * 1024 * 1024,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function api(url) {
  const raw = gh([url]);
  return JSON.parse(raw);
}
function post(issue, body) {
  gh(['repos/' + HUB + '/issues/' + issue + '/comments', '--method', 'POST', '-f', 'body=' + body]);
}
let state = { version: 1, watched: {} };
try {
  const loaded = JSON.parse(readFileSync(path, 'utf8'));
  if (loaded.version !== 1 || !loaded.watched || Array.isArray(loaded.watched)) throw new Error('Invalid local monitor state');
  state = loaded;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
function persist() {
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

let discovered = 0;
let published = 0;
let checked = 0;
const failures = [];

// GitHub issues since covers newly created tasks, while persisted registry covers older PRs.
const since = new Date(Date.now() - 30 * 86400_000).toISOString();
for (let page = 1; page <= 10; page++) {
  const items = api('repos/' + HUB + '/issues?state=all&sort=updated&direction=desc&per_page=100&page=' +
    page + '&since=' + encodeURIComponent(since));
  if (!Array.isArray(items)) throw new Error('GitHub issues response is not an array');
  for (const issue of items) {
    const route = routedWriteIssue(issue);
    if (!route || !Number.isSafeInteger(route.issue) || route.issue < 1) continue;
    const key = String(route.issue);
    if (state.watched[key]) continue;
    const comments = api('repos/' + HUB + '/issues/' + key + '/comments?per_page=100');
    const ref = trustedExternalPull(comments, route.issue, route.repo);
    if (!ref) continue;
    state.watched[key] = { repo: ref.repo, number: ref.number, url: ref.url };
    discovered++;
    persist();
  }
  if (items.length < 100) break;
  if (page === 10) throw new Error('Too many recent hub Issues; pagination truncated');
}

for (const [key, watch] of Object.entries(state.watched)) {
  if (!/^[1-9]\d*$/.test(key) || !/^grunvald91\/[A-Za-z0-9_.-]+$/i.test(watch.repo) ||
      !Number.isSafeInteger(watch.number) || watch.number < 1) {
    failures.push('invalid watcher state issue=' + key);
    continue;
  }
  // A closed PR may be reopened. Continue monitoring it for 30 days after closure.
  if (watch.closedAt && Date.now() - Date.parse(watch.closedAt) > 30 * 86400_000) continue;
  try {
    const prefix = 'repos/' + watch.repo;
    const pr = api(prefix + '/pulls/' + watch.number);
    if (!validAgentPull(pr, watch.repo)) throw new Error('PR author, fork or head branch failed validation');
    const sha = String(pr.head.sha);
    const [checks, combined, reviews, reviewComments, requested] = [
      api(prefix + '/commits/' + sha + '/check-runs?per_page=100'),
      api(prefix + '/commits/' + sha + '/status'),
      api(prefix + '/pulls/' + watch.number + '/reviews?per_page=100'),
      api(prefix + '/pulls/' + watch.number + '/comments?per_page=100'),
      api(prefix + '/pulls/' + watch.number + '/requested_reviewers'),
    ];
    const snapshot = prSnapshot(pr, checks, combined, reviews, reviewComments, requested);
    const fp = fingerprint(snapshot);
    checked++;
    if (fp !== watch.fingerprint) {
      const marker = '<!-- superagent-prwatch:v1 issue=' + key + ' fp=' + fp + ' -->';
      // Retry-safe even if comment POST worked but local file save failed.
      const comments = api('repos/' + HUB + '/issues/' + key + '/comments?per_page=100');
      const posted = comments.some(c => String(c.user?.login ?? '').toLowerCase() === 'grunvald1991' &&
        String(c.body ?? '').includes(marker));
      if (!posted) {
        post(key, prUpdateComment(Number(key), snapshot, fp));
        published++;
      }
      watch.fingerprint = fp;
      watch.last = snapshot;
      watch.closedAt = snapshot.state === 'closed' ? (watch.closedAt ?? new Date().toISOString()) : null;
      persist();
    }
  } catch (e) {
    failures.push(key + ':' + String(e?.message ?? e).slice(0, 180));
  }
}
console.log('SUPERAGENT_EXTERNAL_PR_MONITOR registered=' + discovered + ' checked=' + checked + ' updates=' + published + ' errors=' + failures.length);
if (failures.length) {
  for (const failure of failures.slice(0, 5)) console.error('PR_MONITOR_ERROR issue=' + failure);
  process.exitCode = 1;
}
