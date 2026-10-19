// codeparse.js — разбор ответа модели с изменениями кода, фильтры путей и защита от утечки секретов. Чистый модуль.
//
// Формат ответа модели (устойчивее JSON для кода):
//   @@@ COMMIT: сообщение коммита
//   @@@ SUMMARY: пояснение (может занимать несколько строк)
//   @@@ FILE create|update путь
//   ...полное содержимое файла...
//   @@@ END
//   @@@ DELETE путь

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|vendor|__pycache__|\.venv|coverage)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|avi|exe|dll|so|bin|lock|map|min\.js)$/i;

/** Список путей для выбора моделью: без мусора и бинарников. */
export function listCandidates(files, limit = 400) {
  return files.filter((f) => !SKIP_DIRS.test(f.path) && !BINARY_EXT.test(f.path)).slice(0, limit);
}

/** Ответ модели «какие файлы прочитать» → пути, которые реально есть в репозитории. */
export function parseSelection(text, files, { maxFiles = 8, maxBytes = 120000, maxOne = 60000 } = {}) {
  const sizes = new Map(files.map((f) => [f.path, f.size]));
  const out = [];
  let total = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const p = raw.replace(/^[\s\-*\d.)]+/, '').replace(/[`"']/g, '').trim();
    if (!p || !sizes.has(p) || out.includes(p)) continue;
    const sz = sizes.get(p);
    if (sz > maxOne || total + sz > maxBytes) continue;
    out.push(p);
    total += sz;
    if (out.length >= maxFiles) break;
  }
  return out;
}

function unfence(s) {
  const lines = s.split('\n');
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) return lines.slice(1, -1).join('\n');
  return s;
}

/** Разбор ответа с изменениями. */
export function parseChanges(text) {
  const res = { commit: '', summary: '', files: [], deletes: [] };
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let mode = null; // 'summary' | 'file'
  let cur = null;
  let buf = [];
  const flushSummary = () => {
    if (mode === 'summary') res.summary = buf.join('\n').trim();
  };
  for (const line of lines) {
    if (mode === 'file') {
      if (/^@@@ END\s*$/.test(line)) {
        cur.content = unfence(buf.join('\n').replace(/\n+$/, '')) + '\n';
        res.files.push(cur);
        mode = null;
        buf = [];
        cur = null;
      } else buf.push(line);
      continue;
    }
    let m;
    if ((m = /^@@@ COMMIT:\s*(.*)$/.exec(line))) {
      flushSummary();
      res.commit = m[1].trim();
      mode = null;
      buf = [];
    } else if ((m = /^@@@ SUMMARY:\s*(.*)$/.exec(line))) {
      flushSummary();
      mode = 'summary';
      buf = [m[1]];
    } else if ((m = /^@@@ FILE\s+(create|update)\s+(.+?)\s*$/i.exec(line))) {
      flushSummary();
      mode = 'file';
      cur = { action: m[1].toLowerCase(), path: m[2].replace(/^["'`]|["'`]$/g, ''), content: '' };
      buf = [];
    } else if ((m = /^@@@ DELETE\s+(.+?)\s*$/i.exec(line))) {
      flushSummary();
      mode = null;
      res.deletes.push(m[1].replace(/^["'`]|["'`]$/g, ''));
      buf = [];
    } else if (mode === 'summary') buf.push(line);
  }
  flushSummary();
  // недописанный файл (обрыв ответа) не берём — вернём признак
  res.truncated = mode === 'file';
  return res;
}

/** Безопасный относительный путь внутри репозитория. */
export function safePath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const parts = p.split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..')) return false;
  if (parts[0] === '.git') return false;
  return true;
}

const SECRET_PATTERNS = [
  ['ключ ClaudeHub (sk-hub-…)', /sk-hub-[A-Za-z0-9_-]{8,}/],
  ['токен GitHub', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['токен Telegram-бота', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['приватный ключ', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['ключ sk-…', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
];

/** Названия найденных в тексте секретов (пусто — чисто). */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function slug(s, max = 30) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const t = String(s ?? '').toLowerCase().split('').map((c) => map[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (t || 'change').slice(0, max).replace(/-+$/, '');
}
