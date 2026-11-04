// Structured transport lookup via the public Tutu MCP Streamable HTTP endpoint.
// Only provider fields, never LLM-generated times, are displayed as departures.
import { dayKey } from './util.js';
import { isLiveTransitQuestion } from './exa.js';
import { withDeadline, TIMED_OUT } from './llm.js';

export const TUTU_MCP_URL = 'https://mcp.tutu.ru/mcp';
const FOLLOWUP = /^(?:а\s+)?(?:следующ|позже|через\s+час|до\s+аэропорта|а\s+до\s+аэропорта)/i;
const TRAIN = /электричк|ласточк|пригородн.{0,15}поезд/i;
const RAIL = /поезд(?:а|ов|ом|ы)?|железнодорожн/i;
const BUS = /автобус|автовокзал|междугородн|маршрутк/i;
const AIR = /самол[её]т|авиарейс|авиабилет|перел[её]т|аэропорт|вылет/i;
const WATER = /паром|теплоход|катер|водн.{0,8}транспорт|вертол[её]т/i;
const TRIP = /как добраться|как доехать|чем доехать|спланируй маршрут|вариант.{0,6}маршрут|билет/i;
const CURRENT = /ближайш|следующ|сейчас|сегодня|завтра|расписан|отправл|прибыт|во сколько|когда|рейс|вылет|стоимост|цена|купить|найди|покажи/i;
const KINDS = { commuter:'search_etrain', rail:'search_rail', bus:'search_bus',
  plane:'search_avia', mixed:'search_multitransport', water:'search_water', helicopter:'search_helicopter' };
export const TUTU_SEARCH_TOOLS = ['search_etrain','search_rail','search_bus','search_avia','search_multitransport'];

const MAX_AGE_SECONDS = 3600;

/**
 * A cheap gate only determines whether the user is asking for a live rail lookup.
 * It NEVER tries to parse station names: an LLM handles semantic understanding.
 */
export function isTransitCandidate(question, previous, nowSec) {
  const text = String(question ?? '').trim();
  const recent = previous && nowSec - Number(previous.savedAt ?? 0) <= MAX_AGE_SECONDS;
  return !!(text && (
    ((TRAIN.test(text) || RAIL.test(text) || BUS.test(text) || AIR.test(text) || WATER.test(text)) &&
      (isLiveTransitQuestion(text) || CURRENT.test(text))) ||
    (TRIP.test(text) && /(?:из|от).{3,}(?:в|до|на).{2,}/i.test(text)) ||
    (recent && previous.origin && previous.destination && (FOLLOWUP.test(text) ||
      (text.length <= 90 && !text.startsWith('/'))))
  ));
}

const TRANSIT_INTENT_SYSTEM = [
  'TRANSIT_INTENT_JSON: Ты семантический маршрутизатор русскоязычного ИИ-помощника.',
  'Нужно понять смысл просьбы, а не искать предлоги по шаблону.',
  'Верни ТОЛЬКО JSON: {"intent":"schedule|clarify|other","origin":"","destination":"","date":"today|tomorrow|YYYY-MM-DD","mode":"commuter|rail|bus|plane|water|helicopter|mixed","next":false,"details":false}.',
  'При запросе расписания intent=schedule. Заполни обе станции из живой разговорной речи, учитывай падежи, предлоги и порядок слов.',
  'Пример: «посмотри электрички на сегодня из Адлера на Красную Поляну» => origin="Адлер", destination="Красная Поляна", date="today", mode="commuter".',
  'Понимай транспорт: электрички = commuter; поезда дальнего следования = rail; межгородские автобусы = bus; самолёты = plane; паром/судно = water; вертолёт = helicopter; подбор вариантов разными видами транспорта = mixed.',
  'Если пользователь просит все остановки/детали конкретного маршрута, добавь details=true; обычное расписание details=false.',
  'Городской транспорт и схемы улиц не входят в Яндекс Расписания. Для городского автобуса без междугороднего маршрута ставь intent=other.',
  'Датой для всех рейсов служит дата отправления; не придумывай время прилёта и прибытия.',
  'Не подменяй указанное пользователем направление названием другой станции или курорта без подтверждения.',
  'При коротком уточнении («а следующая?») используй предыдущий маршрут и дату и next=true; «а завтра?» меняет дату на завтра и next=false.',
  'Если НЕ ХВАТАЕТ станции и нельзя вывести её из контекста, intent=clarify и неизвестное поле пустое.',
  'Если речь НЕ о поиске актуального железнодорожного расписания, intent=other.',
  'НЕ придумывай время отправления, стоимость, доступность и подтверждение от Туту: эти данные придут только из инструмента.',
].join('\n');

function parseIntentJson(text) {
  const raw = String(text ?? '').trim();
  const begin = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (begin < 0 || end <= begin) throw new Error('ИИ не вернул маршрут в формате JSON');
  let value;
  try { value = JSON.parse(raw.slice(begin, end + 1)); }
  catch { throw new Error('ИИ вернул некорректный JSON маршрута'); }
  if (!value || typeof value !== 'object' || !['schedule', 'clarify', 'other'].includes(value.intent)) {
    throw new Error('ИИ не распознал тип транспортного запроса');
  }
  return value;
}

const station = (v) => typeof v === 'string' && v.length <= 120 &&
  !/[\u0000-\u001f<>]/.test(v) ? v.trim() : '';

/** AI-first route understanding; deterministic code only validates output and calls the provider. */
export async function understandTransitQuestion(question, previous, nowSec, timezoneHours, generate) {
  if (!isTransitCandidate(question, previous, nowSec)) return null;
  const today = dayKey(nowSec, timezoneHours);
  const tomorrow = dayKey(nowSec + 86400, timezoneHours);
  const recent = previous && nowSec - Number(previous.savedAt ?? 0) <= MAX_AGE_SECONDS &&
    previous.origin && previous.destination ? previous : null;
  const input = { question: String(question), today, tomorrow, previous: recent ?
    { origin: recent.origin, destination: recent.destination, date: recent.date, mode: recent.kind, offset: recent.offset ?? 0 } : null };
  const response = await generate([
    { role: 'system', content: TRANSIT_INTENT_SYSTEM },
    { role: 'user', content: JSON.stringify(input) },
  ]);
  const parsed = parseIntentJson(response);
  if (parsed.intent === 'other') return { intent: 'other' };
  const origin = station(parsed.origin);
  const destination = station(parsed.destination);
  const date = parsed.date === 'tomorrow' ? tomorrow : parsed.date === 'today' || !parsed.date ? today :
    /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : today;
  const kind = KINDS[parsed.mode] ??
    (recent?.kind || (TRAIN.test(question) ? 'search_etrain' : RAIL.test(question) ? 'search_rail' : 'search_multitransport'));
  if (!origin || !destination || parsed.intent === 'clarify') {
    return { intent: 'clarify', missingOrigin: !origin, missingDestination: !destination };
  }
  const next = parsed.next === true;
  return { intent: 'schedule', plan: {
    origin, destination, date, kind,
    offset: next && recent ? Math.min(20, (Number(recent.offset) || 0) + 1) : 0,
    details: parsed.details === true,
    ...(kind === 'search_water' ? { modes: ['water'] } : {}),
    savedAt: nowSec, timezoneHours,
  } };
}

function parseSse(text, id) {
  const events = String(text).split(/\r?\n\r?\n/);
  for (const event of events) {
    const payload = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (parsed.id === id) return parsed;
  }
  throw new Error('Tutu MCP: no matching response in SSE');
}

async function postMcp(fetchFn, url, message, sessionId, version) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (version) headers['MCP-Protocol-Version'] = version;
  const r = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(message) });
  if (!r.ok) throw new Error('Tutu MCP HTTP ' + r.status);
  if (!Object.hasOwn(message, 'id')) return { payload: null, session: null };
  const mime = (r.headers?.get?.('content-type') || '').toLowerCase();
  const response = mime.includes('text/event-stream') ? parseSse(await r.text(), message.id) : await r.json();
  if (response?.error) throw new Error('Tutu MCP JSON-RPC ' + (response.error.code ?? 'error'));
  if (!response || response.id !== message.id) throw new Error('Tutu MCP: mismatched response id');
  return { payload: response.result, session: r.headers?.get?.('mcp-session-id') || null };
}

export async function callTutuTool(fetchFn, tool, args, url = TUTU_MCP_URL) {
  if (!TUTU_SEARCH_TOOLS.includes(tool)) throw new Error('Unsupported transport tool');
  const init = await postMcp(fetchFn, url, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'my-ai-assistant', version: '1.0' } },
  });
  const session = init.session;
  const version = init.payload?.protocolVersion || '2025-11-25';
  await postMcp(fetchFn, url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, version);
  // Flight searches can be slow; the caller retries slow operations via Actions.
  // Ask for a small departure-sorted first page instead of exhausting all flight pages.
  const PAGE_SIZE = tool === 'search_avia' ? 5 : tool === 'search_multitransport' ? 10 : 30;
  const MAX_PAGES = tool === 'search_avia' ? 1 : tool === 'search_multitransport' ? 2 : 10;
  async function loadPage(page) {
    const res = await postMcp(fetchFn, url, {
      jsonrpc: '2.0', id: page + 1, method: 'tools/call',
      params: { name: tool, arguments: {
        origin: args.origin, destination: args.destination, departure_date: args.date,
        page, page_size: PAGE_SIZE, view: 'compact',
        ...(tool === 'search_multitransport'
          ? { adults: 1, optimize_for: 'time', ...(args.modes ? { modes: args.modes } : {}) }
          : { sort: 'departure_asc',
              ...(tool === 'search_rail' ? { passengers: 1 } : {}),
              ...(['search_avia','search_bus'].includes(tool) ? { adults: 1 } : {}) }),
      } },
    }, session, version);
    if (res.payload?.isError) throw new Error('Tutu MCP tool returned an error');
    let data = res.payload?.structuredContent;
    if (!data) {
      const raw = (res.payload?.content || []).find((x) => typeof x?.text === 'string')?.text;
      if (!raw) throw new Error('Tutu MCP: missing structured result');
      data = JSON.parse(raw);
    }
    if (typeof data === 'string') data = JSON.parse(data);
    if (data?.error) throw new Error('Tutu MCP: provider reported an error');
    if (data && Object.hasOwn(data, 'result')) data = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    if (!data || typeof data !== 'object') throw new Error('Tutu MCP: invalid tool result');
    return data;
  }

  const first = await loadPage(1);
  if (!Array.isArray(first.offers)) return first; // Unknown schemas remain untrusted.
  const combined = [...first.offers];
  const seen = new Set(first.offers.map((x) => String(x?.offer_id ?? '')).filter(Boolean));
  let last = first;
  let complete = last.meta?.has_more === false || (first.offers.length < PAGE_SIZE && last.meta?.has_more !== true);
  // Price-sorted page 1 is NOT enough to determine the next chronological departure.
  // Load additional pages until the provider establishes an end or safety limit is reached.
  for (let page = 2; page <= MAX_PAGES && !complete; page++) {
    last = await loadPage(page);
    if (!Array.isArray(last.offers)) break;
    let added = 0;
    for (const offer of last.offers) {
      const id = String(offer?.offer_id ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      combined.push(offer);
      added++;
    }
    if (last.meta?.has_more === false || (last.offers.length < PAGE_SIZE && last.meta?.has_more !== true)) complete = true;
    if (!added) break; // Repeated page; never loop blindly.
  }
  return { ...first, offers: combined,
    meta: { ...(first.meta ?? {}), ...(last.meta ?? {}), loaded_offers: combined.length,
      complete: complete && last.meta?.total_matched_exact !== false } };
}

function localIso(value, date, tzHours) {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(s)) return s;
  // Time-only values have no timezone. Use the owner's timezone only for recognized Russian
  // locations in the same zone; otherwise do not invent a UTC offset.
  if (!/^(Сочи|Адлер|Москва|Хоста|Туапсе)$/i.test(String(date?.origin ?? ''))) return null;
  if (/^\d\d:\d\d$/.test(s)) {
    const sign = tzHours >= 0 ? '+' : '-';
    return date.date + 'T' + s + ':00' + sign + String(Math.abs(tzHours)).padStart(2, '0') + ':00';
  }
  return null;
}

export function normalizeDepartures(data, plan, nowSec) {
  const list = Array.isArray(data) ? data : ['offers', 'trips', 'trains', 'results', 'routes', 'items'].map((k) => data?.[k]).find(Array.isArray) || [];
  const normalized = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const departure = item.departure_at ?? item.departure_datetime ?? item.departureTime ?? item.departure_time ?? item.departure?.datetime ?? item.departure?.time;
    const iso = localIso(departure, plan, plan.timezoneHours);
    if (!iso) continue;
    const ms = Date.parse(iso);
    // The date comes from the user's request. Never discard future trips merely
    // because their departure is more than 72 hours from the current instant.
    if (!Number.isFinite(ms) || ms < nowSec * 1000) continue;
    const station = item.from?.name ?? item.origin?.name ?? item.origin_name ?? item.from_station ?? '';
    const destination = item.to?.name ?? item.destination?.name ?? item.destination_name ?? item.to_station ?? '';
    const matches = (actual, requested) => !actual || !requested || 
      String(actual).toLowerCase().includes(String(requested).toLowerCase()) ||
      String(requested).toLowerCase().includes(String(actual).toLowerCase());
    if (!matches(station, plan.origin) || !matches(destination, plan.destination)) continue;
    const regionIsMoscowTz = /^(Сочи|Адлер|Москва|Хоста|Туапсе|Ростов-на-Дону)$/i.test(String(plan.origin));
    const offsetMatch = /([+-])(\d\d):(\d\d)$/.exec(iso);
    const seconds = offsetMatch ? (offsetMatch[1] === '-' ? -1 : 1) *
      (Number(offsetMatch[2]) * 3600 + Number(offsetMatch[3]) * 60) : regionIsMoscowTz ? 10800 : 0;
    const local = new Date(ms + seconds * 1000).toISOString();
    const isUtc = !offsetMatch && !regionIsMoscowTz;
    if (plan.date && local.slice(0, 10) !== plan.date) continue;
    normalized.push({ at: ms, time: local.slice(11, 16) + (isUtc ? ' UTC' : ''), day: local.slice(0, 10),
      station: String(station), destination: String(destination) });
  }
  normalized.sort((a, b) => a.at - b.at);
  return normalized;
}

export function formatTransitResponse(data, plan, nowSec) {
  const departures = normalizeDepartures(data, plan, nowSec);
  const meta = data?.meta || {};
  if (!departures.length) return 'Туту MCP ответил, но не вернул подтверждённых будущих отправлений с распознаваемым временем для маршрута ' +
    plan.origin + ' → ' + plan.destination + ' на ' + plan.date +
    '. Это не означает, что рейсов нет. Проверь расписание у перевозчика.';
  const index = Math.max(0, Math.min(20, Number(plan.offset) || 0));
  const filtered = departures.slice(index, index + 3);
  if (!filtered.length) return 'Туту MCP не подтвердил следующего отправления для ' + plan.origin + ' → ' + plan.destination + '.';
  const rows = filtered.map((d, i) => `${index + i + 1}. ${d.day !== plan.date ? d.day + ' ' : ''}${d.time} — ${d.station || plan.origin} → ${d.destination || plan.destination}`);
  return `Туту MCP: ${plan.origin} → ${plan.destination}, ${plan.date}\n` +
    rows.join('\n') + '\nИсточник: https://mcp.tutu.ru/mcp (расписание, не подтверждение задержек)' +
    (meta.complete === false ? '\n⚠️ Выдача неполная; возможны другие отправления.' : '');
}

export async function lookupTransit(fetchFn, plan, nowSec, { deadlineMs = 6500, pulse } = {}) {
  if (!TUTU_SEARCH_TOOLS.includes(plan.kind)) return { found: false, unsupported: true };
  const promise = callTutuTool(fetchFn, plan.kind, plan);
  promise.catch(() => {}); // timeout does not guarantee remote cancellation
  try {
    const data = deadlineMs && pulse ? await withDeadline(promise, deadlineMs, pulse) : await promise;
    if (data === TIMED_OUT) return { slow: true };
    const departures = normalizeDepartures(data, plan, nowSec);
    const index = Math.max(0, Math.min(20, Number(plan.offset) || 0));
    return { text: formatTransitResponse(data, plan, nowSec), found: departures.length > index };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 140) };
  }
}
