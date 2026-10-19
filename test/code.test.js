import test from 'node:test';
import { createWorld, assert, OWNER } from './helpers/world.js';
import { parseChanges, parseSelection, safePath, findSecrets, slug, listCandidates } from '../tgcloud/lib/codeparse.js';
import { base64Encode, utf8Encode } from '../tgcloud/lib/util.js';

// ───────── чистые функции ─────────

test('codeparse: разбор ответа модели с файлами, удалением и пояснением', () => {
  const r = parseChanges(
    [
      '@@@ COMMIT: Add greeting',
      '@@@ SUMMARY: Добавил приветствие.',
      'Проверь запуск.',
      '@@@ FILE create src/hello.js',
      'export const hello = () => "привет";',
      '@@@ END',
      '@@@ FILE update README.md',
      '```md',
      '# Проект',
      '```',
      '@@@ END',
      '@@@ DELETE old.txt',
    ].join('\n'),
  );
  assert.equal(r.commit, 'Add greeting');
  assert.equal(r.summary, 'Добавил приветствие.\nПроверь запуск.');
  assert.deepEqual(r.files.map((f) => [f.action, f.path]), [['create', 'src/hello.js'], ['update', 'README.md']]);
  assert.equal(r.files[0].content, 'export const hello = () => "привет";\n');
  assert.equal(r.files[1].content, '# Проект\n', 'обрамление тройными кавычками снято');
  assert.deepEqual(r.deletes, ['old.txt']);
  assert.equal(r.truncated, false);
  assert.equal(parseChanges('@@@ FILE create a.js\nконтент без конца').truncated, true);
});

test('codeparse: выбор файлов, пути, секреты, slug, base64', () => {
  const files = [{ path: 'a.js', size: 10 }, { path: 'big.js', size: 90000 }, { path: 'src/b.js', size: 20 }];
  assert.deepEqual(parseSelection('- `a.js`\nнет.js\nbig.js\n2) src/b.js', files), ['a.js', 'src/b.js']);
  assert.deepEqual(parseSelection('NONE', files), []);
  assert.deepEqual(listCandidates([{ path: 'node_modules/x/y.js', size: 1 }, { path: 'logo.png', size: 1 }, { path: 'a.js', size: 1 }]).map((f) => f.path), ['a.js']);
  for (const bad of ['../x', '/etc/passwd', 'a/../b', '.git/config', 'a//b', 'a\\b', '']) assert.equal(safePath(bad), false, bad);
  for (const ok of ['a.js', 'src/lib/x.ts', '.github/workflows/ci.yml']) assert.equal(safePath(ok), true, ok);
  assert.deepEqual(findSecrets('KEY=sk-hub-abcdefgh12345678'), ['ключ ClaudeHub (sk-hub-…)']);
  assert.ok(findSecrets('ghp_' + 'a'.repeat(30)).length);
  assert.ok(findSecrets('123456789:' + 'A'.repeat(35)).length);
  assert.ok(findSecrets('-----BEGIN PRIVATE KEY-----').length);
  assert.deepEqual(findSecrets('const x = process.env.KEY;'), []);
  assert.equal(slug('Добавить форму входа!'), 'dobavit-formu-vhoda');
  assert.equal(slug('???'), 'change');
  assert.equal(base64Encode(utf8Encode('Привет, мир')), Buffer.from('Привет, мир').toString('base64'));
  assert.equal(base64Encode(utf8Encode('a')), 'YQ==');
  assert.equal(base64Encode(utf8Encode('ab')), 'YWI=');
});

// ───────── сценарии ─────────

const SITE = () => ({ default_branch: 'main', private: true, files: { 'index.html': '<h1>Привет</h1>', 'README.md': '# Site', 'package.json': '{}' } });
const CHANGES = [
  '@@@ COMMIT: Add contact form',
  '@@@ SUMMARY: Добавил форму обратной связи.',
  '@@@ FILE update index.html',
  '<h1>Привет</h1><form></form>',
  '@@@ END',
  '@@@ FILE create contact.js',
  'export const send = () => {};',
  '@@@ END',
].join('\n');

async function ready(w, repos = { 'me/site': SITE() }) {
  Object.assign(w.gh.repos, repos);
  await w.say('/repo me/site');
}

test('без GH_PAT: /gh и /code объясняют, как подключить', async () => {
  const w = await createWorld({ github: false });
  await w.say('/gh');
  assert.match(w.last(OWNER).text, /GH_PAT/);
  await w.say('/code сделай что-нибудь');
  assert.match(w.last(OWNER).text, /GH_PAT/);
  assert.equal(w.llmCalls.length, 0);
});

test('/repo: репозиторий бота запрещён в любом написании и по ссылке; чужой выбирается', async () => {
  const w = await createWorld();
  w.gh.repos['grunvald91/My_ai_assistent'] = { ...SITE(), canonical: 'grunvald91/My_ai_assistent' };
  w.gh.repos['me/site'] = SITE();
  for (const name of ['grunvald91/my_ai_assistent', 'GRUNVALD91/MY_AI_ASSISTENT', 'https://github.com/grunvald91/My_ai_assistent.git']) {
    await w.say('/repo ' + name);
    assert.match(w.last(OWNER).text, /самого бота трогать нельзя/, name);
  }
  assert.equal(await w.store.getSetting('gh_repo'), null);
  await w.say('/repo site'); // без владельца — берётся логин токена
  assert.match(w.last(OWNER).text, /me\/site/);
  assert.equal(await w.store.getSetting('gh_repo'), 'me/site');
});

test('/gh: список репозиториев без репозитория бота, выбор кнопкой', async () => {
  const w = await createWorld();
  w.gh.repos['me/site'] = SITE();
  w.gh.repos['me/shop'] = SITE();
  w.gh.repos['grunvald91/My_ai_assistent'] = SITE();
  await w.say('/gh');
  const btns = w.last(OWNER).reply_markup.inline_keyboard.flat();
  assert.deepEqual(btns.map((b) => b.text), ['me/site', 'me/shop']);
  await w.press(btns[1].callback_data);
  assert.equal(await w.store.getSetting('gh_repo'), 'me/shop');
});

test('/code → предпросмотр без записи → «Ветка + PR»: blob, дерево, коммит, ветка, PR; повторный клик не дублирует', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html\nREADME.md', CHANGES);
  await w.say('/code добавь форму обратной связи');

  // модель получила содержимое прочитанного файла
  const user = w.llmCalls[1].messages.at(-1).content;
  assert.match(user, /СОДЕРЖИМОЕ index\.html/);
  assert.match(user, /<h1>Привет<\/h1>/);
  assert.match(w.llmCalls[1].messages[0].content, /me\/site/);
  assert.equal(w.llmCalls[1].max_tokens, 128000, "лимит ответа = максимум модели из каталога");

  const card = w.last(OWNER);
  assert.match(card.text, /Add contact form/);
  assert.match(card.text, /✏️ <code>index\.html<\/code>/);
  assert.match(card.text, /➕ <code>contact\.js<\/code>/);
  assert.match(card.text, /Ничего не отправлено/);
  const writes = () => w.gh.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes().length, 0, 'до подтверждения ничего не пишем');

  const pr = card.reply_markup.inline_keyboard[0][0];
  assert.match(pr.text, /Pull Request/);
  await w.press(pr.callback_data);
  await w.press(pr.callback_data);

  assert.equal(w.gh.commits.length, 1);
  assert.equal(w.gh.commits[0].message, 'Add contact form');
  assert.deepEqual(w.gh.commits[0].parents, ['base-sha']);
  const tree = w.gh.calls.find((c) => c.path.endsWith('/git/trees') && c.method === 'POST').body;
  assert.equal(tree.base_tree, 'base-tree');
  assert.deepEqual(tree.tree.map((t) => t.path).sort(), ['contact.js', 'index.html']);
  assert.equal(w.gh.refs.length, 1);
  assert.match(w.gh.refs[0].ref, /^refs\/heads\/claude\/add-contact-form-/);
  assert.equal(w.gh.prs.length, 1);
  assert.equal(w.gh.prs[0].base, 'main');
  assert.equal(w.gh.prs[0].head, w.gh.refs[0].ref.replace('refs/heads/', ''));
  assert.match(w.last(OWNER).text, /https:\/\/github\.com\/me\/site\/pull\/1/);
});

test('/code → «Сразу в main»: обновляет основную ветку без PR; удаление файла уходит sha:null', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('NONE'.replace('NONE', 'README.md'), CHANGES + '\n@@@ DELETE package.json');
  await w.say('/code добавь форму и убери package.json');
  const card = w.last(OWNER);
  assert.match(card.text, /🗑 <code>package\.json<\/code>/);
  await w.press(card.reply_markup.inline_keyboard[1][0].callback_data);
  assert.equal(w.gh.prs.length, 0);
  assert.equal(w.gh.refs.length, 1);
  assert.deepEqual([w.gh.refs[0].kind, w.gh.refs[0].ref], ['update', 'refs/heads/main']);
  const tree = w.gh.calls.find((c) => c.path.endsWith('/git/trees') && c.method === 'POST').body.tree;
  assert.deepEqual(tree.find((t) => t.path === 'package.json'), { path: 'package.json', mode: '100644', type: 'blob', sha: null });
});

test('/code без описания спрашивает задачу следующим сообщением', async () => {
  const w = await createWorld();
  await ready(w);
  await w.say('/code');
  assert.match(w.last(OWNER).text, /Опиши задачу/);
  w.llmReplies.push('index.html', CHANGES);
  await w.say('добавь форму');
  assert.match(w.last(OWNER).text, /Ничего не отправлено/);
});

test('секреты в сгенерированном коде блокируют коммит', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', '@@@ COMMIT: x\n@@@ SUMMARY: y\n@@@ FILE create config.js\nexport const KEY = "sk-hub-abcdefgh12345678";\n@@@ END');
  await w.say('/code добавь конфиг');
  assert.match(w.last(OWNER).text, /нашлись секреты/);
  assert.equal(w.gh.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('небезопасные пути и удаление несуществующего отбрасываются, workflow — предупреждение', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', [
    '@@@ COMMIT: x', '@@@ SUMMARY: y',
    '@@@ FILE create ../evil.js', 'x', '@@@ END',
    '@@@ FILE create .github/workflows/ci.yml', 'name: ci', '@@@ END',
    '@@@ DELETE nope.txt',
  ].join('\n'));
  await w.say('/code ci');
  const card = w.last(OWNER);
  assert.doesNotMatch(card.text, /<code>\.\.\/evil/, 'небезопасный файл в список изменений не попал');
  assert.match(card.text, /небезопасный путь/);
  assert.match(card.text, /нет такого файла/);
  assert.match(card.text, /workflow/);
});

test('оборванный ответ модели: последний файл отброшен, пользователь предупреждён', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', '@@@ COMMIT: x\n@@@ SUMMARY: y\n@@@ FILE create a.js\nok\n@@@ END\n@@@ FILE create b.js\nобрыв');
  await w.say('/code два файла');
  const card = w.last(OWNER);
  assert.match(card.text, /a\.js/);
  assert.doesNotMatch(card.text, /<code>b\.js/);
  assert.match(card.text, /оборвался/);
});

test('нет изменений: показывает пояснение модели, ничего не создаёт', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('NONE', '@@@ SUMMARY: Задача неясна: какой именно сайт?');
  await w.say('/code сделай хорошо');
  assert.match(w.last(OWNER).text, /Задача неясна/);
  assert.equal((await w.store.recentJournal(10)).filter((j) => j.type === 'code_draft').length, 0);
});

test('пустой репозиторий: файлы создаются через Contents API (base64) в основную ветку', async () => {
  const w = await createWorld();
  await ready(w, { 'me/site': { default_branch: 'main', empty: true, files: {} } });
  w.llmReplies.push('@@@ COMMIT: Init\n@@@ SUMMARY: Каркас.\n@@@ FILE create index.html\n<h1>Привет, мир</h1>\n@@@ END');
  await w.say('/code каркас сайта');
  assert.equal(w.llmCalls.length, 1, 'читать нечего — шаг выбора файлов пропущен');
  const card = w.last(OWNER);
  assert.equal(card.reply_markup.inline_keyboard[0].length, 1);
  assert.match(card.reply_markup.inline_keyboard[0][0].text, /Закоммитить в main/);
  await w.press(card.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(w.gh.putFiles.length, 1);
  assert.equal(w.gh.putFiles[0].content, '<h1>Привет, мир</h1>\n');
  assert.match(w.last(OWNER).text, /Закоммичено/);
});

test('защита на этапе применения: репозиторий переименовали в репозиторий бота', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', CHANGES);
  await w.say('/code форма');
  const card = w.last(OWNER);
  w.gh.repos['me/site'].canonical = 'grunvald91/My_ai_assistent'; // GitHub теперь отдаёт каноническое имя бота
  await w.press(card.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(w.gh.commits.length, 0);
  assert.match(w.last(OWNER).text, /отказал в доступе/);
});

test('ошибка GitHub при записи: изменения сохраняются, можно повторить кнопкой', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', CHANGES);
  await w.say('/code форма');
  const card = w.last(OWNER);
  w.gh.repos['me/site'].prFails = true;
  await w.press(card.reply_markup.inline_keyboard[0][0].callback_data);
  assert.match(w.last(OWNER).text, /PR открыть не получилось/, 'ветка создана, PR нет — сообщаем это');
  assert.equal(w.gh.refs.length, 1);
});

test('«Показать код» присылает файлы документами, «Отмена» блокирует запись', async () => {
  const w = await createWorld();
  await ready(w);
  w.llmReplies.push('index.html', CHANGES);
  await w.say('/code форма');
  const rows = w.last(OWNER).reply_markup.inline_keyboard;
  await w.press(rows[2][0].callback_data);
  const docs = w.calls('sendDocument');
  assert.deepEqual(docs.map((d) => d.document.name).sort(), ['contact.js', 'index.html']);
  await w.press(rows[2][1].callback_data);
  await w.press(rows[0][0].callback_data);
  assert.equal(w.gh.commits.length, 0);
});
