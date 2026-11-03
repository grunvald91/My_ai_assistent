import test from 'node:test';
import { createWorld, OWNER, assert } from './helpers/world.js';
import {
  parseTransitIntent, normalizeDepartures, formatTransitResponse, callTutuTool, TUTU_MCP_URL,
} from '../tgcloud/lib/transit.js';

test('Туту MCP: ближайшую электричку берём из настоящего структурированного результата, без LLM', async () => {
  const w = await createWorld({ exaKey: 'exa-test' });
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  const calls = w.tutuCalls;
  assert.deepEqual(calls.map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(calls[2].params.name, 'search_etrain');
  assert.equal(calls[2].params.arguments.origin, 'Сочи');
  assert.equal(calls[2].params.arguments.destination, 'Адлер');
  assert.equal(calls[2].params.arguments.departure_date, '2027-01-15');
  assert.equal(w.llmCalls.length, 0);
  assert.equal(w.exaCalls.length, 0, 'для расписания MCP в приоритете над Exa');
  const txt = w.last(OWNER).text;
  assert.match(txt, /Туту MCP: Сочи → Адлер/);
  assert.match(txt, /https:\/\/mcp.tutu.ru\/mcp/);
  const t = normalizeDepartures({ offers: [
    { departure_at: new Date((w.now + 4200) * 1000).toISOString() },
    { departure_at: new Date((w.now + 900) * 1000).toISOString() },
  ] }, { origin: 'Сочи', timezoneHours: 3, date: '2027-01-15' }, w.now);
  assert.ok(t[0].at < t[1].at, 'сортируем по времени, не по стоимости');
  assert.ok(txt.includes(t[0].time), 'точные часы из провайдера не теряются фильтром Exa');
});

test('Короткое «А следующая?» сохраняет маршрут и запрашивает Туту заново', async () => {
  const w = await createWorld();
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  const first = w.last(OWNER).text;
  await w.say('А следующая?');
  assert.equal(w.tutuCalls.filter((x) => x.method === 'tools/call').length, 2);
  assert.equal(w.llmCalls.length, 0);
  assert.notEqual(first, w.last(OWNER).text);
  assert.match(w.last(OWNER).text, /Туту MCP/);
});

test('Некорректная выдача Туту не превращается в выдуманные минуты', async () => {
  const w = await createWorld();
  w.tutuReply = { offers: [{ price: 199, name: 'недостаточно полей' }], meta: { complete: false } };
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  assert.match(w.last(OWNER).text, /не вернул подтверждённых будущих отправлений/);
  assert.doesNotMatch(w.last(OWNER).text, /15:49/);
});

test('Туту MCP: при отсутствии обеих станций не обращаемся к провайдеру', async () => {
  const w = await createWorld();
  await w.say('Когда ближайшая электричка?');
  assert.equal(w.tutuCalls.length, 0);
  assert.match(w.last(OWNER).text, /уточни две станции/);
});

test('MCP недоступен: при настроенном фоне уходит в Actions, не придумывает ответ', async () => {
  const w = await createWorld({ cfg: { bgViaActions: true, tutuGuardMs: 100 }, exaKey: 'exa-test' });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  w.tutuReply = 'fail';
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  const dispatch = w.gh.dispatches.find((d) => d.workflow === 'bgjob.yml');
  assert.ok(dispatch);
  const job = dispatch.inputs.job;
  const req = JSON.parse((await w.app.bg.getRequest(job, 0)).text);
  assert.equal(req.transit.kind, 'search_etrain');
  assert.equal(req.transit.origin, 'Сочи');
  assert.equal(w.llmCalls.length, 0);
  const mockAnswer = 'Туту MCP: Сочи → Адлер, 2027-01-15\n1. 15:49 — Сочи → Адлер\nИсточник: https://mcp.tutu.ru/mcp';
  await w.app.bg.receivePart(job, 0, mockAnswer);
  await w.app.bg.finish({ job, n: 1, model: 'tutu-mcp', finish: 'stop', usage: null, error: null });
  assert.match(w.last(OWNER).text, /15:49/, 'ответ от структурированного провайдера не обрезан');
});

test('Нет маршрута и истёкшая история: короткое уточнение не приписывается старому поиску', () => {
  const prev = { origin: 'Сочи', destination: 'Адлер', kind: 'search_etrain', date: '2027-01-15', savedAt: 100 };
  assert.equal(parseTransitIntent('А следующая?', prev, 100 + 3601, 3), null);
  assert.equal(parseTransitIntent('А следующая?', prev, 120, 3)?.origin, 'Сочи');
  assert.equal(parseTransitIntent('Почему поезд шумит?', null, 100, 3), null);
});

test('В ответ не идут старые и непарсируемые предложения, нет ложного «рейсов нет»', () => {
  const plan = { origin: 'Сочи', destination: 'Адлер', date: '2027-01-15', kind: 'search_etrain', timezoneHours: 3 };
  const text = formatTransitResponse({ offers: [{ departure_at: 'несуществующая дата' }], meta: { complete: false } }, plan, 1800000000);
  assert.match(text, /Это не означает, что рейсов нет/);
});

test('Туту MCP: SSE-подобный ответ и URL ограничены фиксированным провайдером', async () => {
  const requests = [];
  const mockFetch = async (url, opts) => {
    requests.push(url);
    const msg = JSON.parse(opts.body);
    if (msg.method === 'initialize') return {
      ok: true, status: 200, headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
      text: async () => 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } }) + '\n\n',
    };
    if (msg.method === 'notifications/initialized') return { ok: true, status: 202 };
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ offers: [] }) }] } }) };
  };
  const data = await callTutuTool(mockFetch, 'search_etrain', { origin: 'Сочи', destination: 'Адлер', date: '2027-01-15' });
  assert.deepEqual(data.offers, []);
  assert.deepEqual(requests, [TUTU_MCP_URL, TUTU_MCP_URL, TUTU_MCP_URL]);
});
