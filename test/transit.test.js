import test from 'node:test';
import { createWorld, OWNER, assert } from './helpers/world.js';
import {
  isTransitCandidate, normalizeDepartures, formatTransitResponse, callTutuTool, TUTU_MCP_URL,
} from '../tgcloud/lib/transit.js';

test('Туту MCP: ИИ понимает запрос, а отправления берём только из структурированного ответа', async () => {
  const w = await createWorld({ exaKey: 'exa-test' });
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  const calls = w.tutuCalls;
  assert.deepEqual(calls.map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(calls[2].params.name, 'search_etrain');
  assert.equal(calls[2].params.arguments.origin, 'Сочи');
  assert.equal(calls[2].params.arguments.destination, 'Адлер');
  assert.equal(calls[2].params.arguments.departure_date, '2027-01-15');
  assert.equal(w.llmCalls.length, 1, 'маршрут разбирает ИИ, расписание — только Туту');
  assert.match(JSON.stringify(w.llmCalls[0].messages), /TRANSIT_INTENT_JSON/);
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
  assert.equal(w.llmCalls.length, 2, 'ИИ понимает и уточняющий вопрос');
  assert.notEqual(first, w.last(OWNER).text);
  assert.match(w.last(OWNER).text, /Туту MCP/);
});

test('Некорректная выдача Туту не превращается в выдуманные минуты', async () => {
  const w = await createWorld();
  w.tutuReply = { offers: [{ price: 199, name: 'недостаточно полей' }], meta: { complete: false } };
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  assert.match(w.last(OWNER).text, /не удалось подтвердить автоматически/);
  assert.match(w.last(OWNER).text, /rasp\.yandex\.ru/);
  assert.doesNotMatch(w.last(OWNER).text, /15:49/);
});

test('Туту MCP: при отсутствии обеих станций не обращаемся к провайдеру', async () => {
  const w = await createWorld();
  await w.say('Когда ближайшая электричка?');
  assert.equal(w.tutuCalls.length, 0);
  assert.match(w.last(OWNER).text, /Уточни, пожалуйста, откуда и куда/);
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
  assert.equal(w.llmCalls.length, 1, 'ИИ извлёк маршрут до фонового поиска');
  const mockAnswer = 'Туту MCP: Сочи → Адлер, 2027-01-15\n1. 15:49 — Сочи → Адлер\nИсточник: https://mcp.tutu.ru/mcp';
  await w.app.bg.receivePart(job, 0, mockAnswer);
  await w.app.bg.finish({ job, n: 1, model: 'tutu-mcp', finish: 'stop', usage: null, error: null });
  assert.match(w.last(OWNER).text, /15:49/, 'ответ от структурированного провайдера не обрезан');
});

test('Свежий контекст позволяет ИИ понять короткое уточнение, устаревший игнорируется', () => {
  const prev = { origin: 'Сочи', destination: 'Адлер', kind: 'search_etrain', date: '2027-01-15', savedAt: 100 };
  assert.equal(isTransitCandidate('А следующая?', prev, 100 + 3601), false);
  assert.equal(isTransitCandidate('А следующая?', prev, 120), true);
  assert.equal(isTransitCandidate('А завтра?', prev, 120), true);
  assert.equal(isTransitCandidate('Почему поезд шумит?', null, 100), false);
});

test('ИИ переносит прежний маршрут на завтра без повторных вопросов', async () => {
  const w = await createWorld();
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  await w.say('А завтра?');
  assert.equal(w.llmCalls.length, 2);
  const tool = w.tutuCalls.filter((x) => x.method === 'tools/call').at(-1);
  assert.equal(tool.params.arguments.origin, 'Сочи');
  assert.equal(tool.params.arguments.destination, 'Адлер');
  assert.equal(tool.params.arguments.departure_date, '2027-01-16');
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

test('Туту: ближайший поезд может оказаться на второй странице выдачи, отсортированной по цене', async () => {
  const calls = [];
  const mockFetch = async (_url, opts) => {
    const msg = JSON.parse(opts.body);
    calls.push(msg);
    if (msg.method === 'initialize') return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } }),
    };
    if (msg.method === 'notifications/initialized') return { ok: true, status: 202 };
    const page = msg.params.arguments.page;
    const offers = page === 1
      ? Array.from({ length: 30 }, (_, i) => ({ offer_id: 'cheap-' + i, departure_at: '2027-01-15T20:00:00+03:00' }))
      : [{ offer_id: 'fast', departure_at: '2027-01-15T10:00:00+03:00' }];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({
        offers, meta: { has_more: page === 1, total_matched_exact: true },
      }) }] },
    }) };
  };
  const plan = { origin: 'Сочи', destination: 'Адлер', date: '2027-01-15', timezoneHours: 3, kind: 'search_etrain' };
  const data = await callTutuTool(mockFetch, plan.kind, plan);
  assert.equal(data.offers.length, 31);
  assert.equal(data.meta.complete, true);
  assert.deepEqual(calls.filter((x) => x.method === 'tools/call').map((x) => x.params.arguments.page), [1, 2]);
  const results = normalizeDepartures(data, plan, Date.parse('2027-01-15T09:00:00+03:00') / 1000);
  assert.equal(results[0].time, '10:00', 'самый ранний рейс не обязан быть самым дешёвым');
});


test('ИИ понимает разговорное «из Адлера на красную поляну», не спрашивая станции повторно', async () => {
  const w = await createWorld();
  w.tutuReply = { offers: [{
    departure_at: new Date((w.now + 2100) * 1000).toISOString(),
    from: { name: 'Адлер' }, to: { name: 'Красная Поляна' },
  }], meta: { complete: true } };
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  assert.equal(w.llmCalls.length, 1, 'семантический маршрут получен от модели');
  const call = w.tutuCalls.find((m) => m.method === 'tools/call');
  assert.ok(call, 'помощник обратился к Туту');
  assert.equal(call.params.arguments.origin, 'Адлер');
  assert.equal(call.params.arguments.destination, 'Красная Поляна');
  assert.equal(call.params.arguments.departure_date, '2027-01-15');
  assert.match(w.last(OWNER).text, /Туту MCP: Адлер → Красная Поляна/);
  assert.doesNotMatch(w.last(OWNER).text, /[Уу]точни/);
});

test('Если ИИ не вернул JSON, бот не просит станции повторно и не выдаёт вымышленное расписание', async () => {
  const w = await createWorld();
  w.llmReplies.push('Не могу преобразовать сообщение в JSON');
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  assert.equal(w.tutuCalls.length, 0);
  assert.match(w.last(OWNER).text, /Поиск расписания не завершился/);
  assert.doesNotMatch(w.last(OWNER).text, /откуда и куда/);
});


test('Регрессия: сбой ИИ не обрывает запрос, а передаёт семантический поиск в Actions', async () => {
  const w = await createWorld({ cfg: { bgViaActions: true } });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  w.llmReplies.push({ status: 503, body: { error: { message: 'model unavailable' } } });
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  assert.equal(w.llmCalls.length, 1, 'сначала модель выбранного чата');
  assert.equal(w.llmCalls[0].model, 'claude-sonnet-5-5', 'не подменять выбранную модель на haiku-5-5');
  const dispatch = w.gh.dispatches.find((d) => d.workflow === 'bgjob.yml');
  assert.ok(dispatch, 'проверенная запасная цепочка запускает фоновый поиск');
  assert.deepEqual(Object.keys(dispatch.inputs), ['job'], 'в параметрах публичного Actions нет текста запроса');
  const req = JSON.parse((await w.app.bg.getRequest(dispatch.inputs.job, 0)).text);
  assert.equal(req.transitIntent.question, 'Посмотри электрички на сегодня из Адлера на красную поляну');
  assert.equal(req.transitIntent.previous, null);
  assert.ok(!req.transit, 'маршрут ещё не выдуман и будет разобран ИИ внутри Actions');
  assert.doesNotMatch(w.last(OWNER).text, /Не получилось обработать маршрут через ИИ/);
  assert.match(w.last(OWNER).text, /в фоне/);
});

test('Фоновый ИИ-разбор оплачивается как вызов модели, а выдача остаётся доверенной Туту', async () => {
  const w = await createWorld({ cfg: { bgViaActions: true } });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  w.llmReplies.push({ status: 503, body: { error: { message: 'model unavailable' } } });
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  const id = w.gh.dispatches.at(-1).inputs.job;
  const before = await w.app.core.todayUsage();
  await w.app.bg.receivePart(id, 0, 'Туту MCP: Адлер → Красная Поляна, 2027-01-15\n1. 15:49 — Адлер → Красная Поляна\nИсточник: https://mcp.tutu.ru/mcp');
  await w.app.bg.finish({ job: id, n: 1, finish: 'stop', usage: { in: 100, out: 70 }, model: 'claude-sonnet-5-5', error: null });
  const after = await w.app.core.todayUsage();
  assert.equal(after.tokensIn - before.tokensIn, 100);
  assert.equal(after.tokensOut - before.tokensOut, 70);
  assert.match(w.last(OWNER).text, /15:49/);
});


test('Расписание через неделю не отбрасывается ограничением в 72 часа', () => {
  const plan = { origin: 'Адлер', destination: 'Красная Поляна', kind: 'search_etrain',
    date: '2027-01-22', timezoneHours: 3 };
  const now = Date.parse('2027-01-15T09:00:00+03:00') / 1000;
  const results = normalizeDepartures({ offers: [
    { departure_at: '2027-01-22T14:25:00+03:00', from: { name: 'Адлер' }, to: { name: 'Красная Поляна' } },
    { departure_at: '2027-01-23T14:25:00+03:00', from: { name: 'Адлер' }, to: { name: 'Красная Поляна' } },
  ] }, plan, now);
  assert.deepEqual(results.map(x => [x.day, x.time]), [['2027-01-22', '14:25']]);
});


test('Пустая выдача Туту не считается отсутствием электричек: даём официальный Яндекс',async()=>{
  const w=await createWorld();
  w.tutuReply={offers:[],meta:{complete:true}};
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  assert.equal(w.tutuCalls.filter(x=>x.method==='tools/call').length,1);
  assert.match(w.last(OWNER).text,/rasp\.yandex\.ru\/suburban\/adler-station--rosa-khutor/);
  assert.doesNotMatch(w.last(OWNER).text,/нет электричек|нет рейсов/i);
});

test('При настроенном разрешённом API Яндекс пустая выдача Туту отправляется в фон, не останавливает поиск',async()=>{
  const w=await createWorld({cfg:{bgViaActions:true},yandexRaspKey:'test-yandex-key'});
  w.gh.repos['grunvald91/my_ai_assistent']={default_branch:'main',files:{'README.md':'bot'}};
  w.tutuReply={offers:[],meta:{complete:true}};
  await w.say('Посмотри электрички на сегодня из Адлера на красную поляну');
  const dispatch=w.gh.dispatches.find(x=>x.workflow==='bgjob.yml');
  assert.ok(dispatch);
  const req=JSON.parse((await w.app.bg.getRequest(dispatch.inputs.job,0)).text);
  assert.equal(req.transit.origin,'Адлер');
  assert.equal(req.transit.destination,'Красная Поляна');
  assert.equal(req.transit.skipTutu,true);
  assert.match(w.last(OWNER).text,/Яндекс Расписания/);
});


test('При явном запросе остановок и доступном разрешённом Яндекс API помощник запрашивает детали в фоне',async()=>{
  const w=await createWorld({cfg:{bgViaActions:true},yandexRaspKey:'authorized-yandex-key'});
  w.gh.repos['grunvald91/my_ai_assistent']={default_branch:'main',files:{'README.md':'bot'}};
  w.tutuReply={offers:[],meta:{complete:true}};
  await w.say('Покажи подробно остановки электрички сегодня из Адлера на красную поляну');
  assert.equal(w.tutuCalls.filter(c=>c.method==='tools/call').length,0,'не тратим время Telegram Serverless на компактный Tutu');
  const dispatch=w.gh.dispatches.find(c=>c.workflow==='bgjob.yml');
  assert.ok(dispatch);
  const body=JSON.parse((await w.app.bg.getRequest(dispatch.inputs.job,0)).text);
  assert.equal(body.transit.details,true);
  assert.equal(body.transit.kind,'search_etrain');
  assert.match(w.last(OWNER).text,/остановки и детали/);
});
