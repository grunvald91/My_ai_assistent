// sse.js — разбор Server-Sent Events (поток ответа ClaudeHub с "stream": true).
// Формат: строки "data: {...}", события разделены пустой строкой, поток OpenAI-типа
// заканчивается "data: [DONE]". Куски приходят произвольно порезанными.

export function createSseParser(onEvent) {
  let buf = '';
  let data = [];
  let event = null;

  function line(l) {
    if (l === '') {
      if (data.length) onEvent({ event, data: data.join('\n') });
      data = [];
      event = null;
      return;
    }
    if (l.charCodeAt(0) === 58) return; // ":" — комментарий/keep-alive
    const i = l.indexOf(':');
    let field = l;
    let value = '';
    if (i !== -1) {
      field = l.slice(0, i);
      value = l.slice(i + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }

  return {
    push(s) {
      buf += s;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c === 10) {
          line(buf.slice(start, i));
          start = i + 1;
        } else if (c === 13) {
          if (i === buf.length - 1) break; // возможно «\r\n» разрезан — дождёмся продолжения
          line(buf.slice(start, i));
          if (buf.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    },
    end() {
      if (buf.length) {
        line(buf.replace(/\r$/, ''));
        buf = '';
      }
      line('');
    },
  };
}
