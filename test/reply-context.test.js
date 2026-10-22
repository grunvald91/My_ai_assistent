import test from 'node:test';
import { createWorld, assert, OWNER, BOT_ID } from './helpers/world.js';

const lastUser = (call) => [...call.messages].reverse().find((m) => m.role === 'user');
const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content[0].text);

test('ответ на сообщение: бот получает его целиком, без обрезки', async () => {
  const w = await createWorld();
  const long = 'Длинная цитата. '.repeat(500);
  await w.say('Как думаешь?', { extra: { reply_to_message: { message_id: 5, text: long, from: { id: 777, first_name: 'Иван' } } } });
  const t = textOf(lastUser(w.llmCalls.at(-1)));
  assert.match(t, /в ответ на сообщение|отвечаю на сообщение \(Иван\)/);
  assert.ok(t.includes(long), 'текст не обрезан');
  assert.match(t, /Как думаешь\?$/);
});

test('ответ на сообщение бота и на своё прошлое — подписано, чьё это', async () => {
  const w = await createWorld();
  await w.say('а подробнее?', { extra: { reply_to_message: { message_id: 6, text: 'Вот краткий ответ', from: { id: BOT_ID, is_bot: true, first_name: 'Бот' } } } });
  assert.match(textOf(lastUser(w.llmCalls.at(-1))), /на твоё прошлое сообщение:\n«Вот краткий ответ»/);
  await w.say('уточню', { extra: { reply_to_message: { message_id: 7, text: 'моя мысль', from: { id: OWNER, first_name: 'А' } } } });
  assert.match(textOf(lastUser(w.llmCalls.at(-1))), /на моё прошлое сообщение:\n«моя мысль»/);
});

test('выделенный фрагмент (quote) важнее всего сообщения', async () => {
  const w = await createWorld();
  await w.say('что это значит?', { extra: { reply_to_message: { message_id: 8, text: 'Начало. Нужный кусок. Конец.', from: { id: 777, first_name: 'Иван' } }, quote: { text: 'Нужный кусок.', position: 8 } } });
  const t = textOf(lastUser(w.llmCalls.at(-1)));
  assert.match(t, /выделенный фрагмент/);
  assert.match(t, /«Нужный кусок\.»/);
  assert.ok(!t.includes('Начало.'));
});

test('ответ на сообщение с фото: картинка уходит модели вместе с вопросом', async () => {
  const w = await createWorld();
  w.llmReplies.push('Это чек.');
  await w.say('что на фото?', { extra: { reply_to_message: { message_id: 9, caption: 'вот', photo: [{ file_id: 'RP_s' }, { file_id: 'RP' }], from: { id: 777, first_name: 'Иван' } } } });
  const u = lastUser(w.llmCalls.at(-1));
  assert.ok(Array.isArray(u.content));
  assert.match(u.content[0].text, /что на фото\?/);
  assert.match(u.content[0].text, /к нему приложено: фото/);
  assert.equal(u.content.at(-1).type, 'image_url');
});

test('без ответа на сообщение — всё как раньше', async () => {
  const w = await createWorld();
  await w.say('привет');
  assert.equal(textOf(lastUser(w.llmCalls.at(-1))), 'привет');
});

test('в группе цитата сообщения, на которое ответили, не обрезается', async () => {
  const w = await createWorld();
  await w.setGroupMode(-5001, 'all');
  const long = 'Цитата из группы. '.repeat(300);
  await w.group('что скажешь?', { replyTo: { message_id: 3, text: long, from: { id: 2002, first_name: 'Гость' } } });
  const t = textOf(lastUser(w.llmCalls.at(-1)));
  assert.ok(t.includes(long));
});

test('/draft: сообщение, на которое отвечают, уходит модели целиком', async () => {
  const w = await createWorld();
  await w.setGroupMode(-5001, 'off');
  const long = 'Вопрос участника. '.repeat(200);
  w.llmReplies.push('Черновик ответа');
  await w.group('/draft', { from: OWNER, replyTo: { message_id: 4, text: long, from: { id: 2002, first_name: 'Гость' } } });
  const prompt = JSON.stringify(w.llmCalls.at(-1).messages);
  assert.ok(prompt.includes(long.slice(0, 3000)) && prompt.includes(long.slice(-200)), 'модель видит всё сообщение');
});
