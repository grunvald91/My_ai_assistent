import test from 'node:test';
import { createWorld, assert, OWNER, BOT_NAME, BOT_ID } from './helpers/world.js';

test('личка владельца: ответ ИИ, стриминг черновиком, учёт расхода и памяти', async () => {
  const w = await createWorld();
  w.llmReplies.push('Привет! Давай считать деньги.');
  await w.say('Привет');

  assert.ok(w.calls('sendMessageDraft').length >= 1, 'был черновик стриминга');
  assert.equal(w.calls('sendMessageDraft')[0].can_stop, true);
  const reply = w.last(OWNER);
  assert.match(reply.text, /Давай считать деньги/);
  assert.equal(reply.parse_mode, 'HTML');

  const body = w.llmCalls.at(-1);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.match(body.messages[0].content, /за процент/);
  assert.equal(body.messages.at(-1).content, 'Привет');

  const hist = await w.store.getHistory(String(OWNER), 0, 10);
  assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant']);
  const u = await w.app.core.todayUsage();
  assert.equal(u.requests, 1);
  assert.ok(u.tokensIn > 0 && u.costUsd > 0);
});

test('второе сообщение видит историю', async () => {
  const w = await createWorld();
  await w.say('Меня зовут Артур');
  await w.say('Как меня зовут?');
  const msgs = w.llmCalls.at(-1).messages;
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'Меня зовут Артур'));
  assert.ok(msgs.some((m) => m.role === 'assistant'));
});

test('чужой пользователь получает отказ один раз в час, /id работает', async () => {
  const w = await createWorld();
  await w.say('привет', { from: 5555 });
  assert.match(w.last(5555).text, /личный бот/);
  assert.equal(w.llmCalls.length, 0);
  w.clear();
  await w.say('ещё раз', { from: 5555 });
  assert.equal(w.sent(5555).length, 0);
  await w.say('/id', { from: 5555 });
  assert.match(w.last(5555).text, /5555/);
  w.advance(3700);
  await w.say('привет', { from: 5555 });
  assert.match(w.last(5555).text, /личный бот/);
});

test('владелец не задан: бот показывает ID и просит настроить', async () => {
  const w = await createWorld({ ownerIds: [] });
  await w.say('привет', { from: 4242 });
  assert.match(w.last(4242).text, /OWNER_IDS/);
  assert.match(w.last(4242).text, /4242/);
  assert.equal(w.llmCalls.length, 0);
});

test('дубль апдейта не обрабатывается дважды', async () => {
  const w = await createWorld();
  const upd = { message_id: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'А' }, text: 'раз' };
  await w.app.handle('message', upd, { update: { update_id: 9001 } });
  await w.app.handle('message', upd, { update: { update_id: 9001 } });
  assert.equal(w.llmCalls.length, 1);
});

test('ошибка ClaudeHub: понятный текст и кнопка «Повторить», повтор работает', async () => {
  const w = await createWorld();
  w.llmReplies.push({ status: 402, body: { error: { message: 'no money' } } });
  await w.say('Привет');
  assert.match(w.last(OWNER).text, /баланс/i);
  w.clear();

  w.llmReplies.push({ status: 503, body: { error: { message: 'down' } } }, { status: 503, body: { error: { message: 'down' } } }, { status: 503, body: { error: { message: 'down' } } });
  await w.say('Привет ещё');
  const err = w.last(OWNER);
  assert.match(err.text, /недоступны/);
  assert.ok(err.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'r:1'), 'есть кнопка «Повторить»');

  w.llmReplies.push('Теперь работает');
  await w.press('r:1');
  assert.match(w.last(OWNER).text, /Теперь работает/);
});

test('ретраи: 503 → успех со второй попытки', async () => {
  const w = await createWorld();
  w.llmReplies.push({ status: 503, body: {} }, 'Со второго раза');
  await w.say('Привет');
  assert.match(w.last(OWNER).text, /Со второго раза/);
  assert.equal(w.llmCalls.length, 2);
});

test('дневной лимит токенов останавливает ответы; /limit поднимает', async () => {
  const w = await createWorld({ cfg: { dailyTokenLimit: 10000 } });
  await w.store.addUsage('2027-01-15', 6000, 5000, 0);
  await w.say('Привет');
  assert.match(w.last(OWNER).text, /лимит/i);
  assert.equal(w.llmCalls.length, 0);
  await w.say('/limit 100k');
  assert.match(w.last(OWNER).text, /100 000/);
  await w.say('Привет');
  assert.equal(w.llmCalls.length, 1);
});

test('/model: список по производителям, выбор модели влияет на запрос, чат-модели без картинок', async () => {
  const w = await createWorld();
  await w.say('/model');
  const kb = w.last(OWNER).reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(kb.some((t) => t.startsWith('Claude (2)')));
  assert.ok(kb.some((t) => t.startsWith('GPT (1)')));
  assert.ok(!kb.some((t) => /image/i.test(t)));

  await w.press('m:p:1', { messageId: 7 }); // GPT
  const edit = w.calls('editMessageText').at(-1);
  const gptBtn = edit.reply_markup.inline_keyboard[0][0];
  assert.match(gptBtn.text, /GPT-5/);
  await w.press(gptBtn.callback_data, { messageId: 7 });
  await w.say('Привет');
  assert.equal(w.llmCalls.at(-1).model, 'gpt-5');
  assert.equal('max_tokens' in w.llmCalls.at(-1), false, 'для не-Claude max_tokens не передаём');

  await w.say('/model opus');
  assert.match(w.last(OWNER).text, /claude-opus-5-5/);
  await w.say('Ещё');
  assert.equal(w.llmCalls.at(-1).model, 'claude-opus-5-5');
});

test('список моделей кешируется на 24 часа', async () => {
  const w = await createWorld();
  const core = w.app.core;
  await core.getModels();
  await core.getModels();
  assert.equal(w.modelFetches, 1);
  w.advance(3600);
  await core.getModels();
  assert.equal(w.modelFetches, 1, 'в пределах суток не обновляем');
  w.advance(24 * 3600);
  await core.getModels();
  assert.equal(w.modelFetches, 2, 'через сутки обновили');
  await core.getModels({ force: true });
  assert.equal(w.modelFetches, 3, 'принудительное обновление');
});

test('память: /remember, /memory, /forget, предложение «запомнить» и кнопка', async () => {
  const w = await createWorld();
  await w.say('/remember Мой канал про недвижимость');
  assert.match(w.last(OWNER).text, /Запомнил/);
  await w.say('/memory');
  assert.match(w.last(OWNER).text, /недвижимость/);

  w.llmReplies.push('Хорошо.\n[[запомнить: Целевая аудитория — инвесторы]]');
  await w.say('Моя аудитория — инвесторы');
  const m = w.last(OWNER);
  assert.doesNotMatch(m.text, /\[\[/);
  const yes = m.reply_markup.inline_keyboard[0][0].callback_data;
  await w.press(yes);
  const facts = await w.store.listMemories(['owner']);
  assert.equal(facts.length, 2);
  assert.equal(facts[1].source, 'confirmed');

  // факты попадают в системный промпт следующего ответа
  await w.say('Привет');
  assert.match(w.llmCalls.at(-1).messages[0].content, /инвесторы/);

  await w.say(`/forget ${facts[0].id}`);
  assert.equal((await w.store.listMemories(['owner'])).length, 1);
});

test('/reset очищает историю, /forget_all — только после подтверждения', async () => {
  const w = await createWorld();
  await w.say('/remember факт');
  await w.say('Привет');
  await w.say('/reset');
  assert.equal((await w.store.getHistory(String(OWNER), 0, 10)).length, 0);
  assert.equal((await w.store.listMemories(['owner'])).length, 1);
  await w.say('/forget_all');
  assert.equal((await w.store.listMemories(['owner'])).length, 1, 'пока не подтвердили');
  await w.press('fa:y');
  assert.equal((await w.store.listMemories(['owner'])).length, 0);
});

test('сводка: после порога старые сообщения сжимаются в сводку (память ур. 2)', async () => {
  const w = await createWorld({ cfg: { summaryTrigger: 6, historyMessages: 2 } });
  w.llmDefault = (b) => (b.messages[0].content.includes('сжимаешь историю') ? '- владелец делает курсы' : 'ок');
  for (let i = 0; i < 5; i++) await w.say('сообщение ' + i);
  const chat = await w.store.getChat(OWNER);
  assert.match(chat.summary, /курсы/);
  assert.ok(chat.summaryUpto > 0);
  await w.say('дальше');
  assert.match(w.llmCalls.at(-1).messages[0].content, /СВОДКА ПРЕДЫДУЩЕГО РАЗГОВОРА[\s\S]*курсы/);
});

test('/usage показывает расход и баланс, /export присылает файл, /stop и /resume', async () => {
  const w = await createWorld();
  await w.say('Привет');
  await w.say('/usage');
  assert.match(w.last(OWNER).text, /Сегодня/);
  assert.match(w.last(OWNER).text, /1 234\.50 ₽/);
  await w.say('/export');
  const doc = w.calls('sendDocument').at(-1);
  assert.match(doc.document.name, /^assistant-export-2027-01-15\.json$/);
  assert.ok(doc.document.bytes.length > 50);
  await w.say('/stop');
  assert.equal(await w.store.getSetting('paused'), '1');
  await w.say('/resume');
  assert.equal(await w.store.getSetting('paused'), null);
});

test('меню команд обновляется один раз на версию', async () => {
  const w = await createWorld();
  await w.say('/help');
  const n = w.calls('setMyCommands').length;
  assert.ok(n >= 3);
  await w.say('/help');
  assert.equal(w.calls('setMyCommands').length, n);
});

test('Telegram отверг HTML-разметку → отправляем простым текстом', async () => {
  const w = await createWorld();
  w.llmReplies.push('Ответ **жирный**');
  w.fail('sendMessage', 400, "Bad Request: can't parse entities: Unsupported start tag");
  await w.say('Привет');
  const msgs = w.sent(OWNER);
  assert.equal(msgs.at(-1).parse_mode, undefined);
  assert.match(msgs.at(-1).text, /Ответ/);
});

test('длинный ответ режется на части до 4096 символов', async () => {
  const w = await createWorld();
  w.llmReplies.push(('Абзац про деньги. '.repeat(40) + '\n\n').repeat(12));
  await w.say('длинно');
  const parts = w.sent(OWNER);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.text.length <= 4096);
});

test('кнопка «Стоп» при стриминге останавливает ответ', async () => {
  const w = await createWorld();
  w.llmReplies.push('Очень длинный ответ. '.repeat(40));
  // эмулируем нажатие «Стоп» сразу после первого черновика
  const orig = globalThis.__tg;
  globalThis.__tg = async (m, p) => {
    const r = await orig(m, p);
    if (m === 'sendMessageDraft' && p.text) await w.dispatchRaw('stopped_message_generation', { chat: { id: p.chat_id }, draft_id: p.draft_id });
    return r;
  };
  await w.say('Привет');
  globalThis.__tg = orig;
  assert.match(w.last(OWNER).text, /Остановлено/);
});

test('команда другого бота игнорируется', async () => {
  const w = await createWorld();
  await w.say('/model@otherbot');
  assert.equal(w.sent(OWNER).length, 0);
  await w.say(`/id@${BOT_NAME}`);
  assert.match(w.last(OWNER).text, /1001/);
});
