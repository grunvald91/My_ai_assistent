import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

const buttons = (m) => (m.reply_markup?.inline_keyboard ?? []).flat();

test('вызов бота ограничен по времени: ответ, оборванный по сроку, не пропадает, есть «Продолжить», она дописывает', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 300 } });
  w.llmReplies.push({ stall: 'Начало длинного ответа, потом связь зависла' });
  await w.say('Напиши длинный текст');
  const m = w.last(OWNER);
  assert.match(m.text, /Начало длинного ответа/);
  assert.match(m.text, /Остановил на полуслове/);
  const cont = buttons(m).find((b) => b.callback_data === 'r:c');
  assert.ok(cont, 'кнопка «Продолжить»');

  w.clear();
  w.llmReplies.push(' …и вот продолжение.');
  await w.press('r:c');
  const sent = w.llmCalls[0].messages;
  assert.match(sent[sent.length - 2].content, /Начало длинного ответа/, 'модель видит уже написанное');
  assert.match(sent[sent.length - 1].content, /Продолжи/);
  assert.match(w.last(OWNER).text, /вот продолжение/);
});

test('модель молчит до срока: ошибка с понятным текстом и кнопками замены', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 300 } });
  w.llmReplies.push({ stall: '' });
  await w.say('Привет');
  const m = w.last(OWNER);
  assert.match(m.text, /не успела начать ответ/);
  assert.ok(buttons(m).some((b) => b.callback_data?.startsWith('r:m:')), 'есть модели-замены');
});

test('модель недоступна: кнопки с другими моделями, нажатие переключает модель и сразу отвечает на то же сообщение', async () => {
  const w = await createWorld();
  await w.say('/model claude-sonnet-5-5');
  w.clear();
  w.llmReplies.push({ status: 403, body: { error: { message: 'disabled' } } });
  await w.say('Мой важный вопрос про налоги');
  const m = w.last(OWNER);
  assert.match(m.text, /отключена/);
  const alts = buttons(m).filter((b) => b.callback_data?.startsWith('r:m:'));
  assert.ok(alts.length >= 1);
  assert.ok(!alts.some((b) => b.callback_data === 'r:m:claude-sonnet-5-5'), 'упавшую модель не предлагаем');
  assert.ok(!alts.some((b) => /image/.test(b.callback_data)), 'картиночные модели не предлагаем');
  const copy = buttons(m).find((b) => b.copy_text);
  assert.equal(copy?.copy_text.text, 'Мой важный вопрос про налоги');

  w.clear();
  w.llmReplies.push('Ответ другой моделью');
  await w.press(alts[0].callback_data);
  assert.equal(w.llmCalls[0].model, alts[0].callback_data.slice(4));
  assert.match(w.llmCalls[0].messages.at(-1).content, /Мой важный вопрос про налоги/);
  assert.match(w.last(OWNER).text, /Ответ другой моделью/);
});

test('flood control при стриминге не отключает черновики насовсем', async () => {
  const w = await createWorld();
  let n = 0;
  const orig = globalThis.__tg;
  globalThis.__tg = async (method, params) => {
    if (method === 'sendMessageDraft' && ++n === 2) throw Object.assign(new Error('flood'), { code: 429, parameters: { retry_after: 0 } });
    return orig(method, params);
  };
  w.llmReplies.push('Ответ после сбоя черновика');
  await w.say('Привет');
  assert.match(w.last(OWNER).text, /после сбоя черновика/);
});

test('черновик стрима уходит с разметкой HTML; если Telegram её не принял — дальше простым текстом', async () => {
  const w = await createWorld();
  w.llmReplies.push('**Жирный** заголовок и ещё немного текста');
  await w.say('Привет');
  const drafts = w.calls('sendMessageDraft').filter((d) => d.text);
  assert.ok(drafts.some((d) => d.parse_mode === 'HTML' && /<b>Жирный<\/b>/.test(d.text)));

  const w2 = await createWorld();
  const orig = globalThis.__tg;
  globalThis.__tg = async (method, params) => {
    if (method === 'sendMessageDraft' && params.parse_mode) throw Object.assign(new Error('bad'), { code: 400, description: "can't parse entities" });
    return orig(method, params);
  };
  w2.llmReplies.push('**Жирный** заголовок и ещё немного текста');
  await w2.say('Привет');
  assert.ok(w2.calls('sendMessageDraft').some((d) => !d.parse_mode && /Жирный/.test(d.text)), 'перешли на простой текст');
  assert.match(w2.last(OWNER).text, /Жирный/);
});

test('«Продолжить» убирает только свои кнопки, «Запомнить» остаётся', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 300 } });
  w.llmReplies.push({ stall: 'Часть ответа' });
  await w.say('Длинно');
  const m = w.last(OWNER);
  const markup = { inline_keyboard: [[{ text: '💾 Запомнить', callback_data: 'mem:y:1' }], [{ text: '▶️ Продолжить', callback_data: 'r:c' }]] };
  w.clear();
  w.llmReplies.push('дальше');
  await w.press('r:c', { messageId: m.message_id, markup });
  const edit = w.calls('editMessageReplyMarkup')[0];
  assert.deepEqual(edit.reply_markup.inline_keyboard, [[{ text: '💾 Запомнить', callback_data: 'mem:y:1' }]]);
});

test('упало «Продолжить» → кнопка другой модели продолжает ответ уже новой моделью', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 300 } });
  await w.say('/model claude-sonnet-5-5');
  w.llmReplies.push({ stall: 'Первая часть' });
  await w.say('Длинно');
  w.clear();
  w.llmReplies.push({ status: 403, body: { error: { message: 'disabled' } } });
  await w.press('r:c');
  const alt = w.last(OWNER).reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith('r:m:'));
  w.clear();
  w.llmReplies.push('вторая часть');
  await w.press(alt.callback_data);
  assert.match(w.llmCalls[0].messages.at(-1).content, /Продолжи/);
  assert.match(w.last(OWNER).text, /вторая часть/);
});
