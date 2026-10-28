// bg.js — тяжёлые модели отвечают «в фоне»: вопрос уходит в GitHub Actions (там нет лимита ~30 с на вызов бота),
// готовый ответ сам приходит в чат; кнопка «Забрать ответ» проверяет и достаёт его вручную.
//
// Приватность: репозиторий бота публичный, поэтому ни текст переписки, ни ответ НЕ передаются через параметры запуска
// или логи Actions. В workflow уходит только id задачи; задача сама забирает запрос у бота (эндпоинт bgjob_get),
// а ответ отдаёт обратно (bgjob_part / bgjob_done).
//
// Состояние — в настройках: bg:<id> (метаданные), bg:<id>:q<i> (запрос по частям), bg:<id>:a<i> (ответ по частям).

import { GithubError } from './github.js';
import { escapeHtml, safeJson, uid } from './util.js';
import { promptTokens } from './context.js';
import { estimateTokens } from './tokens.js';

const kb = (rows) => ({ inline_keyboard: rows });
const WORKFLOW = 'bgjob.yml';
const CHUNK = 25000; // символов в одной части ОТВЕТА: аргумент командной строки ограничен ~128 КБ
const REQ_CHUNK = 400000; // символов в одной части ЗАПРОСА (с файлами он большой; задача забирает его выводом, а не аргументом)

/** Делит текст на части, не разрывая суррогатные пары (эмодзи). */
export function splitSafe(text, size = CHUNK) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--; // не режем между половинками символа
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts;
}

export function createBg(D, chatMod) {
  const { store, out, core, cfg } = D;
  const gh = () => D.github;

  const heavyRe = () => new RegExp(cfg.bgHeavy || '$^', 'i');

  /** Можно ли вообще отвечать в фоне (Actions настроены и /bg не выключен). */
  async function canRun() {
    if (!cfg.bgViaActions || !D.selfRepo || !D.github) return false;
    return (await store.getSetting('bg')) !== '0';
  }

  /** Идёт ли ответ этой модели через Actions (тяжёлая модель). */
  async function shouldRun(model) {
    return heavyRe().test(model?.id ?? '') && (await canRun());
  }

  const metaOf = async (id) => safeJson(await store.getSetting('bg:' + id), null);
  const saveMeta = (id, meta) => store.setSetting('bg:' + id, meta ? JSON.stringify(meta) : null);

  async function clear(id, meta) {
    for (let i = 0; i < (meta?.n ?? 0); i++) await store.setSetting(`bg:${id}:q${i}`, null);
    for (let i = 0; i < (meta?.an ?? 0); i++) await store.setSetting(`bg:${id}:a${i}`, null);
    await store.setSetting('bg:' + id, null);
  }

  const statusHtml = (model, reason) =>
    (reason ? reason + '\n' : '') +
    `⏳ <b>${escapeHtml(model)}</b> готовит ответ в фоне (GitHub Actions) — там нет лимита в 30 секунд. Обычно 1–3 минуты.\n` +
    'Ответ придёт сюда сам. Кнопка — проверить и забрать вручную.';

  /** true — вопрос ушёл в Actions. false — не вышло (причина показана), дальше отвечаем обычным путём. */
  /**
   * search: поиск в интернете делает задача Actions — { asked, date } (сначала решить, нужен ли) или { query, date } (уже решено).
   * reason: строка над статусом (почему в фоне).
   */
  async function start(chatId, { model, messages, think, repoLen = 0, note = '', snote = '', search = null, reason = '' }) {
    await core.assertLimits();
    const level = think && think !== 'off' && model.thinking ? think : null;
    const cap = cfg.maxTokensChat === 'max' ? model.maxOut || cfg.maxTokensFallback : cfg.maxTokensChat;
    const parts = splitSafe(JSON.stringify({ model: model.id, messages, maxTokens: cap, think: level, ...(search ? { search } : {}) }), REQ_CHUNK);
    const id = uid();
    for (let i = 0; i < parts.length; i++) await store.setSetting(`bg:${id}:q${i}`, parts[i]);
    const meta = { chatId, model: model.id, ts: D.now(), repoLen, note, snote, n: parts.length, an: 0, state: 'run', estIn: promptTokens(messages) };
    await saveMeta(id, meta);
    try {
      const selfInfo = await gh().getRepo(D.selfRepo);
      await gh().dispatch(D.selfRepo, WORKFLOW, selfInfo.default_branch, { job: id });
    } catch (e) {
      await clear(id, meta);
      if (e instanceof GithubError) {
        await out.sendHtml(
          chatId,
          `⚠️ В GitHub Actions ответ запустить не вышло: ${escapeHtml(e.userMessage)}\n\nОтвечаю обычным путём (за ~30 секунд). Чтобы работало в фоне, дай токену GH_PAT право Actions (Read and write) на репозиторий бота.`,
        );
        return false;
      }
      throw e;
    }
    const sent = await out.sendHtml(chatId, statusHtml(model.id, reason), {
      reply_markup: kb([[{ text: '📥 Забрать ответ', callback_data: 'bg:g:' + id, style: 'primary' }, { text: '✖️ Отмена', callback_data: 'bg:x:' + id, style: 'danger' }]]),
    });
    if (sent?.message_id) await saveMeta(id, { ...meta, statusMsg: sent.message_id });
    return true;
  }

  // ───────── обмен с задачей Actions ─────────

  /** Часть запроса для задачи. */
  async function getRequest(job, i) {
    const meta = await metaOf(job);
    if (!meta || meta.state === 'canceled' || !(i >= 0 && i < meta.n)) return null;
    return { n: meta.n, text: (await store.getSetting(`bg:${job}:q${i}`)) ?? '' };
  }

  async function receivePart(job, i, text) {
    const meta = await metaOf(job);
    if (!meta || !(i >= 0)) return false;
    await store.setSetting(`bg:${job}:a${i}`, text);
    return true;
  }

  async function finish({ job, n, finish: why, usage, model, error, snote = null }) {
    const meta = await metaOf(job);
    if (!meta) return false;
    if (meta.state === 'canceled') {
      await clear(job, { ...meta, an: n });
      return true;
    }
    if (!meta.chatId) {
      // проверочная задача диагностики: чата нет, владельцу ничего не показываем — только запоминаем итог
      await saveMeta(job, { ...meta, state: error ? 'error' : 'ready', an: n, why: why ?? null, usage: usage ?? null, err: error ? String(error).slice(0, 200) : null });
      return true;
    }
    if (error) {
      await clear(job, { ...meta, an: n });
      if (meta.statusMsg) await out.dropButtons(meta.chatId, meta.statusMsg);
      await out.sendHtml(meta.chatId, `⚠️ Ответ в фоне не получился: ${escapeHtml(error)}`, {
        reply_markup: kb([[{ text: '🔄 Повторить', callback_data: 'r:1' }]]),
      });
      return true;
    }
    await saveMeta(job, { ...meta, state: 'ready', an: n, why: why ?? null, usage: usage ?? null, model: model || meta.model, snote: snote || meta.snote || '' });
    try {
      await deliver(job);
    } catch (e) {
      console.warn('bg deliver failed', e?.message ?? e); // ответ остаётся «готов» — его можно забрать кнопкой
    }
    return true;
  }

  /** Показывает готовый ответ. false — ответа нет или он уже выдан. */
  async function deliver(job) {
    const meta = await metaOf(job);
    if (!meta || meta.state !== 'ready') return false;
    await saveMeta(job, { ...meta, state: 'delivering' }); // от двойной выдачи (кнопка + авто)
    try {
      let text = '';
      for (let i = 0; i < meta.an; i++) text += (await store.getSetting(`bg:${job}:a${i}`)) ?? '';
      const tokensOut = meta.usage?.out ?? estimateTokens(text);
      const tokensIn = meta.usage?.in ?? meta.estIn ?? 0;
      if (!meta.billed) {
        // расход — ровно один раз, даже если выдача сорвётся и ответ потом заберут кнопкой
        await core.recordUsage(meta.model, tokensIn, tokensOut);
        meta.billed = true;
        await saveMeta(job, { ...meta, state: 'delivering' });
      }
      await chatMod.publishOwnerReply(meta.chatId, { text, finish: meta.why, tokensOut }, { model: { id: meta.model }, repoLen: meta.repoLen, mediaNote: meta.note ?? '', searchNote: meta.snote ?? '' });
      await store.trimMessages(String(meta.chatId), 300);
      if (meta.statusMsg) await out.editHtml(meta.chatId, meta.statusMsg, `✅ <b>${escapeHtml(meta.model)}</b>: ответ готов — он ниже.`, null).catch(() => {});
    } catch (e) {
      await saveMeta(job, { ...meta, state: 'ready' });
      throw e;
    }
    await clear(job, meta);
    return true;
  }

  // ───────── кнопки и /bg ─────────

  async function callback(cq, parts) {
    const chatId = cq.message.chat.id;
    const [act, id] = parts;
    if (act === 'go' || act === 'now') {
      // «В фоне» / «Сразу в чате» — выбор для вопроса с файлом или кнопка после обрыва по времени.
      // Кнопка привязана к вопросу: если с тех пор ты написал что-то ещё, она бы ответила уже не на то — не даём.
      const chat = await store.getChat(chatId);
      if (Number(id) && Number(id) !== (await chatMod.lastUserId(String(chatId), chat))) {
        await out.dropButtons(chatId, cq.message.message_id);
        return void (await out.answerCb(cq.id, 'Кнопка устарела: после этого вопроса были другие сообщения. Задай вопрос с файлом ещё раз (или ответь на сообщение с файлом).', true));
      }
      // двойное нажатие (кнопка «не сработала», нажал ещё раз) — второй раз ничего не запускаем
      if (Number(id) && !(await store.claimOnce(`bg:${act}:${chatId}:${id}`, D.now()))) {
        return void (await out.answerCb(cq.id, act === 'go' ? 'Уже отправлено в фон — ответ придёт сам.' : 'Уже отвечаю.'));
      }
      await out.dropButtons(chatId, cq.message.message_id);
      await out.answerCb(cq.id, act === 'go' ? 'Отправляю в фон…' : 'Отвечаю…');
      await chatMod.respondOwner(chatId, undefined, { mode: act === 'go' ? 'bg' : 'now' });
      return undefined;
    }
    if (act === 'on' || act === 'off') {
      await store.setSetting('bg', act === 'off' ? '0' : null);
      await out.answerCb(cq.id, act === 'off' ? 'Выключено' : 'Включено');
      return panel(chatId, cq.message.message_id);
    }
    const meta = await metaOf(id);
    if (act === 'x') {
      if (!meta || meta.state === 'delivering') return void (await out.answerCb(cq.id, 'Уже поздно: ответ выдан или задачи нет', true));
      // готовый, но не выданный ответ задача уже не пришлёт повторно — убираем сразу; идущую помечаем, поздний итог выбросим
      if (meta.state === 'run') await saveMeta(id, { ...meta, state: 'canceled' });
      else await clear(id, meta);
      await out.answerCb(cq.id, 'Отменено');
      await out.editHtml(chatId, cq.message.message_id, '✖️ Отменено. Если модель уже что-то написала — этот ответ просто выброшу.', null);
      return undefined;
    }
    if (act === 'g') {
      if (!meta) return void (await out.answerCb(cq.id, 'Этого ответа уже нет: его выдали или отменили', true));
      if (meta.state === 'run') {
        const sec = Math.max(0, D.now() - meta.ts);
        return void (await out.answerCb(cq.id, `⏳ Ещё готовится (${sec} с). Как только будет готов — придёт сам.`, true));
      }
      if (meta.state === 'ready') {
        await out.answerCb(cq.id, 'Достаю…');
        await deliver(id);
        return undefined;
      }
      return void (await out.answerCb(cq.id, 'Ответ уже выдаётся'));
    }
    await out.answerCb(cq.id);
    return undefined;
  }

  async function panel(chatId, editMsgId) {
    const on = (await store.getSetting('bg')) !== '0';
    const html =
      `🐢 <b>Тяжёлые модели в фоне</b>: ${on ? '🟢 включено' : '⚪ выключено'}\n\n` +
      'Включено: когда выбрана тяжёлая модель (сейчас — семейство Opus), вопрос уходит в GitHub Actions. ' +
      'Бот сразу пишет, что ответ готовится, а готовый ответ присылает сам; кнопка «Забрать ответ» проверяет готовность. ' +
      'Так модель может думать сколько нужно, а не 30 секунд. Обычно ответ приходит через 1–3 минуты.\n\n' +
      'С фото или файлом бот спросит: «В фоне» или «Сразу в чате». Если поиск в интернете отвечает слишком долго — вопрос тоже уходит в фон (для любой модели), поиск доделывается там.\n\n' +
      'Выключено: тяжёлые модели отвечают прямо в чате, за ~30 секунд (дольше платформа не даёт).';
    const markup = kb([[{ text: on ? '⚪ Выключить' : '🟢 Включить', callback_data: 'bg:' + (on ? 'off' : 'on'), style: on ? undefined : 'success' }]]);
    if (editMsgId) {
      try {
        await out.editHtml(chatId, editMsgId, html, markup);
        return true;
      } catch {
        /* не редактируется — пришлём новое */
      }
    }
    await out.sendHtml(chatId, html, { reply_markup: markup });
    return true;
  }

  async function command(chatId, arg) {
    const a = String(arg ?? '').trim().toLowerCase();
    if (['on', 'вкл', 'включить', 'да'].includes(a)) await store.setSetting('bg', null);
    else if (['off', 'выкл', 'выключить', 'нет'].includes(a)) await store.setSetting('bg', '0');
    else if (a) {
      await out.sendHtml(chatId, 'Так: <code>/bg вкл</code> или <code>/bg выкл</code> — или нажми кнопки: /bg');
      return true;
    }
    return panel(chatId);
  }

  /**
   * Проверка всего пути без Telegram (для диагностики): первый вызов запускает проверочную задачу в Actions,
   * следующий сообщает, дошёл ли ответ, и убирает следы. Владельцу ничего не отправляется.
   */
  async function selfTest({ big = false } = {}) {
    const prev = await store.getSetting('bg_test');
    if (prev) {
      const meta = await metaOf(prev);
      if (!meta) {
        await store.setSetting('bg_test', null);
        return { stage: 'check', job: prev, state: 'следов нет (уже убрано)' };
      }
      const age = D.now() - meta.ts;
      const report = { stage: 'check', job: prev, state: meta.state, answer_parts: meta.an, usage: meta.usage ?? null, err: meta.err ?? null, age_s: age };
      if (meta.state !== 'run' || age > 900) {
        await clear(prev, meta);
        await store.setSetting('bg_test', null);
      }
      return report;
    }
    const id = uid();
    // big: запрос на ~3 МБ (лишнее поле pad модель не видит) — проверяем, что большие запросы с файлами проходят весь путь
    const body = JSON.stringify({ model: cfg.fastModels?.[0] ?? 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Ответь одним словом: ок' }], maxTokens: 20, think: null, ...(big ? { pad: 'я'.repeat(3_000_000) } : {}) });
    const qs = splitSafe(body, REQ_CHUNK);
    for (let i = 0; i < qs.length; i++) await store.setSetting(`bg:${id}:q${i}`, qs[i]);
    await saveMeta(id, { chatId: 0, model: 'test', ts: D.now(), repoLen: 0, n: qs.length, an: 0, state: 'run', estIn: 10 });
    await store.setSetting('bg_test', id);
    const selfInfo = await gh().getRepo(D.selfRepo);
    await gh().dispatch(D.selfRepo, WORKFLOW, selfInfo.default_branch, { job: id });
    return { stage: 'started', job: id };
  }

  return { selfTest, canRun, shouldRun, start, getRequest, receivePart, finish, deliver, callback, command };
}
