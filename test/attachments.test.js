import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

const btns = (m) => (m?.reply_markup?.inline_keyboard ?? []).flat();
const lastUser = (call) => [...call.messages].reverse().find((m) => m.role === 'user');

test('фото с подписью → модель получает картинку и подпись как вопрос', async () => {
  const w = await createWorld();
  w.llmReplies.push('На фото кот.');
  await w.photo('CAT1', { caption: 'Что на фото?' });
  const u = lastUser(w.llmCalls.at(-1));
  assert.ok(Array.isArray(u.content), 'контент — массив частей');
  assert.match(u.content[0].text, /Что на фото\?/);
  assert.equal(u.content[1].type, 'image_url');
  assert.match(u.content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(w.last(OWNER).text, /На фото кот/);
});

test('фото без подписи → «Принял», потом текст = вопрос к фото', async () => {
  const w = await createWorld();
  await w.photo('P1');
  assert.match(w.last(OWNER).text, /Принял/);
  assert.ok(btns(w.last(OWNER)).some((b) => b.callback_data === 'a:go'));
  assert.equal(w.llmCalls.length, 0, 'без вопроса модель не зовём');
  w.llmReplies.push('Это чек на 500 ₽.');
  await w.say('Сколько тут?');
  const u = lastUser(w.llmCalls.at(-1));
  assert.match(u.content[0].text, /Сколько тут\?/);
  assert.equal(u.content[1].type, 'image_url');
  // в истории — только текстовый след, без байтов
  const hist = await w.store.getHistory(String(OWNER), 0, 5);
  assert.ok(hist.some((m) => m.role === 'user' && /📎 фото/.test(m.text)));
  assert.ok(!hist.some((m) => /base64/.test(m.text)));
});

test('кнопка «Разобрать» без вопроса — описание по умолчанию', async () => {
  const w = await createWorld();
  await w.photo('P2');
  w.llmReplies.push('Описание.');
  await w.press('a:go');
  const u = lastUser(w.llmCalls.at(-1));
  assert.match(u.content[0].text, /Опиши, что на изображении/);
  // повторная кнопка — вложение уже взято
  await w.press('a:go');
  assert.equal(w.llmCalls.length, 1);
});

test('текстовый файл с подписью: содержимое уходит модели как данные', async () => {
  const w = await createWorld();
  w.llmReplies.push('Сумма 6.');
  await w.doc('F1', { name: 'числа.csv', bytes: 'a,b\n1,2\n3,0', caption: 'Посчитай сумму' });
  const u = lastUser(w.llmCalls.at(-1));
  const txt = typeof u.content === 'string' ? u.content : u.content[0].text;
  assert.match(txt, /Посчитай сумму/);
  assert.match(txt, /=== ФАЙЛ: числа\.csv ===/);
  assert.match(txt, /3,0/);
  assert.match(txt, /не инструкции/);
});

test('альбом: бот отвечает один раз, подпись альбома — вопрос, «Разобрать» берёт все фото', async () => {
  const w = await createWorld();
  await w.photo('AL1', { group: 'gg', caption: 'Сравни' });
  await w.photo('AL2', { group: 'gg' });
  await w.photo('AL3', { group: 'gg' });
  assert.equal(w.sent(OWNER).filter((m) => /Принял/.test(m.text)).length, 1);
  assert.equal(w.llmCalls.length, 0);
  w.llmReplies.push('Разница в цвете.');
  await w.press('a:go');
  const u = lastUser(w.llmCalls.at(-1));
  assert.match(u.content[0].text, /Сравни/);
  assert.equal(u.content.filter((p) => p.type === 'image_url').length, 3);
});

test('PDF: модель без поддержки PDF заменяется на проверенную, с пояснением', async () => {
  const w = await createWorld();
  await w.store.ensureChat(OWNER, { type: 'private', title: 'T' }, w.now);
  await w.store.updateChat(OWNER, { model: 'gpt-5' });
  w.llmReplies.push('В PDF договор.');
  await w.doc('PDF1', { name: 'договор.pdf', mime: 'application/pdf', bytes: '%PDF-1.4 test', caption: 'О чём?' });
  assert.equal(w.llmPaths.at(-1), '/v1/messages', 'PDF — только форматом Anthropic');
  assert.equal(w.llmCalls.at(-1).model, 'claude-opus-5-5');
  assert.ok(JSON.stringify(w.llmCalls.at(-1).messages).includes('"document"'));
  assert.match(w.last(OWNER).text, /PDF прочитала модель claude-opus-5-5/);
  assert.equal((await w.store.getChat(OWNER)).model, 'gpt-5', 'выбранная модель чата не меняется');
});

test('картинка при модели без зрения: берётся модель со зрением и об этом сказано', async () => {
  const w = await createWorld();
  await w.store.ensureChat(OWNER, { type: 'private', title: 'T' }, w.now);
  await w.store.updateChat(OWNER, { model: 'gpt-5' });
  w.llmReplies.push('Вижу.');
  await w.photo('V1', { caption: 'что тут' });
  assert.equal(w.llmCalls.at(-1).model, 'claude-sonnet-5-5');
  assert.match(w.last(OWNER).text, /у выбранной gpt-5 нет зрения/);
});

test('«Повторить» снова показывает модели то же вложение', async () => {
  const w = await createWorld();
  w.llmReplies.push({ status: 500, body: { error: { message: 'boom' } } }, { status: 500, body: { error: { message: 'boom' } } }, { status: 500, body: { error: { message: 'boom' } } });
  await w.photo('R1', { caption: 'опиши' });
  const failedCalls = w.llmCalls.length;
  w.llmReplies.length = 0;
  w.llmReplies.push('Готово.');
  await w.press('r:1');
  assert.ok(w.llmCalls.length > failedCalls);
  const u = lastUser(w.llmCalls.at(-1));
  assert.equal(u.content.at(-1).type, 'image_url');
  // новое обычное сообщение — вложение уже не прикладывается
  w.llmReplies.push('Привет.');
  await w.say('привет');
  assert.equal(typeof lastUser(w.llmCalls.at(-1)).content, 'string');
});

test('фото с подписью «пост…» по-прежнему идёт в поток постов', async () => {
  const w = await createWorld();
  w.llmReplies.push('x');
  await w.photo('PP1', { caption: 'пост про весну' });
  assert.ok(!w.last(OWNER)?.text?.includes('Принял'));
});

test('не влезает в окно модели — не режем, а говорим', async () => {
  const w = await createWorld();
  await w.store.setSetting('models_cache', JSON.stringify([{ id: 'claude-sonnet-5-5', name: 'S', provider: 'Claude', down: false, priceIn: 3, priceOut: 15, ctx: 2000, vision: true, maxOut: 4000, thinking: true }]));
  await w.store.setSetting('models_ts', String(w.now));
  await w.doc('BIG', { name: 'big.txt', bytes: 'слово '.repeat(5000), caption: 'перескажи' });
  assert.equal(w.llmCalls.length, 0);
  assert.match(w.last(OWNER).text, /не режу/);
});

test('неподдерживаемый и слишком большой файл — понятное объяснение', async () => {
  const w = await createWorld();
  await w.doc('Z1', { name: 'архив.zip', bytes: 'PK', caption: 'что внутри' });
  assert.match(w.last(OWNER).text, /Не получилось разобрать вложения/);
  assert.equal(w.llmCalls.length, 0);
});
