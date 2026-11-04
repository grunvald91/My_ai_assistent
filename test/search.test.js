import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { parseDecision, sourcesNote, isLiveTransitQuestion, transitQuery, guardLiveTransitAnswer, guardSearchCapabilityAnswer, requiresFreshSearch } from '../tgcloud/lib/exa.js';

const YES = '{"search": true, "query": "курс доллара к рублю сегодня"}';
const NO = '{"search": false, "query": ""}';
const mk = (opts = {}) => createWorld({ exaKey: 'exa-test', ...opts, cfg: { fastModels: ['gpt-5'], ...(opts.cfg ?? {}) } }); // в тестовом каталоге быстрая модель — gpt-5

test('поиск: разбор решения модели', () => {
  assert.deepEqual(parseDecision('```json\n' + YES + '\n```'), { search: true, query: 'курс доллара к рублю сегодня' });
  assert.deepEqual(parseDecision(NO), { search: false, query: '' });
  assert.equal(parseDecision('не знаю'), null);
  assert.equal(parseDecision('{"search": true, "query": ""}').search, false, 'без запроса искать нечего');
  assert.match(sourcesNote('q', [{ title: 'А [1] (б)', url: 'https://x.y/z' }]), /\[А 1 б\]\(https:\/\/x\.y\/z\)/, 'скобки в названии не ломают ссылку');
});

test('поиск: нужен — ищем Exa по рекомендованному запросу, модель видит найденное, под ответом источники, в истории результатов нет', async () => {
  const w = await mk();
  w.llmReplies.push('Доллар стоит около 91 рубля [1].');
  await w.say('Какой сейчас курс доллара?');
  assert.equal(w.exaCalls.length, 1);
  assert.deepEqual(w.exaCalls[0].body, { query: 'Какой сейчас курс доллара? 2027-01-15', type: 'auto', contents: { highlights: true } }, 'прямой поиск с датой');
  assert.equal(w.exaCalls[0].headers['x-api-key'], 'exa-test');
  assert.equal(w.llmCalls.length, 1, 'для текущих данных решатель не вызываем');
  const final = JSON.stringify(w.llmCalls[0].messages);
  assert.match(final, /РЕЗУЛЬТАТЫ ВЕБ-ПОИСКА/);
  assert.match(final, /Доллар стоит 91 рубль/);
  const m = w.last(OWNER).text;
  assert.match(m, /Доллар стоит около 91 рубля/);
  assert.match(m, /🔎 Искал в интернете: «Какой сейчас курс доллара\? 2027-01-15»/);
  assert.match(m, /Курс рубля сегодня/);
  assert.match(m, /https:\/\/example\.com\/rub/, 'ссылка на источник');
  const hist = await w.store.getHistory(String(OWNER), 0, 5);
  assert.ok(!hist.some((h) => /РЕЗУЛЬТАТЫ ВЕБ-ПОИСКА/.test(h.text)), 'результаты поиска в историю не попали');
});

test('поиск: не нужен — Exa не вызывается', async () => {
  const w = await mk();
  w.llmReplies.push(NO, 'Привет!');
  await w.say('Привет, как дела? Расскажи что-нибудь');
  assert.equal(w.exaCalls.length, 0);
  assert.match(w.last(OWNER).text, /Привет!/);
  assert.ok(!/🔎/.test(w.last(OWNER).text));
});

test('поиск: Exa недоступен — отвечаем без него и честно говорим об этом', async () => {
  const w = await mk();
  w.exaReply = 'fail';
  w.llmReplies.push('Отвечаю по памяти.');
  await w.say('Какой сейчас курс доллара?');
  const m = w.last(OWNER).text;
  assert.match(m, /Отвечаю по памяти/);
  assert.match(m, /Поиск в интернете не получился/);
});

test('поиск: ничего не нашлось — говорим об этом', async () => {
  const w = await mk();
  w.exaReply = [];
  w.llmReplies.push('Не знаю.');
  await w.say('Какой сейчас курс доллара?');
  assert.match(w.last(OWNER).text, /ничего не нашлось/);
});

test('поиск: /search выкл — решающая модель и Exa не вызываются; без ключа — подсказка', async () => {
  let w = await mk();
  await w.say('/search выкл');
  assert.match(w.last(OWNER).text, /выключен/);
  w.llmReplies.push('Ответ без поиска.');
  await w.say('Какой сейчас курс доллара?');
  assert.equal(w.llmCalls.length, 1);
  assert.equal(w.exaCalls.length, 0);
  await w.say('/search вкл');
  assert.match(w.last(OWNER).text, /включён/);

  w = await createWorld(); // ключа нет
  await w.say('/search');
  assert.match(w.last(OWNER).text, /ключ Exa не задан/);
  w.llmReplies.push('Ответ.');
  await w.say('Какой сейчас курс доллара?');
  assert.equal(w.llmCalls.length, 1, 'без ключа лишних вызовов нет');
});

test('поиск: короткие реплики и вопросы с файлом идут без решения о поиске', async () => {
  const w = await mk();
  w.llmReplies.push('Ок.');
  await w.say('спасибо');
  assert.equal(w.llmCalls.length, 1);
  await w.doc('F1', { name: 'a.txt', bytes: 'текст файла', caption: 'Что в файле? Подробно расскажи' });
  w.llmReplies.push('В файле текст.');
  assert.equal(w.exaCalls.length, 0);
});

test('поиск: тяжёлая модель в фоне — решение и поиск делает задача Actions, подпись приходит с ответом', async () => {
  const w = await mk({ cfg: { bgViaActions: true } });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  await w.say('/start');
  await w.store.updateChat(OWNER, { model: 'claude-opus-5-5' });
  await w.say('Какой сейчас курс доллара?');
  assert.equal(w.llmCalls.length, 0, 'в боте модель не вызывалась вовсе — бот сразу ушёл в фон');
  assert.equal(w.exaCalls.length, 0);
  const job = w.gh.dispatches.at(-1).inputs.job;
  const req = JSON.parse((await w.app.bg.getRequest(job, 0)).text);
  assert.deepEqual(req.search, { asked: 'Какой сейчас курс доллара?', date: '2027-01-15' });
  await w.app.bg.receivePart(job, 0, 'Около 91 рубля.');
  await w.app.bg.finish({ job, n: 1, finish: 'stop', usage: null, model: 'claude-opus-5-5', error: null, snote: '🔎 Искал в интернете: «курс»\n1. [Источник](https://example.com/rub)' });
  const m = w.last(OWNER).text;
  assert.match(m, /Около 91 рубля/);
  assert.match(m, /🔎 Искал в интернете/);
});

test('поиск: Exa отвечает долго — вопрос уходит в фон (и с лёгкой моделью), поиск доделается там', async () => {
  const w = await mk({ cfg: { bgViaActions: true, searchGuardMs: 200 } });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  w.exaReply = 'stall';
  await w.say('Какой сейчас курс доллара?');
  assert.equal(w.llmCalls.length, 0, 'при обязательном поиске решатель не нужен');
  const d = w.gh.dispatches.find((x) => x.workflow === 'bgjob.yml');
  assert.ok(d, 'ушло в фон');
  const req = JSON.parse((await w.app.bg.getRequest(d.inputs.job, 0)).text);
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.deepEqual(req.search, { query: 'Какой сейчас курс доллара? 2027-01-15', date: '2027-01-15' }, 'решение уже принято — задача только ищет');
  assert.match(w.last(OWNER).text, /Поиск в интернете отвечает долго — ищу и отвечаю в фоне/);
});

test('поиск: Exa долго, а фон выключен — отвечаем в чате без поиска и честно пишем почему', async () => {
  const w = await mk({ cfg: { searchGuardMs: 200 } });
  w.exaReply = 'stall';
  w.llmReplies.push('Отвечаю без поиска.');
  await w.say('Какой сейчас курс доллара?');
  const m = w.last(OWNER).text;
  assert.match(m, /Отвечаю без поиска/);
  assert.match(m, /отвечал слишком долго/);
});

test('расписания: электричка идёт через структурированный Туту, а не архивный Exa', async () => {
  assert.equal(isLiveTransitQuestion('Когда ближайшая электричка из Сочи в Адлер?'), true);
  assert.equal(isLiveTransitQuestion('Покажи расписание автобусов на завтра'), true);
  assert.equal(isLiveTransitQuestion('Почему электрички бывают медленными?'), false);
  assert.match(transitQuery('Когда ближайшая электричка?', '2026-11-03'), /2026-11-03/);
  const w = await mk();
  w.exaReply = [{ title: 'Старое расписание', url: 'https://example.com/old', publishedDate: '2026-02-03', highlights: ['Поезд в 15:49'] }];
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  assert.equal(w.exaCalls.length, 0);
  assert.equal(w.tutuCalls.filter((c) => c.method === 'tools/call').length, 1);
  assert.equal(w.llmCalls.length, 1, 'ИИ понимает направление, а время отправления даёт только Туту');
  const answer = w.last(OWNER).text;
  assert.match(answer, /Туту MCP: Сочи → Адлер/);
  assert.doesNotMatch(answer, /example.com\/old|168 ₽/, 'старое расписание не использовано');
});

test('защита: не отрицаем настроенный Exa и не меняем обычные ответы', () => {
  assert.match(guardSearchCapabilityAnswer('В этой сессии у меня нет доступа к поиску.', true), /Exa подключён/);
  assert.equal(guardSearchCapabilityAnswer('В этой сессии у меня нет доступа к поиску.', false), 'В этой сессии у меня нет доступа к поиску.');
  assert.equal(guardLiveTransitAnswer('Поезд идёт около получаса.', 'Когда ближайшая электричка?'), 'Поезд идёт около получаса.');
  assert.equal(guardLiveTransitAnswer('Выезжаю в 15:49.', 'Почему электрички медленные?'), 'Выезжаю в 15:49.');
});

test('расписания: при сбое Туту используется фон, не генерация ИИ', async () => {
  const w = await mk({ cfg: { bgViaActions: true } });
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  w.tutuReply = 'fail';
  await w.say('/start');
  await w.store.updateChat(OWNER, { model: 'claude-opus-5-5' });
  await w.say('Когда ближайшая электричка из Сочи в Адлер?');
  const job = w.gh.dispatches.at(-1).inputs.job;
  const req = JSON.parse((await w.app.bg.getRequest(job, 0)).text);
  assert.equal(req.transit.origin, 'Сочи');
  assert.equal(req.transit.kind, 'search_etrain');
  assert.equal(w.llmCalls.length, 1, 'ИИ извлёк маршрут перед фоновым поиском Туту');
  await w.app.bg.receivePart(job, 0, 'Туту MCP не подтвердил отправление.');
  await w.app.bg.finish({ job, n: 1, finish: 'stop', usage: null, model: 'tutu-mcp', error: null });
  assert.match(w.last(OWNER).text, /Туту MCP не подтвердил/);
});

test('Exa: свежие цены/погода/новости идут на поиск без решателя', async () => {
  assert.equal(requiresFreshSearch('Какая погода в Сочи сегодня?'), true);
  assert.equal(requiresFreshSearch('Какой сейчас курс доллара?'), true);
  assert.equal(requiresFreshSearch('Найди актуальные вакансии'), true);
  assert.equal(requiresFreshSearch('Объясни, что такое диод'), false);
  const w = await mk();
  w.llmReplies.push('Согласно источникам, информация требует проверки.');
  await w.say('Какая погода в Сочи сегодня?');
  assert.equal(w.llmCalls.length, 1, 'решающая модель не нужна');
  assert.equal(w.exaCalls.length, 1, 'Exa вызывается');
  assert.match(w.exaCalls[0].body.query, /2027-01-15/);
  const p = JSON.stringify(w.llmCalls[0].messages);
  assert.match(p, /ИНСТРУМЕНТЫ: Exa настроен/);
  assert.match(p, /ИТОГ ВЕБ-ПОИСКА: Exa ответил/);
});
