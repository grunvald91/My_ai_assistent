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

const rail = (station) => /поезд|электричк|suburban|train/i.test(String(station.transport_type ?? ''));
const stationCode = (item) => String(item?.codes?.yandex_code ?? '');
const isValidCode = (value) => /^[sc]\d{1,12}$/.test(String(value ?? ''));

export function resolveRussianStation(catalog, name) {
  const query = normalized(name);
  if (!query) return { error: 'empty' };
  if (CODES[query]) return { code: CODES[query], title: query };
  const found = [];
  for (const country of catalog?.countries ?? []) {
    if (normalized(country.title) !== 'россия') continue;
    for (const region of country.regions ?? []) {
      for (const city of region.settlements ?? []) {
        if (normalized(city.title) === query && isValidCode(stationCode(city))) {
          found.push({ code: stationCode(city), title: city.title, region: region.title, score: 10 });
        }
        for (const st of city.stations ?? []) {
          if (!rail(st) || normalized(st.title) !== query) continue;
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
    const expected = plan.kind === 'search_rail' ? 'train' : 'suburban';
    if (!segment || segment.has_transfers || segment.thread?.transport_type !== expected) continue;
    const departure = String(segment.departure ?? '');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(departure)) continue;
    if (departure.slice(0, 10) !== plan.date) continue;
    const timestamp = Date.parse(departure);
    if (!Number.isFinite(timestamp) || timestamp < nowSec * 1000) continue;
    valid.push({ timestamp, departure: departure.slice(11, 16),
      from: safeName(segment.from?.title || fromTitle || plan.origin),
      to: safeName(segment.to?.title || toTitle || plan.destination),
      number: safeName(segment.thread?.number ?? '').slice(0, 20) });
  }
  valid.sort((a,b)=>a.timestamp-b.timestamp);
  const offset = Math.max(0, Math.min(20, Number(plan.offset)||0));
  const chosen = valid.slice(offset, offset+3);
  if (!chosen.length) return { found: false, count: valid.length };
  const rows=chosen.map((s,i)=>String(offset+i+1)+'. '+s.departure+' — '+s.from+' → '+s.to+(s.number ? ' (№ '+s.number+')' : ''));
  return {
    found: true, count: valid.length,
    text:'Яндекс Расписания: '+safeName(plan.origin)+' → '+safeName(plan.destination)+', '+plan.date+'\n' +
      (normalized(plan.destination)==='красная поляна' ? 'Ближайшая ж/д станция направления: Роза Хутор.\n' : '')+
      rows.join('\n')+'\nДанные предоставлены сервисом Яндекс.Расписания: '+YANDEX_RASP_SITE+
      '\nВремя местное для станции отправления. Проверь изменения перед поездкой.',
  };
}

export async function lookupYandexRasp(fetchFn, key, plan, nowSec) {
  if (!key) return { found: false, unavailable: 'key', text: yandexFallbackNotice(plan, 'Ключ Яндекс Расписаний ещё не подключён.') };
  try {
    let from = CODES[normalized(plan.origin)] ? {code:CODES[normalized(plan.origin)]} : null;
    let to = CODES[normalized(plan.destination)] ? {code:CODES[normalized(plan.destination)]} : null;
    if (!from || !to) {
      // Do not commit/store the catalog: only transient in-memory resolution.
      const catalog = await readJson(fetchFn, key, 'stations_list/');
      if (!from) from = resolveRussianStation(catalog, plan.origin);
      if (!to) to = resolveRussianStation(catalog, plan.destination);
    }
    if (!from?.code || !to?.code) {
      const unresolved = !from?.code ? from : to;
      const place = !from?.code ? plan.origin : plan.destination;
      return { found: false, unavailable: 'station',
        text: yandexFallbackNotice(plan, 'Яндекс не смог однозначно определить станцию «'+safeName(place)+'»'+
          (unresolved?.error==='ambiguous' ? '. Уточни область или конкретный вокзал.' : '.') ) };
    }
    const base = { from:from.code, to:to.code, date:plan.date, transport_types: plan.kind==='search_rail'?'train':'suburban', transfers:'false', limit:'100' };
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
    if (response.found) return response;
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
