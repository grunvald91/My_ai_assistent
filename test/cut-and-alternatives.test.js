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

test('Rich-сообщения: ответ уходит Markdown-ом в sendRichMessage, «$» экранируется, код не трогаем', async () => {
  const w = await createWorld({ cfg: { richMessages: true } });
  w.llmReplies.push('| a | b |\n|---|---|\n| 1 | 2 |\n\nЦена $3 и $15, в коде `$x` остаётся.');
  await w.say('Таблицу');
  const rich = w.calls('sendRichMessage');
  assert.equal(rich.length, 1);
  assert.match(rich[0].rich_message.markdown, /\| a \| b \|/);
  assert.match(rich[0].rich_message.markdown, /Цена \\\$3 и \\\$15/);
  assert.match(rich[0].rich_message.markdown, /`\$x`/);
  assert.equal(w.sent(OWNER).length, 0, 'обычное сообщение не дублируется');
  assert.ok(w.calls('sendRichMessageDraft').length >= 1, 'стрим идёт Rich-черновиком');
});

test('Rich-сообщения: если Telegram отказал — тот же ответ уходит обычным HTML, ничего не теряется', async () => {
  const w = await createWorld({ cfg: { richMessages: true } });
  w.fail('sendRichMessage', 400, 'Bad Request: can\'t parse rich message');
  w.fail('sendRichMessageDraft', 400, 'Bad Request');
  w.llmReplies.push('**Привет**, мир');
  await w.say('Привет');
  assert.match(w.last(OWNER).text, /<b>Привет<\/b>/);
});

test('Rich-сообщения: кнопки (Запомнить, Продолжить) едут в reply_markup rich-сообщения', async () => {
  const w = await createWorld({ cfg: { richMessages: true, cutAfterMs: 300 } });
  w.llmReplies.push({ stall: 'Начало' });
  await w.say('Длинно');
  const r = w.calls('sendRichMessage').at(-1);
  assert.ok(r.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'r:c'));
});

test('force_reply: вопрос «опиши задачу» открывает ответ сразу, «Отмена» сбрасывает ожидание', async () => {
  const w = await createWorld();
  w.gh.repos['me/sushef'] = { default_branch: 'main', files: { 'README.md': '# x' } };
  await w.say('/repo me/sushef');
  w.clear();
  await w.say('/code');
  const q = w.last(OWNER);
  assert.equal(q.reply_markup.force_reply, true);
  const cancel = q.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'r:x');
  assert.equal(cancel.style, 'danger');
  await w.press('r:x');
  w.clear();
  w.llmReplies.push('Обычный ответ');
  await w.say('Привет');
  assert.equal(w.llmCalls.length, 1, 'после отмены сообщение идёт в обычный чат, а не в задачу для кода');
});

test('цвета кнопок: подтверждение памяти — зелёная', async () => {
  const w = await createWorld();
  w.llmReplies.push('Ок.\n\n[[запомнить: Любит чай]]');
  await w.say('Я люблю чай');
  const btn = w.last(OWNER).reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith('mem:y:'));
  assert.equal(btn.style, 'success');
});

test('/code идёт шагами: кусок кода оборвали по сроку → «Дописать» → продолжение → предпросмотр с кнопками', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 400 } });
  w.gh.repos['me/site'] = { default_branch: 'main', private: true, files: { 'a.js': 'x' } };
  await w.say('/repo me/site');
  w.clear();
  w.llmReplies.push('NONE', { stall: '@@@ COMMIT: add b\n@@@ SUMMARY: делаю\n@@@ FILE create b.js\nconsole.log(1)\n' });
  await w.say('/code добавь b.js');
  const m = w.last(OWNER);
  assert.match(m.text, /Шаг 1/);
  const cont = m.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'x:cj');
  assert.ok(cont, 'кнопка «Дописать»');

  w.clear();
  w.llmReplies.push('console.log(2)\n@@@ END');
  await w.press('x:cj');
  const sent = w.llmCalls[0].messages;
  assert.match(sent.at(-2).content, /FILE create b\.js/, 'модель видит уже написанное');
  const preview = w.last(OWNER);
  assert.match(preview.text, /b\.js/);
  assert.ok(preview.reply_markup.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('x:pr:')));

  // задача закрыта: повторное нажатие не воскрешает её
  w.clear();
  await w.press('x:cj');
  assert.match(w.last(OWNER).text, /Нет начатой задачи/);
});

test('/code: ошибка модели на втором шаге не теряет написанное — кнопка повторить шаг', async () => {
  const w = await createWorld({ cfg: { cutAfterMs: 400 } });
  w.gh.repos['me/site'] = { default_branch: 'main', files: { 'a.js': 'x' } };
  await w.say('/repo me/site');
  w.llmReplies.push('NONE', { stall: '@@@ FILE create b.js\nчасть' });
  await w.say('/code добавь b.js');
  w.clear();
  w.llmReplies.push({ status: 400, body: { error: { message: 'bad' } } });
  await w.press('x:cj');
  const m = w.last(OWNER);
  assert.match(m.text, /сохранено/);
  assert.ok(m.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'x:cj'));
});

test('/code через GitHub Actions: бот запускает codejob.yml, результат приходит эндпоинтами и превращается в предпросмотр', async () => {
  const w = await createWorld({ cfg: { codeViaActions: true } });
  w.gh.repos['me/site'] = { default_branch: 'main', private: true, files: { 'a.js': 'x' } };
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  await w.say('/repo me/site');
  w.clear();
  await w.say('/code добавь b.js');
  assert.equal(w.llmCalls.length, 0, 'модель в боте не вызывалась: всё делает Actions');
  const d = w.gh.dispatches.find((x) => x.workflow === 'codejob.yml');
  assert.ok(d, 'workflow codejob.yml запущен');
  assert.equal(d.repo, 'grunvald91/my_ai_assistent');
  assert.equal(d.inputs.repo, 'me/site');
  assert.equal(d.inputs.task, 'добавь b.js');
  assert.match(w.last(OWNER).text, /ушла в GitHub Actions/);

  // Actions присылает ответ модели двумя частями и итог
  const job = d.inputs.job;
  const raw = '@@@ COMMIT: add b\n@@@ SUMMARY: готово\n@@@ FILE create b.js\nconsole.log(1)\n@@@ END';
  assert.equal(await w.app.code.receiveJobPart(job, 0, raw.slice(0, 40)), true);
  assert.equal(await w.app.code.receiveJobPart(job, 1, raw.slice(40)), true);
  assert.equal(await w.app.code.finishJob({ job, n: 2, finish: 'stop', usage: { in: 1000, out: 500 }, model: 'claude-sonnet-5-5', error: null }), true);
  const preview = w.last(OWNER);
  assert.match(preview.text, /b\.js/);
  assert.ok(preview.reply_markup.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('x:pr:')));
  assert.equal(await w.app.code.receiveJobPart(job, 2, 'x'), false, 'задача закрыта');
});

test('/code через Actions: ошибка из Actions доходит до владельца; нет прав на запуск — подсказка и запасной путь по шагам', async () => {
  const w = await createWorld({ cfg: { codeViaActions: true } });
  w.gh.repos['me/site'] = { default_branch: 'main', files: { 'a.js': 'x' } };
  w.gh.repos['grunvald91/my_ai_assistent'] = { default_branch: 'main', files: {} };
  await w.say('/repo me/site');
  await w.say('/code задача');
  const job = w.gh.dispatches.at(-1).inputs.job;
  await w.app.code.finishJob({ job, n: 0, error: 'модель недоступна' });
  assert.match(w.last(OWNER).text, /Задача в GitHub Actions не удалась: модель недоступна/);

  w.gh.repos['grunvald91/my_ai_assistent'].actionsDenied = true;
  w.clear();
  w.llmReplies.push('NONE', '@@@ COMMIT: x\n@@@ SUMMARY: y\n@@@ FILE create b.js\nconsole.log(1)\n@@@ END');
  await w.say('/code ещё задача');
  assert.ok(w.sent(OWNER).some((m) => /запустить не вышло/.test(m.text) && /Actions/.test(m.text)));
  assert.ok(w.last(OWNER).reply_markup.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('x:pr:')), 'запасной путь довёл до предпросмотра');
});
