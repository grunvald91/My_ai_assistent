// utf8.js — потоковый декодер UTF-8 (TextDecoder в изоляте платформы не гарантирован).
// Принимает куски байтов (Uint8Array), которые могут рвать многобайтные символы посередине.

export function createUtf8Decoder() {
  let pending = []; // недочитанный хвост предыдущего куска

  function decode(bytes) {
    let buf = bytes;
    if (pending.length) {
      buf = new Uint8Array(pending.length + bytes.length);
      buf.set(pending, 0);
      buf.set(bytes, pending.length);
      pending = [];
    }
    const n = buf.length;
    let out = '';
    let i = 0;
    while (i < n) {
      const b = buf[i];
      let len = 1;
      let cp = b;
      if (b < 0x80) {
        len = 1;
      } else if (b >= 0xc2 && b <= 0xdf) {
        len = 2;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        len = 3;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        len = 4;
        cp = b & 0x07;
      } else {
        out += '�'; // недопустимый ведущий байт
        i++;
        continue;
      }
      if (i + len > n) {
        // хвост неполный — отложим до следующего куска (если он выглядит корректно)
        let ok = true;
        for (let k = i + 1; k < n; k++) if ((buf[k] & 0xc0) !== 0x80) ok = false;
        if (ok) {
          pending = Array.from(buf.subarray(i));
          break;
        }
        out += '�';
        i++;
        continue;
      }
      let valid = true;
      for (let k = 1; k < len; k++) {
        const c = buf[i + k];
        if ((c & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (c & 0x3f);
      }
      if (!valid || (len === 3 && cp < 0x800) || (len === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) {
        out += '�';
        i++;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += len;
    }
    return out;
  }

  /** Вызвать в конце потока: незавершённый хвост превращается в U+FFFD. */
  function flush() {
    const had = pending.length > 0;
    pending = [];
    return had ? '�' : '';
  }

  return { decode, flush };
}
