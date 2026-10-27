import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';

const buttons = (m) => (m.reply_markup?.inline_keyboard ?? []).flat();
const SELF = 'grunvald91/my_ai_assistent';

async function heavyWorld(extra = {}) {
  const w = await createWorld({ cfg: { bgViaActions: true, ...extra } });
  w.gh.repos[SELF] = { default_branch: 'main', files: { 'README.md': 'bot' } };
  await w.say('/start');
  await w.store.updateChat(OWNER, { model: 'claude-opus-5-5' });
  w.clear();
  return w;
}

test('фон: вопрос тяжёлой модели уходит в Actions, в параметрах запуска только id; ответ приходит сам', async () => {
  const w = await heavyWorld();
  await w.say('Сформулируй ответ на новость про рубль и приложи источник');
  assert.equal(w.llmCalls.length, 0, 'модель в боте не вызывалась');
  const d = w.gh.dispatches.find((x) => x.workflow === 'bgjob.yml');
  assert.ok(d, 'workflow bgjob.yml запущен');
  assert.deepEqual(Object.keys(d.inputs), ['job'], 'в публичных параметрах запуска нет текста переписки');
  const job = d.inputs.job;

  const status = w.last(OWNER);
  assert.match(status.text, /готовит ответ в фоне/);
  assert.ok(buttons(status).find((b) => b.callback_data === 'bg:g:' + job), 'кнопка «Забрать ответ»');

  // задача забирает запрос у бота
  const req = await w.app.bg.getRequest(job, 0);
  assert.equal(req.n, 1);
  const body = JSON.parse(req.text);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.match(body.messages.at(-1).content, /рубль/);

  // пока не готово — кнопка честно говорит об этом
  w.clear();
  await w.press('bg:g:' + job, { messageId: status.message_id ?? 5 });
  assert.match(w.calls('answerCallbackQuery').at(-1).text, /Ещё готовится/);
  assert.equal(w.sent(OWNER).length, 0);

  // Actions присылает ответ частями и итог — бот сам показывает его
  const answer = 'Вот ответ. '.repeat(20);
  assert.equal(await w.app.bg.receivePart(job, 0, answer.slice(0, 50)), true);
  assert.equal(await w.app.bg.receivePart(job, 1, answer.slice(50)), true);
  assert.equal(await w.app.bg.finish({ job, n: 2, finish: 'stop', usage: { in: 1200, out: 300 }, model: 'claude-opus-5-5', error: null }), true);
  assert.equal(w.last(OWNER).text.trim(), answer.trim(), 'ответ собран из частей и показан');
  const hist = await w.store.getHistory(String(OWNER), 0, 5);
  assert.equal(hist.at(-1).role, 'assistant');
  assert.equal(hist.at(-1).model, 'claude-opus-5-5');
  const usage = await w.app.core.todayUsage();
  assert.equal(usage.tokensIn, 1200, 'расход записан по данным модели');
  assert.equal(usage.tokensOut, 300);
  assert.ok(usage.costUsd > 0, 'стоимость посчитана по цене модели');

  // повторная выдача невозможна; кнопка говорит, что ответа уже нет
  assert.equal(await w.app.bg.deliver(job), false);
  w.clear();
  await w.press('bg:g:' + job);
  assert.match(w.calls('answerCallbackQuery').at(-1).text, /уже нет/);
  assert.equal(w.sent(OWNER).length, 0);
});

test('фон: ответ можно забрать кнопкой, если автоматическая выдача не удалась', async () => {
  const w = await heavyWorld();
  await w.say('Вопрос');
  const job = w.gh.dispatches.at(-1).inputs.job;
  await w.app.bg.receivePart(job, 0, 'Готовый ответ');
  w.fail('sendMessage', 1); // Telegram на секунду отказал
  await w.app.bg.finish({ job, n: 1, finish: 'stop', usage: null, model: 'claude-opus-5-5', error: null });
  const before = (await w.app.core.todayUsage()).tokensOut;
  w.clear();
  await w.press('bg:g:' + job);
  assert.equal(w.last(OWNER).text.trim(), 'Готовый ответ');
  assert.equal((await w.app.core.todayUsage()).tokensOut, before, 'расход не посчитан второй раз');
});

test('фон: отмена готового, но не выданного ответа убирает следы', async () => {
  const w = await heavyWorld();
  await w.say('Вопрос');
  const job = w.gh.dispatches.at(-1).inputs.job;
  await w.app.bg.receivePart(job, 0, 'Ответ');
  w.fail('sendMessage', 1);
  await w.app.bg.finish({ job, n: 1, finish: 'stop', usage: null, model: 'claude-opus-5-5', error: null });
  await w.press('bg:x:' + job);
  assert.equal(await w.store.getSetting('bg:' + job), null);
  assert.equal(await w.store.getSetting(`bg:${job}:a0`), null);
});

test('фон: ошибка задачи — понятное сообщение и «Повторить»', async () => {
  const w = await heavyWorld();
  await w.say('Вопрос');
  const job = w.gh.dispatches.at(-1).inputs.job;
  await w.app.bg.finish({ job, n: 0, error: 'модель недоступна' });
  const m = w.last(OWNER);
  assert.match(m.text, /не получился: модель недоступна/);
  assert.ok(buttons(m).find((b) => b.callback_data === 'r:1'));
  assert.equal(await w.app.bg.getRequest(job, 0), null, 'задача закрыта');
});

test('фон: отмена — поздний ответ выбрасывается', async () => {
  const w = await heavyWorld();
  await w.say('Вопрос');
  const job = w.gh.dispatches.at(-1).inputs.job;
  await w.press('bg:x:' + job);
  assert.equal(await w.app.bg.getRequest(job, 0), null, 'запрос больше не отдаётся');
  w.clear();
  await w.app.bg.receivePart(job, 0, 'Поздний ответ');
  await w.app.bg.finish({ job, n: 1, finish: 'stop', usage: null, model: 'claude-opus-5-5', error: null });
  assert.equal(w.sent(OWNER).length, 0, 'ничего не показано');
  assert.equal(await w.store.getSetting('bg:' + job), null, 'следы убраны');
});

test('фон: лёгкая модель, выключенный /bg и вложения отвечают обычным путём', async () => {
  // лёгкая модель
  let w = await heavyWorld();
  await w.store.updateChat(OWNER, { model: 'claude-sonnet-5-5' });
  w.llmReplies.push('обычный ответ');
  await w.say('Вопрос');
  assert.equal(w.gh.dispatches.length, 0);
  assert.match(w.last(OWNER).text, /обычный ответ/);

  // /bg выкл
  w = await heavyWorld();
  await w.say('/bg выкл');
  assert.match(w.last(OWNER).text, /выключено/);
  w.llmReplies.push('ответ на месте');
  await w.say('Вопрос');
  assert.equal(w.gh.dispatches.length, 0);
  assert.match(w.last(OWNER).text, /ответ на месте/);
  await w.say('/bg вкл');
  assert.match(w.last(OWNER).text, /включено/);

  // вложение: картинки/файлы в фон не уходят
  w = await heavyWorld();
  w.llmReplies.push('вижу файл');
  await w.doc('F1', { name: 'note.txt', bytes: 'привет из файла', caption: 'Что тут?' });
  assert.equal(w.gh.dispatches.length, 0, 'с вложением — не в фон');
  assert.equal(w.llmCalls.length, 1, 'ответила модель прямо в боте');
});

test('фон: Actions недоступны — понятное сообщение и обычный ответ', async () => {
  const w = await heavyWorld();
  w.gh.repos[SELF].actionsDenied = true;
  w.llmReplies.push('ответил сам');
  await w.say('Вопрос');
  const texts = w.sent(OWNER).map((m) => m.text).join('\n');
  assert.match(texts, /В GitHub Actions ответ запустить не вышло/);
  assert.match(texts, /ответил сам/);
  assert.equal(await w.store.getSetting('bg:' + (w.gh.dispatches.at(-1)?.inputs?.job ?? 'x')), null);
});

test('фон: проверочная задача диагностики не пишет владельцу и сообщает итог', async () => {
  const w = await heavyWorld();
  const a = await w.app.bg.selfTest();
  assert.equal(a.stage, 'started');
  const d = w.gh.dispatches.find((x) => x.workflow === 'bgjob.yml');
  assert.equal(d.inputs.job, a.job);
  const req = JSON.parse((await w.app.bg.getRequest(a.job, 0)).text);
  assert.equal(req.maxTokens, 20);
  w.clear();
  assert.equal((await w.app.bg.selfTest()).state, 'run', 'ещё идёт');
  await w.app.bg.receivePart(a.job, 0, 'ок');
  await w.app.bg.finish({ job: a.job, n: 1, finish: 'stop', usage: { in: 9, out: 1 }, model: req.model, error: null });
  const b = await w.app.bg.selfTest();
  assert.equal(b.state, 'ready');
  assert.equal(b.answer_parts, 1);
  assert.equal(w.sent(OWNER).length, 0, 'владельцу ничего не отправлено');
  assert.equal((await w.app.bg.selfTest()).stage, 'started', 'следы убраны, можно проверять снова');
});
