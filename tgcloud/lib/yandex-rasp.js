// Yandex Timetables fallback. Uses the official API, never scrapes public pages.
// API terms: public/free projects only unless separately licensed; mandatory attribution.
// Its station catalog is ~40 MB: load only in GitHub Actions if a station code is unknown.
import { lookupTransit } from './transit.js';

export const YANDEX_RASP_API = 'https://api.rasp.yandex-net.ru/v3.0/';
export const YANDEX_RASP_SITE = 'https://rasp.yandex.ru/';
// Exact station codes verified against public Yandex Timetables search URLs.
// These are a fast path only. Other Russian stations use the official station catalog.
const CODES = {
  'адлер': 's9613054',
  'роза хутор': 's9812791',
  'красная поляна': 's9812791', // user means rail service to the Rosa Khutor terminal
};

const normalized = (value) => String(value ?? '').toLocaleLowerCase('ru-RU')
  .replace(/ё/g, 'е').replace(/^[\s]+|[\s]+$/g, '').replace(/\s+/g, ' ')
  .replace(/^(?:ж\/д\s+)?(?:станция|вокзал|город|г\.)\s+/i, '');
const safeName = (value) => String(value ?? '').replace(/[<>&]/g, '').slice(0, 100);

export function yandexTimetableLink(plan) {
  const a = normalized(plan?.origin);
  const b = normalized(plan?.destination);
  if (a === 'адлер' && (b === 'красная поляна' || b === 'роза хутор')) {
    return 'https://rasp.yandex.ru/suburban/adler-station--rosa-khutor';
  }
  if ((a === 'роза хутор' || a === 'красная поляна') && b === 'адлер') {
    return 'https://rasp.yandex.ru/all-transport/rosa-khutor--adler-krasnodar-krai';
  }
  return YANDEX_RASP_SITE;
}

export function yandexFallbackNotice(plan, reason = '') {
  const route = safeName(plan.origin) + ' → ' + safeName(plan.destination);
  const prefix = reason ? reason + '\n' : '';
  return prefix + 'Расписание ' + route + ' на ' + plan.date +
    ' не удалось подтвердить автоматически. Это не означает, что рейсов нет.\n' +
    'Проверь вручную в Яндекс Расписаниях: ' + yandexTimetableLink(plan);
}

const TRANSPORT = {
  search_etrain: 'suburban', search_rail: 'train', search_bus: 'bus',
  search_avia: 'plane', search_water: 'water', search_helicopter: 'helicopter',
  search_multitransport: '',
};
export const yandexTransportType = (kind) => TRANSPORT[kind] ?? null;
function stationSupportsType(item, kind) {
  const value = String(item.transport_type ?? '').toLowerCase();
  const types = {
    // Yandex catalog labels even suburban-capable railway stations as "Поезд"/"train". 
    // The suburban service is filtered in /search/, not in stations_list.
    search_etrain: /электричк|пригородн|suburban|поезд|train/i,
    search_rail: /поезд|train/i,
    search_bus: /автобус|bus/i,
    search_avia: /самол[её]т|plane/i,
    search_water: /водн|паром|морск|water|sea|river/i,
    search_helicopter: /вертол[её]т|helicopter/i,
  };
  return kind === 'search_multitransport' || (types[kind] ?? /./).test(value);
}
const stationCode = (item) => String(item?.codes?.yandex_code ?? '');
const isValidCode = (value) => /^[sc]\d{1,12}$/.test(String(value ?? ''));

export function resolveRussianStation(catalog, name, kind = 'search_etrain') {
  const query = normalized(name);
  if (!query) return { error: 'empty' };
  // Railway aliases are NOT safe for buses, planes or ferries.
  if (['search_etrain','search_rail'].includes(kind) && CODES[query]) {
    return { code: CODES[query], title: query };
  }
  const found = [];
  for (const country of catalog?.countries ?? []) {
    if (normalized(country.title) !== 'россия') continue;
    for (const region of country.regions ?? []) {
      for (const city of region.settlements ?? []) {
        if (normalized(city.title) === query && isValidCode(stationCode(city))) {
          found.push({ code: stationCode(city), title: city.title, region: region.title, score: ['search_avia','search_bus','search_multitransport'].includes(kind) ? 30 : 10 });
        }
        for (const st of city.stations ?? []) {
          if (!stationSupportsType(st, kind) || normalized(st.title) !== query) continue;
          if (isValidCode(stationCode(st))) found.push({
            code: stationCode(st), title: st.title, region: region.title, score: 20,
          });
        }
      }
    }
  }
  if (!found.length) return { error: 'not_found' };
  const priority = Math.max(...found.map(x => x.score));
  const candidates = [...new Map(found.filter(x=>x.score===priority).map(x=>[x.code,x])).values()];
  if (candidates.length !== 1) {
    return { error: 'ambiguous', regions: [...new Set(candidates.map(x=>x.region).filter(Boolean))].slice(0, 5) };
  }
  return candidates[0];
}

async function readJson(fetchFn, key, path, params = {}) {
  const url = YANDEX_RASP_API + path + '?' + new URLSearchParams({ format:'json', lang:'ru_RU', ...params });
  const response = await fetchFn(url, { method: 'GET', headers: { Authorization: key, Accept: 'application/json' } });
  if (!response.ok) throw new Error('Яндекс Расписания API HTTP ' + response.status);
  const json = await response.json();
  if (!json || typeof json !== 'object' || json.error || json.errors) {
    throw new Error('Яндекс Расписания API: некорректный ответ');
  }
  return json;
}

export function formatYandexRasp(data, plan, nowSec, { fromTitle, toTitle } = {}) {
  const entries = Array.isArray(data?.segments) ? data.segments : [];
  const valid = [];
  for (const segment of entries) {
    const expected = yandexTransportType(plan.kind);
    if (expected === null || !segment) continue;
    if (plan.kind !== 'search_multitransport' && (segment.has_transfers || segment.thread?.transport_type !== expected)) continue;
    if (plan.kind === 'search_multitransport' && !segment.thread && !segment.has_transfers) continue;
    const departure = String(segment.departure ?? '');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(departure)) continue;
    if (departure.slice(0, 10) !== plan.date) continue;
    const timestamp = Date.parse(departure);
    if (!Number.isFinite(timestamp) || timestamp < nowSec * 1000) continue;
    const arrival = String(segment.arrival ?? '');
    const duration = typeof segment.duration === 'number' && Number.isFinite(segment.duration) ? segment.duration : NaN;
    valid.push({ timestamp, departure: departure.slice(11, 16),
      from: safeName(segment.from?.title || fromTitle || plan.origin),
      to: safeName(segment.to?.title || toTitle || plan.destination),
      number: safeName(segment.thread?.number ?? '').slice(0, 20),
      carrier: safeName(segment.thread?.carrier?.title ?? ''),
      arrival: /^\d{4}-\d\d-\d\dT\d\d:\d\d:/.test(arrival)
        ? arrival.slice(11, 16) + (arrival.slice(0, 10) !== plan.date ? ' ('+arrival.slice(0, 10)+')' : '') : '',
      durationMin: Number.isFinite(duration) && duration >= 0 ? Math.round(duration/60) : null,
      transfers: segment.has_transfers === true, uid: String(segment.thread?.uid ?? '').slice(0, 100),
      fromCode: String(segment.from?.code ?? ''), toCode: String(segment.to?.code ?? ''),
    });
  }
  valid.sort((a,b)=>a.timestamp-b.timestamp);
  const offset = Math.max(0, Math.min(20, Number(plan.offset)||0));
  const chosen = valid.slice(offset, offset+3);
  if (!chosen.length) return { found: false, count: valid.length };
  const rows=chosen.map((s,i)=>String(offset+i+1)+'. '+s.departure+' — '+s.from+' → '+s.to+
    (s.arrival ? ', прибытие '+s.arrival : '')+
    (s.durationMin !== null ? ', в пути '+Math.floor(s.durationMin/60)+' ч '+(s.durationMin%60)+' мин' : '')+
    (s.number ? ' (№ '+s.number+')' : '')+
    (s.carrier ? ', '+s.carrier : '')+
    (s.transfers ? ' (с пересадкой)' : ''));
  return {
    found: true, count: valid.length, selected: chosen,
    text:'Яндекс Расписания: '+safeName(plan.origin)+' → '+safeName(plan.destination)+', '+plan.date+'\n' +
      (normalized(plan.destination)==='красная поляна' ? 'Ближайшая ж/д станция направления: Роза Хутор.\n' : '')+
      rows.join('\n')+'\nДанные предоставлены сервисом Яндекс.Расписания: '+YANDEX_RASP_SITE+
      '\nВремя местное для станции отправления. Проверь изменения перед поездкой.',
  };
}


function formatThreadDetails(thread) {
  if (!Array.isArray(thread?.stops) || !thread.stops.length) return '';
  const rows = thread.stops.slice(0, 12).map((stop) => {
    const name = safeName(stop?.station?.title ?? '');
    const arrival = typeof stop?.arrival === 'string' && /^\d{4}-\d\d-\d\dT/.test(stop.arrival)
      ? stop.arrival.slice(11, 16) : '';
    const departure = typeof stop?.departure === 'string' && /^\d{4}-\d\d-\d\dT/.test(stop.departure)
      ? stop.departure.slice(11, 16) : '';
    return name ? '• '+name+
      (arrival ? ' приб. '+arrival : '')+(departure ? ' отпр. '+departure : '') : '';
  }).filter(Boolean);
  return rows.length ? '\nОстановки по маршруту:\n'+rows.join('\n')+
    (thread.stops.length>12 ? '\n… и ещё '+(thread.stops.length-12)+' остановок.' : '') : '';
}


export async function lookupYandexRasp(fetchFn, key, plan, nowSec) {
  if (!key) return { found: false, unavailable: 'key', text: yandexFallbackNotice(plan, 'Ключ Яндекс Расписаний ещё не подключён.') };
  try {
    const knownRail = ['search_etrain','search_rail'].includes(plan.kind);
    let from = knownRail && CODES[normalized(plan.origin)] ? {code:CODES[normalized(plan.origin)]} : null;
    let to = knownRail && CODES[normalized(plan.destination)] ? {code:CODES[normalized(plan.destination)]} : null;
    if (!from || !to) {
      // Do not commit/store the catalog: only transient in-memory resolution.
      const catalog = await readJson(fetchFn, key, 'stations_list/');
      if (!from) from = resolveRussianStation(catalog, plan.origin, plan.kind);
      if (!to) to = resolveRussianStation(catalog, plan.destination, plan.kind);
    }
    if (!from?.code || !to?.code) {
      const unresolved = !from?.code ? from : to;
      const place = !from?.code ? plan.origin : plan.destination;
      return { found: false, unavailable: 'station',
        text: yandexFallbackNotice(plan, 'Яндекс не смог однозначно определить станцию «'+safeName(place)+'»'+
          (unresolved?.error==='ambiguous' ? '. Уточни область или конкретный вокзал.' : '.') ) };
    }
    const selectedTransport = yandexTransportType(plan.kind);
    if (selectedTransport === null) return {found:false,unavailable:'type',
      text:yandexFallbackNotice(plan, 'Неподдерживаемый тип транспорта.')};
    const base = { from:from.code, to:to.code, date:plan.date,
      ...(selectedTransport ? { transport_types:selectedTransport } : {}),
      transfers: plan.kind==='search_multitransport' ? 'true' : 'false', limit:'100' };
    const all = [];
    let total = 0;
    for (let i=0;i<3;i++) {
      const page = await readJson(fetchFn,key,'search/',{...base, offset:String(i*100)});
      if (!Array.isArray(page.segments)) throw new Error('API не вернул список рейсов');
      all.push(...page.segments);
      total = Number(page.pagination?.total || all.length);
      if (all.length >= total || page.segments.length < 100) break;
    }
    const response = formatYandexRasp({segments:all},plan,nowSec,{fromTitle:from.title,toTitle:to.title});
    if (response.found) {
      if (plan.details === true) {
        const best = response.selected?.[0];
        if (best?.uid && best.uid.length <= 100 && !/[\u0000-\u001f<>]/.test(best.uid)) {
          try {
            const thread = await readJson(fetchFn, key, 'thread/', {
              uid:best.uid, from:best.fromCode||from.code, to:best.toCode||to.code, date:plan.date,
            });
            response.text += formatThreadDetails(thread);
          } catch {
            response.text += '\nДетали остановок сейчас недоступны в API.';
          }
        } else response.text += '\nДля этого рейса API не вернул идентификатор подробного маршрута.';
      }
      delete response.selected;
      return response;
    }
    return {found:false, text:yandexFallbackNotice(plan, 'Яндекс API не вернул подтверждённых будущих отправлений по выбранным станциям.') };
  } catch (error) {
    return {found:false,unavailable:'api', text:yandexFallbackNotice(plan,
      'Яндекс API сейчас недоступен ('+String(error?.message??error).replace(/[<>]/g,'').slice(0,90)+').')};
  }
}

/** Primary Tutu, then licensed Yandex API, finally an honest site link. */
export async function lookupRussianTransit(fetchFn, yandexKey, plan, nowSec, tutuOptions = {}) {
  const first = plan.skipTutu ? { found:false } : await lookupTransit(fetchFn, plan, nowSec, tutuOptions);
  if (first.found) return { ...first, source:'tutu' };
  const second = await lookupYandexRasp(fetchFn, yandexKey, plan, nowSec);
  return { ...second, source: second.found?'yandex':'link', tutuError: first.error ?? null };
}
