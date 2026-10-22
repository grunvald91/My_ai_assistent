// files.js — что бот понимает во вложениях: тип файла, текст из txt/csv/кода, docx, xlsx, pptx (zip + XML).
// PDF и картинки модель читает сама (см. attach.js). Чистый модуль: без sdk и Node API (в изоляте нет Buffer и zlib).

import { inflateRaw } from './inflate.js';

const dec = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
export const utf8Decode = (u8) => (dec ? dec.decode(u8) : String.fromCharCode(...u8));

const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl xml html htm yaml yml toml ini cfg conf log js mjs cjs ts tsx jsx py go rs java kt kts c cc cpp h hpp cs php rb sh bash zsh sql css scss less vue svelte srt vtt tex rst ipynb gradle properties dockerfile makefile bat ps1 lua swift dart r scala'.split(' '),
);
const UNSUPPORTED = {
  doc: 'старый формат Word (.doc): сохрани как .docx или PDF',
  xls: 'старый формат Excel (.xls): сохрани как .xlsx или .csv',
  ppt: 'старый формат PowerPoint (.ppt): сохрани как .pptx или PDF',
  zip: 'архив: распакуй и пришли нужные файлы',
  rar: 'архив: распакуй и пришли нужные файлы',
  '7z': 'архив: распакуй и пришли нужные файлы',
  heic: 'формат HEIC: пришли как обычное фото или JPEG/PNG',
  mp3: 'аудио пока не разбираю',
  ogg: 'аудио пока не разбираю',
  wav: 'аудио пока не разбираю',
  mp4: 'видео пока не разбираю',
  mov: 'видео пока не разбираю',
  avi: 'видео пока не разбираю',
};

export const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
};

/** Тип вложения по имени и MIME: image | pdf | docx | xlsx | pptx | text | unknown | unsupported. */
export function classify(name, mime = '') {
  const ext = extOf(name);
  const base = String(name ?? '').toLowerCase();
  if (IMAGE_EXT[ext]) return { kind: 'image', mime: IMAGE_EXT[ext] };
  if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return { kind: 'image', mime };
  if (ext === 'pdf' || mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (ext === 'docx') return { kind: 'docx' };
  if (ext === 'xlsx' || ext === 'xlsm') return { kind: 'xlsx' };
  if (ext === 'pptx') return { kind: 'pptx' };
  if (UNSUPPORTED[ext]) return { kind: 'unsupported', why: UNSUPPORTED[ext] };
  if (TEXT_EXT.has(ext) || base === 'dockerfile' || base === 'makefile' || /^text\//.test(mime) || /json|xml|javascript|yaml/.test(mime)) return { kind: 'text' };
  return { kind: 'unknown' };
}

/** «Похоже на текст»: нет нулевых байтов в первых 4 КБ. */
export function looksLikeText(u8) {
  const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (u8[i] === 0) return false;
  return true;
}

// ───────────── zip ─────────────

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Читает zip: возвращает { names, read(name) → Uint8Array }. Только deflate и stored (этого хватает для Office). */
export function unzip(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('это не zip-файл (или он повреждён)');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error('повреждённый zip');
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28);
    const elen = u16(bytes, p + 30);
    const clen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = utf8Decode(bytes.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, usize, local });
    p += 46 + nlen + elen + clen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + u16(bytes, e.local + 26) + u16(bytes, e.local + 28);
      const raw = bytes.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRaw(raw, e.usize);
      throw new Error('в zip используется неподдерживаемое сжатие');
    },
  };
}

// ───────────── XML → текст ─────────────

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) =>
  String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e];
  });

const textFile = (zip, name) => {
  const b = zip.read(name);
  return b ? utf8Decode(b) : '';
};
const numKey = (s) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);

/** Word: абзацы, табуляции, таблицы (ячейки через « | »). */
export function docxText(bytes) {
  const zip = unzip(bytes);
  const xml = textFile(zip, 'word/document.xml');
  if (!xml) throw new Error('в файле нет word/document.xml — это не docx');
  const out = xml
    .replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (cell) => cell.replace(/<\/w:p>/g, ' ')) // абзацы внутри ячейки таблицы — в одну строку
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>|<w:cr\s*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, t) => '\u0001' + t + '\u0002')
    .replace(/<[^>]+>/g, '')
    .replace(/\u0001([\s\S]*?)\u0002/g, (_, t) => unxml(t));
  return out.replace(/ \| \n/g, ' |\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** PowerPoint: текст каждого слайда. */
export function pptxText(bytes) {
  const zip = unzip(bytes);
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => numKey(a) - numKey(b));
  if (!slides.length) throw new Error('в файле нет слайдов — это не pptx');
  return slides
    .map((n, i) => {
      const xml = textFile(zip, n)
        .replace(/<\/a:p>/g, '\n')
        .replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (_, t) => '\u0001' + t + '\u0002')
        .replace(/<[^>]+>/g, '')
        .replace(/\u0001([\s\S]*?)\u0002/g, (_, t) => unxml(t));
      return `── Слайд ${i + 1} ──\n${xml.replace(/\n{2,}/g, '\n').trim()}`;
    })
    .join('\n\n');
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** Excel: каждый лист — строки через табуляцию (значения формул — последние вычисленные). */
export function xlsxText(bytes) {
  const zip = unzip(bytes);
  const shared = [];
  const ss = textFile(zip, 'xl/sharedStrings.xml');
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let t = '';
    for (const x of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += x[1];
    shared.push(unxml(t));
  }
  const wb = textFile(zip, 'xl/workbook.xml');
  const sheetNames = [...wb.matchAll(/<sheet\s[^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => numKey(a) - numKey(b));
  if (!sheets.length) throw new Error('в файле нет листов — это не xlsx');
  return sheets
    .map((n, i) => {
      const xml = textFile(zip, n);
      const rows = [];
      for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? '';
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
          const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? '';
          let val = '';
          if (type === 'inlineStr') val = unxml([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
          else {
            const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
            val = type === 's' ? shared[Number(v)] ?? '' : unxml(v);
          }
          const idx = ref ? colIndex(ref) : cells.length;
          while (cells.length < idx) cells.push('');
          cells[idx] = val.replace(/[\t\r\n]+/g, ' ');
        }
        if (cells.some((v) => v !== '')) rows.push(cells.join('\t'));
      }
      return `── Лист «${sheetNames[i] ?? 'Лист ' + (i + 1)}» ──\n${rows.join('\n')}`;
    })
    .join('\n\n');
}
