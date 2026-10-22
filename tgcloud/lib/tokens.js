// tokens.js — грубая оценка числа токенов без токенизатора.
// Русский текст токенизируется хуже английского (~2.2 символа на токен против ~4),
// поэтому считаем с запасом: оценка нужна для бюджета истории и учёта расхода,
// когда API не вернул usage.

export function estimateTokens(s) {
  s = String(s ?? '');
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 2.2);
}

/** Токены одного сообщения чата: текст + небольшой служебный довесок. */
export function messageTokens(m) {
  if (Array.isArray(m.content)) {
    // части: текст по длине, картинка ~1500, документ по размеру base64 (грубо 1 токен на 3 байта)
    return m.content.reduce((n, p) => n + (p?.type === 'image_url' ? 1500 : p?.type === 'document' ? Math.ceil((p.data?.length ?? 0) * 0.25) : estimateTokens(p?.text ?? '')), 4);
  }
  return estimateTokens(m.content ?? m.text ?? '') + 4;
}
