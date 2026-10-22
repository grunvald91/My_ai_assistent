// probe-media.mjs — разовая проверка: какие форматы картинок и файлов принимает ClaudeHub (для vision и файлов в боте).
import { deflateSync } from 'node:zlib';
import { API_BASE } from '../tgcloud/lib/config.js';

const KEY = (process.env.CLAUDEHUB_API_KEY ?? '').trim();

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function redPng(w = 32, h = 32) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 10 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

async function call(path, body, headers) {
  const t0 = Date.now();
  try {
    const r = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const t = await r.text();
    let ans = t.slice(0, 160).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(t);
      ans = (j.choices?.[0]?.message?.content ?? j.content?.map((b) => b.text).join('') ?? j.error?.message ?? ans).toString().slice(0, 140);
    } catch {}
    return `${r.status} ${Date.now() - t0}мс «${ans}»`;
  } catch (e) {
    return 'ошибка сети ' + e.message;
  }
}

const png = redPng().toString('base64');
const pdf = tinyPdf('Probe code 4242').toString('base64');
const auth = { Authorization: 'Bearer ' + KEY };
const anth = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };

const models = await (await fetch(API_BASE + '/v1/models')).json();
const vis = (models.data ?? []).filter((m) => m.supports_vision).map((m) => m.id);
console.log('Модели с supports_vision:', vis.join(', ') || 'нет');
console.log('Модели без supports_vision (чат):', (models.data ?? []).filter((m) => !m.supports_vision && !/image|embed|veo|tts|banana/i.test(m.id)).map((m) => m.id).join(', '));

for (const model of ['claude-sonnet-5-5', 'gpt-6.1-sol', 'grok-4.7', 'gemini-flash-3.8']) {
  console.log(`\n== ${model}`);
  console.log('chat/completions image_url:', await call('/v1/chat/completions', { model, max_tokens: 30, messages: [{ role: 'user', content: [{ type: 'text', text: 'Какого цвета картинка? Ответь одним словом.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }] }, auth));
}
for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
  console.log(`\n== ${model} (формат Anthropic)`);
  console.log('messages image:', await call('/v1/messages', { model, max_tokens: 30, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'Какого цвета картинка? Одним словом.' }] }] }, anth));
  console.log('messages document(PDF):', await call('/v1/messages', { model, max_tokens: 40, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }, { type: 'text', text: 'Какой код написан в документе? Только число.' }] }] }, anth));
}
console.log('\n== PDF через chat/completions (file) для gpt-6.1-sol');
console.log(await call('/v1/chat/completions', { model: 'gpt-6.1-sol', max_tokens: 40, messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,' + pdf } }, { type: 'text', text: 'Какой код написан в документе? Только число.' }] }] }, auth));
