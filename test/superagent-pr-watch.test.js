import test from 'node:test';
import assert from 'node:assert/strict';
import {
  routedWriteIssue, trustedExternalPull, validAgentPull, prSnapshot,
  fingerprint, prUpdateComment, latestPrWatchComment,
} from '../scripts/superagent-pr-watch-core.mjs';

const issue = {
  number: 295, user: { login: 'grunvald91' },
  body: '<!-- superagent-route:v1 repo=grunvald91/booking_bot mode=write -->\n@Grunvald1991\n## Task',
};
const terminal = (body = 'Draft PR opened: https://github.com/grunvald91/booking_bot/pull/139') => ({
  user: { login: 'Grunvald1991' },
  body: body + '\n<!-- superagent-relay:v1 report=0123456789abcdef0123 -->\n<!-- superagent-result:v1 issue=295 state=ready -->',
});
const pr = {
  number: 139, user: { login: 'Grunvald1991' },
  base: { repo: { full_name: 'grunvald91/booking_bot' } },
  head: { repo: { full_name: 'grunvald91/booking_bot' }, ref: 'agent/multirepo-external-pr-e2e-20261106', sha: 'a'.repeat(40) },
  state: 'open', draft: true, merged: false, review_comments: 0,
};
const checks = { total_count: 1, check_runs: [{ name:'unit', status:'in_progress', conclusion:null }] };
const status = { state:'pending', statuses: [] };
const review = { id: 1, user: { login:'reviewer' }, state: 'CHANGES_REQUESTED' };
const requested = { users: [{login:'example'}], teams: [] };

test('only owner-created explicit external write route is monitored', () => {
  assert.deepEqual(routedWriteIssue(issue), { issue:295, repo:'grunvald91/booking_bot' });
  assert.equal(routedWriteIssue({ ...issue, user:{login:'other'} }), null);
  assert.equal(routedWriteIssue({ ...issue, pull_request:{} }), null);
  assert.equal(routedWriteIssue({ ...issue, body:issue.body.replace('mode=write','mode=read') }), null);
  assert.equal(routedWriteIssue({ ...issue, body:issue.body.replace('booking_bot','Ai_growth_os') }), null);
});

test('trusted terminal report is the only source of an external PR mapping', () => {
  const nonTerminal = {user:{login:'Grunvald1991'},body:'https://github.com/grunvald91/booking_bot/pull/139'};
  const evil = {...terminal(), user:{login:'not-the-agent'}};
  const wrongIssue = {...terminal(),body:terminal().body.replace('issue=295','issue=294')};
  assert.equal(trustedExternalPull([nonTerminal,evil,wrongIssue],295,'grunvald91/booking_bot'),null);
  const result = trustedExternalPull([nonTerminal,terminal()],295,'grunvald91/booking_bot');
  assert.deepEqual(result,{repo:'grunvald91/booking_bot',number:139,url:'https://github.com/grunvald91/booking_bot/pull/139'});
  assert.equal(trustedExternalPull([terminal()],295,'grunvald91/SMENA'),null);
});

test('validate real external PR authorship, same-repo origin and agent branch', () => {
  assert.equal(validAgentPull(pr,'grunvald91/booking_bot'),true);
  assert.equal(validAgentPull({...pr,user:{login:'other'}},'grunvald91/booking_bot'),false);
  assert.equal(validAgentPull({...pr,head:{...pr.head,repo:{full_name:'other/fork'}}},'grunvald91/booking_bot'),false);
  assert.equal(validAgentPull({...pr,head:{...pr.head,ref:'main'}},'grunvald91/booking_bot'),false);
});

test('absence of checks is unknown, never represented as passing CI', () => {
  const snap=prSnapshot(pr,{total_count:0,check_runs:[]},{statuses:[]},[],[],{});
  assert.equal(snap.ci,'none');
  assert.equal(snap.draft,true);
  assert.match(prUpdateComment(295,snap,fingerprint(snap)),/проверок нет/);
});

test('tracks checks, commit-status failures and newest effective review', () => {
  const pending=prSnapshot(pr,checks,status,[review],[],requested);
  assert.equal(pending.ci,'pending');
  assert.equal(pending.reviewers[0].state,'CHANGES_REQUESTED');
  const approved=prSnapshot(pr,{total_count:1,check_runs:[{name:'unit',status:'completed',conclusion:'success'}]},
    {statuses:[{context:'lint',state:'success'}]},[review,{id:2,user:{login:'reviewer'},state:'APPROVED'}],[],requested);
  assert.equal(approved.ci,'success');
  assert.equal(approved.reviewers[0].state,'APPROVED');
  assert.notEqual(fingerprint(pending),fingerprint(approved));
  const failing=prSnapshot(pr,{total_count:1,check_runs:[{name:'unit',status:'completed',conclusion:'failure'}]},
    {statuses:[]},[],[],{});
  assert.equal(failing.ci,'failed');
});

test('tracks comments and requested reviewer changes without duplicate notifications', () => {
  const a=prSnapshot(pr,{total_count:0,check_runs:[]},{statuses:[]},[],[],{users:[],teams:[]});
  const b=prSnapshot({...pr,review_comments:1},{total_count:0,check_runs:[]},{statuses:[]},
    [],[{id:45}],{users:[{login:'reviewer'}],teams:[]});
  assert.notEqual(fingerprint(a),fingerprint(b));
  assert.equal(fingerprint({...a,updatedAt:'later'}),fingerprint(a));
  const msg=prUpdateComment(295,b,fingerprint(b));
  assert.match(msg,/superagent-prwatch:v1 issue=295 fp=[a-f0-9]{24}/);
  assert.match(msg,/Комментарии к коду:\*\* 1/);
  assert.ok(latestPrWatchComment([{body:msg,user:{login:'Grunvald1991'}}],295));
  assert.equal(latestPrWatchComment([{body:msg,user:{login:'someoneElse'}}],295),null);
});

test('refuse truncated check run lists and invalid reviews rather than claim success', () => {
  assert.throws(()=>prSnapshot(pr,{total_count:120,check_runs:[]},{statuses:[]},[],[],{}),/Incomplete/);
  assert.throws(()=>prSnapshot(pr,{total_count:0,check_runs:[]},{statuses:[]},null,[],{}),/Incomplete/);
});

test('merged and closed PR updates are distinct states', () => {
  const a=prSnapshot({...pr,merged:true,state:'closed',draft:false},{total_count:0,check_runs:[]},{statuses:[]},[],[],{});
  assert.match(prUpdateComment(295,a,fingerprint(a)),/Состояние:\*\* слит/);
  assert.notEqual(fingerprint(a),fingerprint(prSnapshot({...pr,state:'closed',draft:false},{total_count:0,check_runs:[]},{statuses:[]},[],[],{})));
});
