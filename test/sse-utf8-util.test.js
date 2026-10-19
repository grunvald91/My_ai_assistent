import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../tgcloud/lib/sse.js';
import { createUtf8Decoder } from '../tgcloud/lib/utf8.js';
import { estimateTokens } from '../tgcloud/lib/tokens.js';
import {
  parseCommand, dayKey, formatNow, utf8Encode, parseIdList, displayName, truncate, safeJson,
} from '../tgcloud/lib/util.js';

function collect(parts) {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  for (const part of parts) p.push(part);
  p.end();
  return events;
}

test('SSE: события, склеенные и порезанные как угодно', () => {
  const full = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  const expected = ['{"a":1}', '{"b":2}', '[DONE]'];
  assert.deepEqual(collect([full]).map((e) => e.data), expected);
  // побайтовая нарезка
  assert.deepEqual(collect(full.split('')).map((e) => e.data), expected);
  // CRLF, в том числе разрезанный между \r и \n
  const crlf = full.replace(/\n/g, '\r\n');
  assert.deepEqual(collect([crlf]).map((e) => e.data), expected);
  assert.deepEqual(collect(crlf.split('')).map((e) => e.data), expected);
});

test('SSE: event:, комментарии, многострочные data, хвост без пустой строки', () => {
  const ev = collect([': ping\n', 'event: message_start\ndata: {"x":1}\n\n', 'data: a\ndata: b\n\n', 'data: tail']);
  assert.equal(ev[0].event, 'message_start');
  assert.equal(ev[0].data, '{"x":1}');
  assert.equal(ev[1].data, 'a\nb');
  assert.equal(ev[2].data, 'tail');
});

test('UTF-8: сверка со стандартным TextDecoder на случайных разрезах', () => {
  const text = 'Привет, мир! 😀 café — 日本語 ✓ ' + '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'.repeat(3);
  const bytes = new TextEncoder().encode(text);
  for (let trial = 0; trial < 200; trial++) {
    const dec = createUtf8Decoder();
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const step = 1 + Math.floor(Math.random() * 5);
      out += dec.decode(bytes.subarray(i, i + step));
      i += step;
    }
    out += dec.flush();
    assert.equal(out, text);
  }
});

test('UTF-8: битые байты заменяются, а не ломают поток', () => {
  const dec = createUtf8Decoder();
  const s = dec.decode(new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x82])) + dec.flush();
  assert.equal(s, 'a�b�');
});

test('utf8Encode совпадает с TextEncoder', () => {
  for (const s of ['', 'abc', 'Привет', '😀 mix ✓ 日本', '\ud83d']) {
    if (s === '\ud83d') continue; // одиночный суррогат — у TextEncoder U+FFFD, нам не важно
    assert.deepEqual([...utf8Encode(s)], [...new TextEncoder().encode(s)]);
  }
});

test('parseCommand: аргументы, @бот, чужие команды', () => {
  assert.deepEqual(parseCommand('/model', 'my_bot'), { cmd: 'model', arg: '' });
  assert.deepEqual(parseCommand('/Remember@My_Bot  купить молоко ', 'my_bot'), { cmd: 'remember', arg: 'купить молоко' });
  assert.deepEqual(parseCommand('/group@other_bot all', 'my_bot'), { foreign: true });
  assert.equal(parseCommand('привет', 'my_bot'), null);
  assert.equal(parseCommand('/ not a command', 'my_bot'), null);
  assert.deepEqual(parseCommand('/post первая строка\nвторая', 'b'), { cmd: 'post', arg: 'первая строка\nвторая' });
});

test('dayKey и formatNow учитывают часовой пояс', () => {
  const t = Date.UTC(2026, 9, 19, 22, 30) / 1000; // 19 окт 2026 22:30 UTC
  assert.equal(dayKey(t, 3), '2026-10-20'); // в Москве уже 20-е, 01:30
  assert.equal(dayKey(t, 0), '2026-10-19');
  assert.equal(formatNow(t, 3), 'вторник, 20 октября 2026, 01:30 (UTC+3)');
});

test('estimateTokens: русский «дороже» английского, пустое = 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('Привет, как дела?') > estimateTokens('Hello, how are you?'));
});

test('мелочи: parseIdList, displayName, truncate, safeJson', () => {
  assert.deepEqual(parseIdList('123, 456;-789 abc'), [123, 456, -789]);
  assert.deepEqual(parseIdList(''), []);
  assert.equal(displayName({ first_name: 'Артур', last_name: 'И' }), 'Артур И');
  assert.equal(displayName({ username: 'x' }), '@x');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(safeJson('{bad', 'fb'), 'fb');
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
});
