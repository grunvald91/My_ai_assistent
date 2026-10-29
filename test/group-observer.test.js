import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

const GROUP = -5001;
const invite = ({ by = 2002, oldStatus = 'left', status = 'member', type = 'supergroup' } = {}) => ({
  chat: { id: GROUP, type, title: 'Партнёрская группа' },
  from: { id: by, is_bot: false, first_name: 'Участник' },
  old_chat_member: { status: oldStatus },
  new_chat_member: { status },
});
const key = () => 'group_observe:' + GROUP;

test('посторонний добавляет бота: он остаётся, но аналитика и ответы выключены', async () => {
  const w = await createWorld();
  await w.dispatchRaw('my_chat_member', invite());
  assert.equal(w.calls('leaveChat').length, 0);
  assert.equal((await w.store.getChat(GROUP)).groupMode, 'off');
  assert.equal(await w.store.getSetting(key()), null);
  assert.match(w.last(OWNER).text, /не отвечаю до твоего разрешения/);
  await w.group('Обычное сообщение');
  await w.group('/ask почему нет ответа?');
  assert.equal(w.llmCalls.length, 0);
  assert.equal(await w.store.countAfter(String(GROUP), 0), 0);
  assert.equal(w.last(OWNER).reply_markup.inline_keyboard[0][0].callback_data, 'g:observe:' + GROUP + ':on');
});

test('только владелец включает наблюдение; бот объявляет его участникам', async () => {
  const w = await createWorld();
  await w.dispatchRaw('my_chat_member', invite());
  await w.press('g:observe:' + GROUP + ':on', { from: 2002 });
  assert.equal(await w.store.getSetting(key()), null);
  assert.equal(w.calls('leaveChat').length, 0);

  await w.press('g:observe:' + GROUP + ':on');
  assert.equal(await w.store.getSetting(key()), '1');
  assert.match(w.last(GROUP).text, /ИИ-наблюдатель/);
  assert.equal((await w.store.getChat(GROUP)).groupMode, 'off', 'наблюдение без навязчивых ответов');
  await w.group('Клиент подтвердил заказ');
  assert.equal(w.llmCalls.length, 0, 'сбор текста не вызывает LLM на каждое сообщение');
  const hist = await w.store.getHistory(String(GROUP), 0, 10);
  assert.match(hist.at(-1).text, /Клиент подтвердил заказ/);
  assert.match(hist.at(-1).text, /Telegram #/);
});

test('сбор фото включает визуальное описание, но не сохраняет изображение в истории', async () => {
  const w = await createWorld({ cfg: { groupObserveReportEvery: 50 } });
  await w.dispatchRaw('my_chat_member', invite());
  await w.press('g:observe:' + GROUP + ':on');
  await w.group('', { extra: { photo: [{ file_id: 'photo1', file_size: 8 }] } });
  const hist = await w.store.getHistory(String(GROUP), 0, 10);
  assert.equal(hist.length, 1);
  assert.match(hist[0].text, /\[Фото:/);
  assert.ok(!hist[0].text.includes('base64,'));
  assert.equal(w.llmCalls.length, 1, 'запрос к модели со зрением');
});

test('автоотчёт после N сообщений и накопление предыдущего вывода', async () => {
  const w = await createWorld({ cfg: {
    groupObserveReportEvery: 2,
    groupObserveReportMinGapSec: 0,
    groupObserveAutoCutoffMs: 60000,
  } });
  await w.dispatchRaw('my_chat_member', invite());
  await w.press('g:observe:' + GROUP + ':on');
  w.llmReplies.push('Факты: заказ получен; гипотеза: нужен контроль срока.');
  await w.group('Заказ получили');
  await w.group('Срок выполнения до пятницы');
  assert.match(w.last(OWNER).text, /Аналитика:/);
  assert.match(w.last(OWNER).text, /нужен контроль срока/);
  const first = JSON.parse(await w.store.getSetting('group_report:' + GROUP));
  assert.equal(first.summary.includes('заказ получен'), true);
  w.advance(6 * 3600);
  w.llmReplies.push('Долгосрочные тенденции: проверять выполнение сроков.');
  await w.group('Новое поручение по заказу');
  await w.group('Проверили готовность');
  const lastCall = w.llmCalls.at(-1);
  assert.match(lastCall.messages.at(-1).content, /нужен контроль срока/);
  const second = JSON.parse(await w.store.getSetting('group_report:' + GROUP));
  assert.ok(second.lastId > first.lastId);
});

test('владелец может стереть наблюдение и историю, либо покинуть группу', async () => {
  const w = await createWorld();
  await w.dispatchRaw('my_chat_member', invite());
  await w.press('g:observe:' + GROUP + ':on');
  await w.group('Сохранили сообщение');
  await w.press('g:erase:' + GROUP);
  assert.equal(await w.store.getSetting(key()), '1', 'простое нажатие не стирает данные');
  await w.press('g:erase-confirm:' + GROUP);
  assert.equal(await w.store.getSetting(key()), null);
  assert.equal(await w.store.getSetting('group_report:' + GROUP), null);
  assert.equal(await w.store.countAfter(String(GROUP), 0), 0);
  assert.equal((await w.store.getChat(GROUP)).groupMode, 'off');
  await w.press('g:leave:' + GROUP);
  assert.equal(w.calls('leaveChat').length, 1);
});
