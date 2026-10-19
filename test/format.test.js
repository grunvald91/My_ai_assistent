import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml, splitText, renderChunks, entitiesToHtml } from '../tgcloud/lib/format.js';

test('mdToHtml: жирный, курсив, код, ссылки', () => {
  assert.equal(mdToHtml('**важно** и *курсив* и `код`'), '<b>важно</b> и <i>курсив</i> и <code>код</code>');
  assert.equal(mdToHtml('[сайт](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2">сайт</a>');
  assert.equal(mdToHtml('~~старое~~'), '<s>старое</s>');
  assert.equal(mdToHtml('***всё сразу***'), '<b><i>всё сразу</i></b>');
});

test('mdToHtml: экранирует HTML и опасные ссылки', () => {
  assert.equal(mdToHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(mdToHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // javascript: не превращается в ссылку
  assert.ok(!mdToHtml('[x](javascript:alert(1))').includes('<a '));
});

test('mdToHtml: snake_case и умножение не превращаются в курсив', () => {
  assert.equal(mdToHtml('my_var_name и 2*3*4'), 'my_var_name и 2*3*4');
  assert.equal(mdToHtml('_курсив_ рядом'), '<i>курсив</i> рядом');
});

test('mdToHtml: заголовки, списки, цитаты, разделитель', () => {
  assert.equal(mdToHtml('# Заголовок'), '<b>Заголовок</b>');
  assert.equal(mdToHtml('- один\n- два\n  - вложенный'), '• один\n• два\n  • вложенный');
  assert.equal(mdToHtml('1. первый\n2. второй'), '1. первый\n2. второй');
  assert.equal(mdToHtml('> цитата\n> вторая'), '<blockquote>цитата\nвторая</blockquote>');
  assert.equal(mdToHtml('до\n\n---\n\nпосле'), 'до\n\nпосле');
});

test('mdToHtml: блок кода не форматируется внутри', () => {
  const h = mdToHtml('```js\nconst a = "<b>*x*</b>";\n```');
  assert.equal(h, '<pre><code class="language-js">const a = "&lt;b&gt;*x*&lt;/b&gt;";</code></pre>');
  assert.equal(mdToHtml('```\nplain\n```'), '<pre>plain</pre>');
  // незакрытый блок кода не ломает разметку
  assert.equal(mdToHtml('```\nbroken'), '<pre>broken</pre>');
});

test('mdToHtml: таблица превращается в моноширинный блок', () => {
  const h = mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(h, '<pre>| a | b |\n| 1 | 2 |</pre>');
});

test('mdToHtml: код внутри ссылки и жирный внутри ссылки', () => {
  assert.equal(mdToHtml('[**до** `x`](https://a.b)'), '<a href="https://a.b"><b>до</b> <code>x</code></a>');
});

test('splitText: короткий текст — один кусок, пустой — ноль', () => {
  assert.deepEqual(splitText('привет', 100), ['привет']);
  assert.deepEqual(splitText('   \n ', 100), []);
});

test('splitText: режет по абзацам и не превышает лимит', () => {
  const para = 'слово '.repeat(40).trim(); // ~240 символов
  const text = [para, para, para, para, para].join('\n\n');
  const parts = splitText(text, 600);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 600, 'длина ' + p.length);
  // ничего не потеряно
  assert.equal(parts.join('\n\n').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('splitText: блок кода, разорванный границей, закрывается и открывается заново', () => {
  const code = Array.from({ length: 60 }, (_, i) => 'line ' + i).join('\n');
  const text = 'вступление\n\n```py\n' + code + '\n```\n\nконец';
  const parts = splitText(text, 200);
  assert.ok(parts.length > 2);
  for (const p of parts) {
    assert.ok(p.length <= 200);
    const fences = (p.match(/^\s*```/gm) || []).length;
    assert.equal(fences % 2, 0, 'незакрытый блок кода в куске:\n' + p);
  }
  assert.ok(parts[1].startsWith('```py'));
});

test('splitText: очень длинная строка без переносов режется жёстко', () => {
  const parts = splitText('x'.repeat(10000), 3500);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 3500);
});

test('renderChunks: каждый кусок ≤ 4096 после конвертации', () => {
  const text = Array.from({ length: 400 }, (_, i) => `**пункт ${i}** с <тегом> & знаком`).join('\n');
  const chunks = renderChunks(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.html.length <= 4096);
});

test('entitiesToHtml: вложенные и пересекающиеся сущности', () => {
  assert.equal(
    entitiesToHtml('Привет мир', [{ type: 'bold', offset: 0, length: 6 }]),
    '<b>Привет</b> мир',
  );
  assert.equal(
    entitiesToHtml('abcdef', [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 2, length: 4 },
    ]),
    '<b>ab<i>cd</i></b><i>ef</i>',
  );
  assert.equal(
    entitiesToHtml('ссылка', [{ type: 'text_link', offset: 0, length: 6, url: 'https://a.b/?x=1&y=2' }]),
    '<a href="https://a.b/?x=1&amp;y=2">ссылка</a>',
  );
  assert.equal(entitiesToHtml('a<b', []), 'a&lt;b');
  assert.equal(
    entitiesToHtml('x = 1', [{ type: 'pre', offset: 0, length: 5, language: 'js' }]),
    '<pre><code class="language-js">x = 1</code></pre>',
  );
});
