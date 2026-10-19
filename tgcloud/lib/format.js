// format.js — превращает ответ модели (Markdown) в безопасный Telegram HTML,
// режет длинные тексты на сообщения, переводит форматирование Telegram (entities) обратно в HTML.
// Чистый модуль: без sdk и без Node-API.

import { escapeHtml, escapeAttr } from './util.js';

// ───────────────────────── Markdown → Telegram HTML ─────────────────────────
// Telegram понимает только <b> <i> <u> <s> <code> <pre> <a> <blockquote> <tg-spoiler>.
// Заголовки → жирный, списки → «•», таблицы → моноширинный блок.

function inline(s) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return '\u0000' + (stash.length - 1) + '\u0000';
  };

  // `код`
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep('<code>' + escapeHtml(c) + '</code>'));
  // [текст](ссылка) — только безопасные схемы
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^\s)]+)\)/g, (_, t, u) =>
    keep('<a href="' + escapeAttr(u) + '">' + emphasis(escapeHtml(t)) + '</a>'),
  );
  s = emphasis(escapeHtml(s));

  // вернуть вынутые куски (ссылка может содержать код — поэтому циклом)
  for (let guard = 0; guard < 5 && s.includes('\u0000'); guard++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] ?? '');
  }
  return s;
}

function emphasis(s) {
  return s
    .replace(/\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([^\n]+?)(?<=\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g, '$1<i>$2</i>');
}

export function mdToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ```блок кода```
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // закрывающий забор (или конец текста)
      const code = escapeHtml(body.join('\n'));
      out.push(lang ? '<pre><code class="language-' + escapeAttr(lang) + '">' + code + '</code></pre>' : '<pre>' + code + '</pre>');
      continue;
    }

    // таблица → моноширинный блок
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i]) || !/-/.test(lines[i])) rows.push(lines[i].trim());
        i++;
      }
      out.push('<pre>' + escapeHtml(rows.join('\n')) + '</pre>');
      continue;
    }

    // > цитата
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(inline(lines[i++].replace(/^\s*>\s?/, '')));
      out.push('<blockquote>' + q.join('\n') + '</blockquote>');
      continue;
    }

    // # заголовок → жирный
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push('<b>' + inline(h[1]) + '</b>');
      i++;
      continue;
    }

    // --- разделитель
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('');
      i++;
      continue;
    }

    // - пункт списка
    const li = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (li) {
      out.push('  '.repeat(Math.min(3, Math.floor(li[1].length / 2))) + '• ' + inline(li[3]));
      i++;
      continue;
    }

    // 1. нумерованный список
    const ol = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (ol) {
      out.push('  '.repeat(Math.min(3, Math.floor(ol[1].length / 2))) + ol[2] + '. ' + inline(ol[3]));
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ───────────────────────── Разбиение длинного текста ─────────────────────────
// Режем по абзацам; блок кода, разорванный границей, закрываем и открываем заново.

export function splitText(text, limit = 3500) {
  const t = String(text ?? '').replace(/\s+$/, '');
  if (!t.trim()) return [];
  if (t.length <= limit) return [t];

  const wrap = Math.max(20, limit - 20);
  const lines = [];
  for (const l of t.split('\n')) {
    if (l.length <= wrap) lines.push(l);
    else for (let p = 0; p < l.length; p += wrap) lines.push(l.slice(p, p + wrap));
  }

  const chunks = [];
  let startFence = null; // язык блока кода, если чанк начинается внутри него
  let i = 0;
  while (i < lines.length) {
    let fence = startFence;
    const reopen = startFence !== null ? '```' + startFence : null;
    const cur = reopen ? [reopen] : [];
    let len = reopen ? reopen.length + 1 : 0;
    const base = cur.length;
    let lastBlank = -1;
    let overflow = false;

    while (i < lines.length) {
      const l = lines[i];
      const closeCost = fence !== null ? 4 : 0;
      if (len + l.length + 1 + closeCost > limit && cur.length > base) {
        overflow = true;
        break;
      }
      cur.push(l);
      len += l.length + 1;
      i++;
      const fm = /^\s*```\s*([\w+#.-]*)\s*$/.exec(l);
      if (fm) fence = fence === null ? fm[1] : null;
      if (l === '' && fence === null) lastBlank = cur.length - 1;
    }

    if (overflow && lastBlank > base) {
      // режем по последнему пустому месту вне кода
      i -= cur.length - 1 - lastBlank;
      cur.length = lastBlank + 1;
      fence = null;
    }
    let body = cur.join('\n').replace(/\s+$/, '');
    if (fence !== null) body += '\n```';
    if (body.trim()) chunks.push(body);
    startFence = fence;
  }
  return chunks;
}

/** Готовые к отправке HTML-куски (каждый ≤ 4096). */
export function renderChunks(md, limit = 3500) {
  const out = [];
  for (const part of splitText(md, limit)) {
    const html = mdToHtml(part);
    if (html.length <= 4096) {
      if (html) out.push({ html, md: part });
    } else if (limit > 500) {
      out.push(...renderChunks(part, Math.floor(limit / 2)));
    } else {
      out.push({ html: escapeHtml(part).slice(0, 4096), md: part });
    }
  }
  return out;
}

// ───────────── Форматирование Telegram (entities) → HTML ─────────────
// Нужно, когда владелец сам присылает текст поста с жирным/курсивом.

const ENTITY_TAGS = {
  bold: ['<b>', '</b>'],
  italic: ['<i>', '</i>'],
  underline: ['<u>', '</u>'],
  strikethrough: ['<s>', '</s>'],
  spoiler: ['<tg-spoiler>', '</tg-spoiler>'],
  code: ['<code>', '</code>'],
  blockquote: ['<blockquote>', '</blockquote>'],
  expandable_blockquote: ['<blockquote expandable>', '</blockquote>'],
};

function openTag(e) {
  if (e.type === 'text_link') return '<a href="' + escapeAttr(e.url ?? '') + '">';
  if (e.type === 'pre') return e.language ? '<pre><code class="language-' + escapeAttr(e.language) + '">' : '<pre>';
  return ENTITY_TAGS[e.type][0];
}
function closeTag(e) {
  if (e.type === 'text_link') return '</a>';
  if (e.type === 'pre') return e.language ? '</code></pre>' : '</pre>';
  return ENTITY_TAGS[e.type][1];
}

export function entitiesToHtml(text, entities) {
  text = String(text ?? '');
  const ents = (entities || [])
    .filter((e) => (ENTITY_TAGS[e.type] || e.type === 'text_link' || e.type === 'pre') && e.length > 0)
    .map((e, idx) => ({ ...e, idx, end: Math.min(text.length, e.offset + e.length) }));
  if (!ents.length) return escapeHtml(text);

  const bounds = new Set([0, text.length]);
  for (const e of ents) {
    bounds.add(Math.max(0, Math.min(text.length, e.offset)));
    bounds.add(e.end);
  }
  const pts = [...bounds].sort((a, b) => a - b);

  let stack = [];
  let out = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const active = ents
      .filter((e) => e.offset <= a && e.end >= b)
      .sort((x, y) => x.offset - y.offset || y.end - x.end || x.idx - y.idx);
    let p = 0;
    while (p < stack.length && p < active.length && stack[p] === active[p]) p++;
    for (let s = stack.length - 1; s >= p; s--) out += closeTag(stack[s]);
    for (let s = p; s < active.length; s++) out += openTag(active[s]);
    stack = active;
    out += escapeHtml(text.slice(a, b));
  }
  for (let s = stack.length - 1; s >= 0; s--) out += closeTag(stack[s]);
  return out;
}
