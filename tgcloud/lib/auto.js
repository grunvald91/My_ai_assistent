// auto.js — автоподбор модели (/auto): простые вопросы отдаём быстрой дешёвой модели, остальное — той, что выбрана в /model.
// Без дополнительных запросов к ИИ (вызов бота живёт ~30 с): сложность оценивается по самому сообщению.
// Чистый модуль.

const HARD_WORDS =
  /код|скрипт|функци|баг|ошибк|алгоритм|sql|python|js\b|javascript|regex|репозитор|github|напиши|составь|сочини|придумай|разработ|проанализ|анализ|сравни|сравнен|стратег|бизнес-план|план\b|подробн|разбер|объясни|докажи|реши|посчитай|расчёт|расчет|переведи|перевод|резюмируй|перескажи|статью|пост\b|текст для|договор|юридическ|налог|диагноз|лечени/i;

/** Простое ли сообщение: короткое, без кода и «тяжёлых» просьб. */
export function isSimple(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 140) return false;
  if (t.includes('\n') || /[`{};]|=>|https?:\/\//.test(t)) return false;
  if (HARD_WORDS.test(t)) return false;
  return true;
}

const price = (m) => m?.priceOut ?? m?.priceIn ?? null;

/** Быстрая модель из списка настроек: живая, есть в каталоге и дешевле текущей (если цены известны). */
export function pickFast(models, current, fastList) {
  for (const id of fastList) {
    if (id === current.id) return null; // выбранная уже быстрая
    const m = models.find((x) => x.id === id && !x.down);
    if (!m) continue;
    const [pf, pc] = [price(m), price(current)];
    if (pf != null && pc != null && pf >= pc) return null; // выбранная и так не дороже
    return m;
  }
  return null;
}
