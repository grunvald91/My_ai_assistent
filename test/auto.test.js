import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { isSimple } from '../tgcloud/lib/auto.js';

const btns = (m) => (m?.reply_markup?.inline_keyboard ?? []).flat();
const cfg = { fastModels: ['gpt-5'] }; // в тестовом каталоге gpt-5 дешевле sonnet

test('isSimple: короткие вопросы — да, код/анализ/длинное — нет', () => {
  assert.equal(isSimple('какая столица Франции?'), true);
  assert.equal(isSimple('привет'), true);
  assert.equal(isSimple('напиши функцию сортировки'), false);
  assert.equal(isSimple('проанализируй мои продажи'), false);
  assert.equal(isSimple('что тут не так?\nстрока 2'), false);
  assert.equal(isSimple('посмотри https://example.com'), false);
  assert.equal(isSimple('а'.repeat(200)), false);
});

test('/auto выключен по умолчанию: отвечает выбранная модель', async () => {
  const w = await createWorld({ cfg });
  await w.say('привет');
  assert.equal(w.llmCalls.at(-1).model, 'claude-sonnet-5-5');
});

test('/auto вкл: простой вопрос — быстрая модель с пометкой и кнопкой «Ответить сильной»', async () => {
  const w = await createWorld({ cfg });
  await w.say('/auto вкл');
  assert.match(w.last(OWNER).text, /включён/);
  w.llmReplies.push('Париж.');
  await w.say('какая столица Франции?');
  assert.equal(w.llmCalls.at(-1).model, 'gpt-5');
  const m = w.last(OWNER);
  assert.match(m.text, /ответила быстрая модель gpt-5/);
  const strong = btns(m).find((b) => b.callback_data === 'r:s');
  assert.ok(strong);

  w.llmReplies.push('Париж, подробнее…');
  await w.press('r:s');
  assert.equal(w.llmCalls.at(-1).model, 'claude-sonnet-5-5', 'кнопка спрашивает выбранную модель');
  assert.ok(!/быстрая модель/.test(w.last(OWNER).text));
});

test('/auto вкл: сложное, размышления и вложения — всегда выбранная модель', async () => {
  const w = await createWorld({ cfg });
  await w.say('/auto вкл');
  await w.say('напиши функцию сортировки');
  assert.equal(w.llmCalls.at(-1).model, 'claude-sonnet-5-5');
  await w.say('/think low');
  await w.say('привет');
  assert.equal(w.llmCalls.at(-1).model, 'claude-sonnet-5-5', 'с размышлениями быстрой не подменяем');
  await w.say('/think off');
  w.llmReplies.push('ok');
  await w.photo('X1', { caption: 'что тут?' });
  assert.notEqual(w.llmCalls.at(-1).model, 'gpt-5', 'с картинкой — не быстрая');
});

test('/auto: если выбрана модель сама дешёвая или смена руками — не подменяется', async () => {
  const w = await createWorld({ cfg });
  await w.say('/auto вкл');
  await w.store.updateChat(OWNER, { model: 'gpt-5' });
  await w.say('привет');
  assert.equal(w.llmCalls.at(-1).model, 'gpt-5');
  assert.ok(!/быстрая модель/.test(w.last(OWNER).text));
});

test('/auto выкл кнопкой', async () => {
  const w = await createWorld({ cfg });
  await w.say('/auto');
  await w.press('au:on');
  assert.equal(await w.store.getSetting('auto'), '1');
  await w.press('au:off');
  assert.equal(await w.store.getSetting('auto'), null);
});
