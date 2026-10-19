import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, createWorld } from './helpers/world.js';
import * as store from '../tgcloud/lib/store.js';
import { createLlm, LlmError } from '../tgcloud/lib/llm.js';

test('store: настройки, upsert и удаление значения', async () => {
  await resetDb();
  assert.equal(await store.getSetting('x'), null);
  await store.setSetting('x', 5);
  await store.setSetting('x', 'six');
  assert.equal(await store.getSetting('x'), 'six');
  assert.deepEqual(await store.getSettings(['x', 'y']), { x: 'six' });
  await store.setSetting('x', null);
  assert.equal(await store.getSetting('x'), null);
});

test('store: история, подсчёт, обрезка и удаление до id', async () => {
  await resetDb();
  for (let i = 1; i <= 10; i++) await store.addMessage({ chatKey: 'c', role: i % 2 ? 'user' : 'assistant', text: 'm' + i, ts: i });
  await store.addMessage({ chatKey: 'other', role: 'user', text: 'чужое', ts: 1 });
  const h = await store.getHistory('c', 0, 4);
  assert.deepEqual(h.map((m) => m.text), ['m7', 'm8', 'm9', 'm10']);
  assert.equal(await store.countAfter('c', 0), 10);
  const old = await store.oldestAfter('c', 0, 3);
  assert.deepEqual(old.map((m) => m.text), ['m1', 'm2', 'm3']);
  await store.deleteUpTo('c', old[2].id);
  assert.equal(await store.countAfter('c', 0), 7);
  await store.trimMessages('c', 3);
  assert.deepEqual((await store.getHistory('c', 0, 10)).map((m) => m.text), ['m8', 'm9', 'm10']);
  assert.equal((await store.getHistory('other', 0, 10)).length, 1);
});

test('store: hit() — лимит в окне, новое окно сбрасывает', async () => {
  await resetDb();
  assert.equal((await store.hit('k', 1, 2)).allowed, true);
  assert.equal((await store.hit('k', 1, 2)).allowed, true);
  assert.equal((await store.hit('k', 1, 2)).allowed, false);
  assert.equal((await store.hit('k', 2, 2)).allowed, true);
  assert.equal((await store.hit('z', 1, 0)).allowed, false);
});

test('store: beginUpdate — дубль, блокировка и истечение блокировки', async () => {
  await resetDb();
  assert.equal(await store.beginUpdate(1, 1000, 120), true);
  assert.equal(await store.beginUpdate(1, 1010, 120), false, 'в работе');
  assert.equal(await store.beginUpdate(1, 1200, 120), true, 'блокировка истекла — можно повторить');
  await store.finishUpdate(1);
  assert.equal(await store.beginUpdate(1, 9999, 120), false, 'обработан');
});

test('store: claimDraft атомарен, usage суммируется, память по scope', async () => {
  await resetDb();
  await store.createDraft({ id: 'd1', kind: 'post', status: 'ready', createdAt: 1 });
  assert.equal(await store.claimDraft('d1', 'ready', 'publishing'), true);
  assert.equal(await store.claimDraft('d1', 'ready', 'publishing'), false);

  await store.addUsage('2027-01-15', 100, 50, 0.01);
  await store.addUsage('2027-01-15', 10, 5, 0.002);
  const u = await store.getUsage('2027-01-15');
  assert.deepEqual([u.tokensIn, u.tokensOut, u.requests], [110, 55, 2]);
  assert.ok(Math.abs(u.costUsd - 0.012) < 1e-9);
  assert.equal((await store.sumUsage('2027-01')).requests, 2);

  await store.addMemory('owner', 'a', 'explicit', 1);
  await store.addMemory('group:1', 'b', 'explicit', 1);
  assert.equal((await store.listMemories(['owner'])).length, 1);
  assert.equal(await store.countMemories('group:1'), 1);
  await store.wipeMemory();
  assert.equal((await store.listMemories(['owner', 'group:1'])).length, 0);
});

test('store: каналы — upsert, деактивация, повторное подключение', async () => {
  await resetDb();
  const c = await store.upsertChannel({ chatId: -100, title: 'A', username: 'a' }, 1);
  await store.updateChannel(c.id, { style: 'строго' });
  await store.deactivateChannelByChat(-100);
  assert.equal((await store.listChannels()).length, 0);
  const again = await store.upsertChannel({ chatId: -100, title: 'A2', username: 'a' }, 2);
  assert.equal(again.id, c.id);
  assert.equal(again.style, 'строго', 'стиль сохраняется');
  assert.equal((await store.listChannels()).length, 1);
});

test('store: журнал и экспорт не падают, models_cache в экспорт не попадает', async () => {
  await resetDb();
  await store.log('x', 1, { a: 1 }, 5);
  await store.setSetting('models_cache', '[]');
  const ex = await store.exportAll();
  assert.equal(ex.journal.length, 1);
  assert.ok(!ex.settings.some((s) => s.key === 'models_cache'));
  assert.equal((await store.recentJournal(5)).length, 1);
});

// ───────── llm ─────────

const resp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

test('llm: 400 про stream_options/max_tokens — параметры снимаются и запрос повторяется', async () => {
  const bodies = [];
  const fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    bodies.push(b);
    if (b.max_tokens) return resp(400, { error: { message: 'Unsupported parameter: max_tokens' } });
    return resp(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  };
  const llm = createLlm({ fetch, apiKey: 'k', sleep: async () => {} });
  const r = await llm.chat({ model: 'claude-sonnet-5-5', messages: [], maxTokens: 100 });
  assert.equal(r.text, 'ok');
  assert.equal(bodies.length, 2);
  assert.equal('max_tokens' in bodies[1], false);
});

test('llm: коды ошибок → виды ошибок и человеческие тексты', async () => {
  for (const [status, kind] of [[401, 'auth'], [402, 'balance'], [403, 'forbidden'], [404, 'notfound'], [413, 'too_large'], [429, 'rate'], [500, 'upstream']]) {
    const llm = createLlm({ fetch: async () => resp(status, { error: { message: 'x' } }), apiKey: 'k', sleep: async () => {}, retries: 0 });
    await assert.rejects(llm.chat({ model: 'm', messages: [] }), (e) => e instanceof LlmError && e.kind === kind && e.userMessage.length > 10);
  }
});

test('llm: обрыв потока после начала текста возвращает частичный ответ с пометкой, без повтора', async () => {
  let calls = 0;
  const enc = new TextEncoder();
  const fetch = async () => {
    calls++;
    return {
      ok: true, status: 200, headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          yield enc.encode('data: {"choices":[{"delta":{"content":"Начало "}}]}\n\n');
          throw new Error('соединение сброшено');
        },
      },
    };
  };
  const llm = createLlm({ fetch, apiKey: 'k', sleep: async () => {} });
  const r = await llm.chat({ model: 'm', messages: [], stream: true });
  assert.equal(r.text, 'Начало ');
  assert.ok(r.error);
  assert.equal(calls, 1);
});

test('llm: SSE с разрезанным посреди символа UTF-8 собирается правильно', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Привет, мир"}}]}\n\ndata: [DONE]\n\n');
  const fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7); } },
  });
  const llm = createLlm({ fetch, apiKey: 'k', sleep: async () => {} });
  const r = await llm.chat({ model: 'm', messages: [], stream: true });
  assert.equal(r.text, 'Привет, мир');
});

test('приложение: сбой внутри обработчика не роняет апдейт; владелец получает сообщение, ошибка в журнале', async () => {
  const w = await createWorld();
  // сбой не-LLM природы: БД «отвалилась» при записи сообщения ассистента
  const orig = w.store.addMessage;
  w.llmReplies.push('Ответ');
  const realTg = globalThis.__tg;
  globalThis.__tg = async (m, p) => {
    if (m === 'sendMessage' && p.chat_id === 1001 && /Ответ/.test(p.text ?? '')) throw new Error('сеть упала');
    return realTg(m, p);
  };
  await assert.doesNotReject(w.say('Привет'));
  globalThis.__tg = realTg;
  const j = await w.store.recentJournal(5);
  assert.ok(j.some((r) => r.type === 'error'));
  assert.match(w.last(1001).text, /Что-то пошло не так/);
  assert.equal(typeof orig, 'function');
});
