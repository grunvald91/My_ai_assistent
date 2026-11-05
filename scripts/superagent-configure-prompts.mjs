#!/usr/bin/env node
// Idempotently install DSH prompt exceptions required for external-PR tickets.
// Run on the VPS after backing up the current DSH prompts. This calls only loopback APIs.
const url = process.env.DSH_SUPERAGENT_URL ?? '';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url)) {
  throw new Error('DSH_SUPERAGENT_URL must be http://127.0.0.1:PORT');
}
const base = url.replace(/\/$/, '') + '/orchestrator/api';
async function api(path, method = 'GET', body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(method + ' ' + path + ': ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
const state = await api('/prompts');
const config = structuredClone(state.current.config);
const tag = 'superagent-external-pr-v1';
const rule = [
  '',
  '### ' + tag,
  'For a Telegram task whose central Ai_growth_os Issue declares <!-- superagent-route:v1 repo=... -->:',
  'The target is the git origin of this ticket directory, not necessarily DSH_SUPERAGENT_GITHUB_REPOSITORY.',
  'If the target differs from the DSH GitHub Source, create the feature branch and PR in that target with gh --repo OWNER/NAME.',
  'Never pass an EXTERNAL PR number to orchestrator_report.pr_number or use DSH PR binding, since it resolves that number in the Source repository.',
  'Instead call orchestrator_report with pr_number omitted and include the full external PR URL in summary.',
  'Do not enable auto-merge or merge an external PR; the human reviews and merges it.',
  'After a terminal worker report, the VPS terminal relay creates a machine-readable GitHub Issue comment. Do not fabricate a terminal marker in a progress or acknowledgement comment.',
].join('\n');
const override = (key) => {
  const built = state.parts?.find(p => p.key === key);
  if (!built?.text) throw new Error('Cannot locate DSH prompt part ' + key);
  const current = config.overrides?.[key]?.text ?? built.text;
  if (current.includes(tag)) return;
  config.overrides ??= {};
  config.overrides[key] = { text: current + '\n' + rule, base: config.overrides[key]?.base ?? built.base };
};
for (const key of ['runtime/work', 'skill/github']) override(key);
if (!config.delivery.includes(tag)) config.delivery += '\n' + rule;
if (JSON.stringify(config) === JSON.stringify(state.current.config)) {
  console.log('DSH external PR instructions already configured');
  process.exit(0);
}
const result = await api('/prompts', 'PUT', { config, baseRevision: state.current.revision });
console.log('Saved DSH prompt revision ' + result.revision);
