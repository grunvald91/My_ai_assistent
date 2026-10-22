import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { inflateRaw } from '../tgcloud/lib/inflate.js';
import { classify, docxText, xlsxText, pptxText, unzip } from '../tgcloud/lib/files.js';

// ── мини-архиватор zip для тестов (настоящий deflate из Node)
function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}
function makeZip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = store ? data : deflateRawSync(data);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

test('inflate: совпадает с zlib на тексте, повторах и случайных данных', () => {
  const samples = [
    Buffer.from('Привет, мир! '.repeat(500)),
    Buffer.from('a'.repeat(100000)),
    randomBytes(70000),
    Buffer.from(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'товар ' + i, price: i * 1.5 })))),
    Buffer.alloc(0),
  ];
  for (const s of samples) {
    const packed = deflateRawSync(s);
    assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(packed), s.length)), s);
  }
});

test('unzip: deflate и stored', () => {
  for (const store of [false, true]) {
    const z = unzip(makeZip({ 'a.txt': 'один', 'dir/b.txt': 'два '.repeat(100) }, { store }));
    assert.deepEqual(z.names, ['a.txt', 'dir/b.txt']);
    assert.equal(Buffer.from(z.read('a.txt')).toString(), 'один');
    assert.equal(Buffer.from(z.read('dir/b.txt')).toString(), 'два '.repeat(100));
  }
  assert.throws(() => unzip(new Uint8Array([1, 2, 3])), /не zip/);
});

test('docx: абзацы, таблица, спецсимволы', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Договор №5 &amp; приложения</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Строка </w:t></w:r><w:r><w:t>склеена</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Товар</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const t = docxText(makeZip({ 'word/document.xml': xml }));
  assert.match(t, /Договор №5 & приложения/);
  assert.match(t, /Строка склеена/);
  assert.match(t, /Товар\s+\|\s+Цена/);
});

test('xlsx: общие строки, числа, пропуски, несколько листов', () => {
  const ss = '<sst><si><t>Товар</t></si><si><t>Цена</t></si><si><t>Лосось</t></si></sst>';
  const wb = '<workbook><sheets><sheet name="Прайс" sheetId="1"/><sheet name="Второй" sheetId="2"/></sheets></workbook>';
  const s1 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1200.5</v></c></row></sheetData></worksheet>';
  const s2 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>внутри</t></is></c></row></sheetData></worksheet>';
  const t = xlsxText(makeZip({ 'xl/sharedStrings.xml': ss, 'xl/workbook.xml': wb, 'xl/worksheets/sheet1.xml': s1, 'xl/worksheets/sheet2.xml': s2 }));
  assert.match(t, /── Лист «Прайс» ──\nТовар\t\tЦена\nЛосось\t\t1200\.5/);
  assert.match(t, /── Лист «Второй» ──\nвнутри/);
});

test('pptx: слайды по порядку', () => {
  const sl = (txt) => `<p:sld><a:p><a:r><a:t>${txt}</a:t></a:r></a:p></p:sld>`;
  const t = pptxText(makeZip({ 'ppt/slides/slide10.xml': sl('Десятый'), 'ppt/slides/slide2.xml': sl('Второй'), 'ppt/slides/slide1.xml': sl('Первый') }));
  assert.ok(t.indexOf('Первый') < t.indexOf('Второй') && t.indexOf('Второй') < t.indexOf('Десятый'));
});

test('classify: типы вложений', () => {
  assert.equal(classify('a.PNG').kind, 'image');
  assert.equal(classify('x.pdf').kind, 'pdf');
  assert.equal(classify('прайс.xlsx').kind, 'xlsx');
  assert.equal(classify('main.py').kind, 'text');
  assert.equal(classify('data.csv', 'text/csv').kind, 'text');
  assert.equal(classify('old.doc').kind, 'unsupported');
  assert.equal(classify('noext').kind, 'unknown');
});
