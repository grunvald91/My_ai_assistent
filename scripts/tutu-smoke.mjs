// One read-only live schema check during PR CI. No tokens, private data or booking calls.
import { callTutuTool, normalizeDepartures } from '../tgcloud/lib/transit.js';

const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const plan = { origin: 'Сочи', destination: 'Адлер', date: today, timezoneHours: 3, kind: 'search_etrain' };
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 18000);
try {
  const data = await callTutuTool((url, opts) => fetch(url, { ...opts, signal: controller.signal }), 'search_etrain', plan);
  const list = Array.isArray(data) ? data :
    ['offers', 'trips', 'trains', 'results', 'routes', 'items'].map((k) => data?.[k]).find(Array.isArray) || [];
  const valid = normalizeDepartures(data, plan, Math.floor(Date.now() / 1000));
  console.log('Tutu MCP live schema', JSON.stringify({
    ok: true, date: today, payloadKeys: Object.keys(data).slice(0, 16), totalEntries: list.length,
    entryFields: list[0] ? Object.keys(list[0]).slice(0, 25) : [],
    parsedFutureDepartures: valid.length,
    complete: data?.meta?.complete ?? null,
  }));
} catch (e) {
  console.log('Tutu MCP live schema not confirmed:', String(e?.message ?? e).slice(0, 180));
} finally {
  clearTimeout(timeout);
}
