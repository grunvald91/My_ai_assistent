import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { createLlm, LlmError, toAnthropic } from '../tgcloud/lib/llm.js';
import { API_BASE } from '../tgcloud/lib/config.js';
import { runIcon, runWord } from '../tgcloud/lib/actions.js';

// ───────── /think и лимиты ответа ─────────

test('/think: панель с четырьмя уровнями, кнопка и текстовая команда меняют настройку', async () => {
  const w = await createWorld();
  await w.say('/think');
  const btns = w.last(OWNER).reply_markup.inline_keyboard.flat();
  assert.deepEqual(btns.map((b) => b.text), ['● Выкл', 'Низкий', 'Средний', 'Высокий']);
  assert.match(w.last(OWNER).text, /поддерживает/);

  await w.press('t:high');
  assert.equal(await w.store.getSetting('think'), 'high');
  assert.match(w.calls('editMessageText').at(-1).text, /Высокий/);

  await w.say('/think средний');
  assert.equal(await w.store.getSetting('think'), 'medium');
  await w.say('/think off');
  assert.equal(await w.store.getSetting('think'), 'off');
  await w.say('/think сверхвысокий');
  assert.match(w.last(OWNER).text, /Уровни: выкл, низкий, средний, высокий/);
  assert.equal(await w.store.getSetting('think'), 'off');
});

test('без /think: обычный chat/completions, лимит ответа = максимум модели (128 000 у Sonnet 5.5)', async () => {
  const w = await createWorld();
  w.llmReplies.push('Привет!');
  await w.say('Привет');
  assert.deepEqual(w.llmPaths, ['/v1/chat/completions']);
  assert.equal(w.llmCalls[0].max_tokens, 128000);
  assert.equal(w.llmCalls[0].thinking, undefined);
  assert.equal(w.llmCalls[0].reasoning_effort, undefined);
});

test('/think средний: Claude идёт в /v1/messages с бюджетом размышлений; текст размышлений не показывается', async () => {
  const w = await createWorld();
  await w.say('/think средний');
  w.clear();
  w.llmReplies.push('Готовый ответ после раздумий.');
  await w.say('Посчитай мне налоги');

  assert.deepEqual(w.llmPaths, ['/v1/messages']);
  const b = w.llmCalls[0];
  assert.deepEqual(b.thinking, { type: 'enabled', budget_tokens: 12000 });
  assert.equal(b.max_tokens, 128000);
  assert.equal(b.temperature, undefined);
  assert.match(b.system, /за процент/, 'system вынесен в отдельное поле');
  assert.equal(b.messages[0].role, 'user');
  assert.ok(b.messages.every((m) => m.role !== 'system'));
  assert.equal(b.messages.at(-1).content, 'Посчитай мне налоги');

  const text = w.last(OWNER).text;
  assert.match(text, /Готовый ответ после раздумий/);
  assert.doesNotMatch(text, /подумаю над задачей/);
  assert.doesNotMatch(text, /не приняла режим/);
  const u = await w.app.core.todayUsage();
  assert.equal(u.tokensIn, 100, 'вход из message_start');
  assert.ok(u.tokensOut > 1, 'выход из message_delta, а не заглушка из message_start');
});

test('/think: ClaudeHub отверг бюджет → пробуем adaptive+effort → без размышлений, с пометкой в ответе', async () => {
  const w = await createWorld();
  await w.say('/think высокий');
  w.clear();
  w.llmReplies.push(
    { status: 400, body: { error: { message: 'thinking.type.enabled is not supported for this model; use adaptive' } } },
    { status: 400, body: { error: { message: 'output_config.effort is not supported' } } },
    'Ответ без размышлений',
  );
  await w.say('Вопрос');
  assert.deepEqual(w.llmPaths, ['/v1/messages', '/v1/messages', '/v1/chat/completions']);
  assert.equal(w.llmCalls[0].thinking.type, 'enabled');
  assert.deepEqual(w.llmCalls[1].thinking, { type: 'adaptive' });
  assert.deepEqual(w.llmCalls[1].output_config, { effort: 'high' });
  assert.equal(w.llmCalls[2].thinking, undefined);
  assert.match(w.last(OWNER).text, /Ответ без размышлений/);
  assert.match(w.last(OWNER).text, /не приняла режим размышлений/);
});

test('/think: adaptive подошёл — дальше не откатываемся', async () => {
  const w = await createWorld();
  await w.say('/think низкий');
  w.clear();
  w.llmReplies.push({ status: 400, body: { error: { message: 'budget_tokens is deprecated, use adaptive thinking' } } }, 'Вот ответ');
  await w.say('Вопрос');
  assert.deepEqual(w.llmPaths, ['/v1/messages', '/v1/messages']);
  assert.deepEqual(w.llmCalls[1].output_config, { effort: 'low' });
  assert.doesNotMatch(w.last(OWNER).text, /не приняла/);
});

test('/think для не-Claude модели: reasoning_effort и max_completion_tokens в chat/completions', async () => {
  const w = await createWorld();
  await w.say('/model gpt-5');
  await w.say('/think высокий');
  w.clear();
  w.llmReplies.push('GPT отвечает');
  await w.say('Привет');
  assert.deepEqual(w.llmPaths, ['/v1/chat/completions']);
  const b = w.llmCalls[0];
  assert.equal(b.reasoning_effort, 'high');
  assert.equal(b.max_completion_tokens, 32000);
  assert.equal(b.max_tokens, undefined);

  // шлюз не принял reasoning_effort → снимаем параметр и повторяем
  w.clear();
  w.llmReplies.push({ status: 400, body: { error: { message: "Unknown parameter: 'reasoning_effort'" } } }, 'Без эффорта');
  await w.say('Ещё');
  assert.equal(w.llmCalls.length, 2);
  assert.equal(w.llmCalls[1].reasoning_effort, undefined);
  assert.match(w.last(OWNER).text, /Без эффорта/);
});

test('группы и посты не размышляют и не используют максимум: лимит маленький, chat/completions', async () => {
  const w = await createWorld();
  await w.say('/think высокий');
  await w.setGroupMode(-5001, 'all');
  w.clear();
  await w.group('кто тут', { chat: -5001 });
  assert.ok(w.llmCalls.length >= 1, 'бот в группе ответил');
  for (let i = 0; i < w.llmCalls.length; i++) {
    assert.equal(w.llmPaths[i], '/v1/chat/completions');
    assert.equal(w.llmCalls[i].thinking, undefined);
    assert.ok((w.llmCalls[i].max_tokens ?? 0) <= 1200);
  }
});

test('core: модель без поддержки размышлений игнорирует /think; maxTokens "max" берёт maxOut модели', async () => {
  const w = await createWorld();
  w.llmReplies.push('ок');
  const r = await w.app.core.generate({
    model: { id: 'claude-sonnet-5-5', thinking: false, maxOut: 1000, priceIn: null },
    messages: [{ role: 'user', content: 'привет' }],
    maxTokens: 'max',
    think: 'high',
  });
  assert.equal(r.thinkAsked, false);
  assert.deepEqual(w.llmPaths, ['/v1/chat/completions']);
  assert.equal(w.llmCalls[0].max_tokens, 1000);
});

test('llm: весь лимит ушёл на размышления → понятная ошибка без повторов (платный вызов не дублируем)', async () => {
  const enc = new TextEncoder();
  const ev = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let calls = 0;
  const fetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          yield ev('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } });
          yield ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'думаю, думаю…' } });
          yield ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5000 } });
          yield ev('message_stop', {});
        },
      },
    };
  };
  const llm = createLlm({ fetch, apiKey: 'k', base: API_BASE, retries: 2 });
  await assert.rejects(
    llm.chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }], maxTokens: 6000, stream: true, think: { level: 'high', budget: 32000 } }),
    (e) => e instanceof LlmError && e.kind === 'budget' && /\/think/.test(e.userMessage),
  );
  assert.equal(calls, 1);
});

test('llm: бюджет размышлений не превышает max_tokens − 1024; слишком маленький лимит — без размышлений', async () => {
  const seen = [];
  const fetch = async (url, o) => {
    seen.push([url, JSON.parse(o.body)]);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  const llm = createLlm({ fetch, apiKey: 'k', base: API_BASE });
  const msgs = [{ role: 'user', content: 'x' }];
  await llm.chat({ model: 'claude-opus-5-5', messages: msgs, maxTokens: 8000, think: { level: 'high', budget: 32000 } });
  assert.equal(seen[0][1].thinking.budget_tokens, 8000 - 1024);
  await llm.chat({ model: 'claude-opus-5-5', messages: msgs, maxTokens: 1500, think: { level: 'high', budget: 32000 } });
  assert.equal(seen[1][1].thinking, undefined, 'budget < 1024 — размышления не включаем');
});

test('toAnthropic: system отдельно, соседние реплики одной роли склеены, диалог начинается с user', () => {
  const r = toAnthropic([
    { role: 'system', content: 'Правила' },
    { role: 'assistant', content: 'старый ответ' },
    { role: 'user', content: 'раз' },
    { role: 'user', content: 'два' },
    { role: 'system', content: 'ещё правило' },
  ]);
  assert.equal(r.system, 'Правила\n\nещё правило');
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(r.messages[2].content, 'раз\n\nдва');
});

test('/code использует /think и максимум модели', async () => {
  const w = await createWorld();
  w.gh.repos['me/site'] = { default_branch: 'main', private: true, files: { 'a.js': 'x' } };
  await w.say('/repo me/site');
  await w.say('/think высокий');
  w.clear();
  w.llmReplies.push('NONE', '@@@ COMMIT: x\n@@@ SUMMARY: y\n@@@ FILE create b.js\nconsole.log(1)\n@@@ END');
  await w.say('/code добавь b.js');
  assert.deepEqual(w.llmPaths, ['/v1/chat/completions', '/v1/messages']);
  assert.equal(w.llmCalls[0].max_tokens, 400, 'выбор файлов — короткий вызов без размышлений');
  assert.equal(w.llmCalls[1].max_tokens, 128000);
  assert.equal(w.llmCalls[1].thinking.budget_tokens, 32000);
});

test('меню команд: /think и /runs добавлены, версия поднята', async () => {
  const w = await createWorld();
  await w.say('/start');
  const cmds = w.calls('setMyCommands').find((p) => p.scope?.type === 'chat').commands.map((c) => c.command);
  assert.ok(cmds.includes('think') && cmds.includes('runs'));
});

// ───────── GitHub Actions ─────────

const iso = (w) => new Date(w.now * 1000).toISOString();
const WF = {
  deploy: { id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' },
  ci: { id: 2, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
};
function actionsRepo(w) {
  return {
    default_branch: 'main',
    private: true,
    files: {
      '.github/workflows/deploy.yml': 'name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      env: {}\njobs: {}',
      '.github/workflows/ci.yml': 'name: CI\non: push\njobs: {}',
    },
    workflows: [WF.deploy, WF.ci],
    runs: [
      { id: 501, workflow_id: 2, name: 'CI', run_number: 7, status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'push', created_at: iso(w), html_url: 'https://github.com/me/site/actions/runs/501' },
      { id: 500, workflow_id: 1, name: 'Deploy', run_number: 3, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'workflow_dispatch', created_at: iso(w), html_url: 'https://github.com/me/site/actions/runs/500' },
    ],
    jobs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/me/site/actions/runs/501/job/9', steps: [{ name: 'npm test', conclusion: 'failure' }, { name: 'checkout', conclusion: 'success' }] }],
  };
}
async function withRepo(w, extra = {}) {
  w.gh.repos['me/site'] = { ...actionsRepo(w), ...extra };
  await w.say('/repo me/site');
  w.clear();
}

test('runs: иконки и слова статусов', () => {
  assert.equal(runIcon({ status: 'completed', conclusion: 'success' }), '✅');
  assert.equal(runIcon({ status: 'completed', conclusion: 'failure' }), '❌');
  assert.equal(runIcon({ status: 'in_progress' }), '🟡');
  assert.equal(runWord({ status: 'queued' }), 'в очереди');
  assert.equal(runWord({ status: 'completed', conclusion: 'cancelled' }), 'отменён');
});

test('/runs без токена и без репозитория подсказывает, что делать', async () => {
  let w = await createWorld({ github: false });
  await w.say('/runs');
  assert.match(w.last(OWNER).text, /GH_PAT/);
  assert.match(w.last(OWNER).text, /Actions/);
  w = await createWorld();
  await w.say('/runs');
  assert.match(w.last(OWNER).text, /Сначала выбери репозиторий/);
});

test('/runs: запуски, кнопки Run workflow только у workflow_dispatch, «что упало», обновить', async () => {
  const w = await createWorld();
  await withRepo(w);
  await w.say('/runs');
  const m = w.last(OWNER);
  assert.match(m.text, /me\/site/);
  assert.match(m.text, /✅ <a href="https:\/\/github\.com\/me\/site\/actions\/runs\/500">Deploy<\/a> #3/);
  assert.match(m.text, /❌ .*CI.* #7/);
  assert.match(m.text, /Без кнопки запуска.*ci\.yml/s);
  const btns = m.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(btns.includes('▶️ Deploy'));
  assert.ok(!btns.includes('▶️ CI'), 'у CI нет workflow_dispatch');
  assert.ok(btns.some((t) => t.startsWith('🔍 Что упало: #7')));
  assert.ok(btns.includes('🔄 Обновить'));

  await w.press('x:ru');
  assert.match(w.calls('editMessageText').at(-1).text, /GitHub Actions/);
});

test('Run workflow: кнопка → подтверждение (ничего не запущено) → «Запустить» → workflow_dispatch; повтор не дублирует', async () => {
  const w = await createWorld();
  await withRepo(w);
  await w.say('/runs');
  await w.press('x:w:0');
  const ask = w.last(OWNER);
  assert.match(ask.text, /Запустить <b>Deploy<\/b>/);
  assert.match(ask.text, /с секретами репозитория/);
  assert.equal(w.gh.dispatches.length, 0, 'до подтверждения ничего не запущено');

  await w.press('x:go');
  assert.deepEqual(w.gh.dispatches, [{ repo: 'me/site', workflow: 1, ref: 'main', inputs: undefined }]);
  assert.match(w.last(OWNER).text, /Запущено: <b>Deploy<\/b>/);
  assert.match(w.last(OWNER).text, /Запуск #3/, 'ссылка на свежий запуск подтянулась');

  await w.press('x:go'); // повторный клик по старой кнопке
  assert.equal(w.gh.dispatches.length, 1);
  assert.ok(w.calls('answerCallbackQuery').at(-1).show_alert);
});

test('/runs файл.yml ветка ключ=значение: ветка и параметры доходят до GitHub; отмена сбрасывает запуск', async () => {
  const w = await createWorld();
  await withRepo(w);
  await w.say('/runs deploy.yml feature/x env=prod');
  assert.match(w.last(OWNER).text, /ветка <code>feature\/x<\/code>/);
  assert.match(w.last(OWNER).text, /env=prod/);
  await w.press('x:go');
  assert.deepEqual(w.gh.dispatches[0], { repo: 'me/site', workflow: 1, ref: 'feature/x', inputs: { env: 'prod' } });

  await w.say('/runs deploy');
  await w.press('x:wx');
  await w.press('x:go');
  assert.equal(w.gh.dispatches.length, 1, 'после отмены запуска нет');

  await w.say('/runs ci.yml');
  assert.match(w.last(OWNER).text, /нет триггера <code>workflow_dispatch<\/code>/);
  await w.say('/runs unknown');
  assert.match(w.last(OWNER).text, /Не нашёл workflow/);
  assert.equal(w.gh.dispatches.length, 1);
});

test('Actions: репозиторий бота запрещён даже если попал в настройки; нет прав → понятная подсказка; 422 → причина', async () => {
  let w = await createWorld();
  w.gh.repos['grunvald91/my_ai_assistent'] = actionsRepo(w);
  await w.store.setSetting('gh_repo', 'grunvald91/my_ai_assistent');
  await w.say('/runs');
  assert.match(w.last(OWNER).text, /самого бота трогать нельзя/);
  await w.say('/runs deploy.yml');
  assert.equal(w.gh.dispatches.length, 0);

  w = await createWorld();
  await withRepo(w, { actionsDenied: true });
  await w.say('/runs');
  assert.match(w.last(OWNER).text, /нет права на GitHub Actions/);
  assert.match(w.last(OWNER).text, /Actions<\/b> — Read and write/);

  w = await createWorld();
  await withRepo(w, { dispatchFails: "Required input 'env' not provided" });
  await w.say('/runs deploy.yml');
  await w.press('x:go');
  assert.match(w.last(OWNER).text, /GitHub не принял запуск.*Required input/s);
});

test('Actions: подмена репозитория между подтверждением и запуском не обходит запрет на репозиторий бота', async () => {
  const w = await createWorld();
  await withRepo(w);
  w.gh.repos['grunvald91/my_ai_assistent'] = actionsRepo(w);
  await w.store.setSetting('gh_run_pending', JSON.stringify({ repo: 'GRUNVALD91/My_AI_Assistent', id: 1, name: 'Deploy', path: 'x.yml', ref: 'main', inputs: {} }));
  await w.press('x:go');
  assert.equal(w.gh.dispatches.length, 0);
  assert.match(w.last(OWNER).text, /самого бота трогать нельзя/);
});

test('«Что упало»: упавшие задачи и шаги; «Перезапустить упавшие» вызывает rerun-failed-jobs', async () => {
  const w = await createWorld();
  await withRepo(w);
  await w.press('x:j:501');
  const m = w.last(OWNER);
  assert.match(m.text, /❌ test/);
  assert.match(m.text, /упал шаг: <code>npm test<\/code>/);
  assert.doesNotMatch(m.text, /checkout/);
  await w.press(m.reply_markup.inline_keyboard[0][0].callback_data);
  assert.deepEqual(w.gh.reruns, [{ repo: 'me/site', run: 501 }]);
  assert.match(w.last(OWNER).text, /запущены заново/);
});

test('GitHub: разовый сетевой сбой чтения повторяется; запись не повторяется; в сообщении видна причина', async () => {
  const { createGithub, GithubError } = await import('../tgcloud/lib/github.js');
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw new Error('connection reset');
    return { ok: true, status: 200, json: async () => ({ login: 'me' }) };
  };
  assert.deepEqual(await createGithub({ fetch: flaky, token: 't' }).me(), { login: 'me' });
  assert.equal(n, 2);

  n = 0;
  const down = async () => {
    n++;
    throw new Error('fetch failed: ENOTFOUND');
  };
  await assert.rejects(createGithub({ fetch: down, token: 't' }).dispatch('a/b', 1, 'main'), (e) => e instanceof GithubError && e.kind === 'network' && /ENOTFOUND/.test(e.userMessage));
  assert.equal(n, 1, 'POST не повторяется');
});

// ───────── «посмотри репозиторий и сделай пост» ─────────

const SUSHEF = () => ({
  default_branch: 'main',
  private: true,
  canonical: 'grunvald91/Sushef',
  files: {
    'README.md': '# Сушеф\nБот: техкарты, пошаговое приготовление, исправление блюда.',
    'package.json': '{"name":"sushef"}',
    '.env': 'TOKEN=very-secret',
    'src/index.js': 'const KEY = "sk-hub-abcdefgh12345678";',
    'docs/guide.md': 'Голосовой ввод рецептов.',
  },
});

test('«посмотри репозиторий и сделай пост»: README и главные файлы уходят модели, секреты — нет', async () => {
  const w = await createWorld();
  w.gh.repos['grunvald91/Sushef'] = SUSHEF();
  await w.say('/repo grunvald91/Sushef');
  w.clear();
  w.llmReplies.push('Пост про Сушеф');
  await w.say('Вот этот репозиторий посмотри и по нему сделай пост');

  const sys = w.llmCalls[0].messages[0].content;
  assert.match(sys, /ДАННЫЕ РЕПОЗИТОРИЯ/);
  assert.match(sys, /техкарты, пошаговое приготовление/);
  assert.match(sys, /Голосовой ввод рецептов/);
  assert.doesNotMatch(sys, /very-secret/, '.env не читается');
  assert.doesNotMatch(sys, /sk-hub-abcdefgh/, 'файл с ключом отброшен');
  assert.ok(w.sent(OWNER).some((m) => /Читаю <code>grunvald91\/Sushef<\/code>/.test(m.text)));
  assert.match(w.last(OWNER).text, /Пост про Сушеф/);

  // продолжение разговора: репозиторий остаётся в контексте, пока не /reset
  w.clear();
  await w.say('перепиши покороче');
  assert.match(w.llmCalls[0].messages[0].content, /техкарты/);
  w.advance(86400);
  w.clear();
  await w.say('а теперь про другое');
  assert.match(w.llmCalls[0].messages[0].content, /техкарты/);
  await w.say('/reset');
  w.clear();
  await w.say('новая тема');
  assert.doesNotMatch(w.llmCalls[0].messages[0].content, /ДАННЫЕ РЕПОЗИТОРИЯ/);
});

test('репозиторий называют в сообщении (в любом регистре) — читаем его, а не выбранный', async () => {
  const w = await createWorld();
  w.gh.repos['grunvald91/Sushef'] = SUSHEF();
  w.gh.repos['me/other'] = { default_branch: 'main', files: { 'README.md': 'Другой проект' } };
  await w.say('/repo me/other');
  w.clear();
  await w.say('Grunvald91/sushef . К тебе подключен мой гитхаб');
  assert.match(w.llmCalls[0].messages[0].content, /техкарты/);
  assert.doesNotMatch(w.llmCalls[0].messages[0].content, /Другой проект/);
});

test('чтение репозитория: бота не читаем; нет репозитория — просим указать; обычный разговор про GitHub ничего не читает', async () => {
  const w = await createWorld();
  w.gh.repos['grunvald91/my_ai_assistent'] = { ...SUSHEF(), canonical: undefined };
  await w.say('посмотри репозиторий grunvald91/my_ai_assistent и сделай пост');
  assert.match(w.last(OWNER).text, /самого бота я не читаю/);
  assert.equal(w.llmCalls.length, 0);

  await w.say('посмотри мой репозиторий и сделай пост');
  assert.match(w.last(OWNER).text, /Не вижу, какой репозиторий читать/);
  assert.equal(w.llmCalls.length, 0);

  const before = w.gh.calls.length;
  await w.say('как работает github actions?');
  assert.equal(w.gh.calls.length, before, 'просто разговор про GitHub репозиториев не читает');
  assert.equal(w.llmCalls.length, 1);
});

test('чтение репозитория: ошибка GitHub — понятный текст, модель не отвечает «из головы»', async () => {
  const w = await createWorld();
  await w.say('посмотри репозиторий me/missing и сделай пост');
  assert.match(w.last(OWNER).text, /GitHub не нашёл репозиторий/);
  assert.equal(w.llmCalls.length, 0);
});

test('читаем ВСЮ ветку без урезаний: все файлы целиком, ветка из просьбы, пути всех файлов', async () => {
  const w = await createWorld();
  const files = {};
  for (let i = 0; i < 30; i++) files[`src/mod${i}.js`] = `export const f${i} = () => "функция номер ${i}"; // ${'x'.repeat(5000)}`;
  files['README.md'] = '# Сушеф';
  w.gh.repos['me/sushef'] = { default_branch: 'main', files: { 'README.md': '# Сушеф' }, branchFiles: { dev: files } };
  await w.say('/repo me/sushef');
  w.clear();
  await w.say('изучи репозиторий me/sushef, ветка dev, и сделай пост');
  const sys = w.llmCalls[0].messages[0].content;
  for (let i = 0; i < 30; i++) assert.match(sys, new RegExp(`функция номер ${i}\\b`), 'файл ' + i);
  assert.match(sys, /xxxxxxxxxx/);
  assert.doesNotMatch(sys, /обрезано/);
  assert.match(sys, /ветка dev/);
  assert.ok(w.gh.calls.some((c) => /git\/trees\/dev/.test(c.path)), 'дерево читалось из ветки dev');
});

test('в основной ветке пусто → модель получает список других веток', async () => {
  const w = await createWorld();
  w.gh.repos['me/sushef'] = { default_branch: 'main', files: { 'README.md': '# Сушеф' }, branchFiles: { dev: { 'a.js': 'x' } } };
  await w.say('/repo me/sushef');
  w.clear();
  await w.say('посмотри репозиторий и сделай пост');
  assert.match(w.llmCalls[0].messages[0].content, /Другие ветки репозитория: dev/);
});

test('не влезает в окно модели: ничего не отбрасываем молча — объясняем и предлагаем решение', async () => {
  const w = await createWorld();
  const files = {};
  for (let i = 0; i < 10; i++) files[`big${i}.js`] = 'a'.repeat(100000);
  w.gh.repos['me/huge'] = { default_branch: 'main', files };
  await w.say('/repo me/huge');
  w.clear();
  await w.say('посмотри репозиторий и сделай пост');
  assert.equal(w.llmCalls.length, 0);
  assert.match(w.last(OWNER).text, /окно модели/);
  assert.match(w.last(OWNER).text, /\/model/);
});
