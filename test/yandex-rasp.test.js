import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupYandexRasp, lookupRussianTransit, resolveRussianStation,
  formatYandexRasp, yandexTimetableLink, YANDEX_RASP_API,
} from '../tgcloud/lib/yandex-rasp.js';

const plan = { origin:'Адлер',destination:'Красная Поляна',kind:'search_etrain',date:'2026-11-04',offset:0,timezoneHours:3 };
const now = Date.parse('2026-11-04T08:00:00+03:00')/1000;
const segment = (departure, kind = 'suburban')=>({
  departure, from:{title:'Адлер',code:'s9613054'},
  to:{title:'Роза Хутор',code:'s9812791'},
  thread:{transport_type:kind,number:'6103'},
  has_transfers:false,
});
const response = (body,status=200)=>({ok:status<400,status,json:async()=>body});
const sampleCatalog={countries:[{title:'Россия',regions:[{title:'Тульская область',
  settlements:[{title:'Тула',codes:{yandex_code:'c1513'},stations:[
    {title:'Тула-1-Курская',transport_type:'Поезд',codes:{yandex_code:'s12345'}},
  ]}]}]},{title:'Франция',regions:[{title:'Париж',settlements:[{title:'Тула',codes:{yandex_code:'c999'}}]}]}]};

test('Яндекс без API ключа: проверенный сайт вместо выдуманного расписания',async()=>{
  let calls=0;
  const result=await lookupYandexRasp(()=>{calls++;throw Error('unexpected');},'',plan,now);
  assert.equal(result.found,false);
  assert.equal(calls,0);
  assert.match(result.text,/API пока|Ключ Яндекс/);
  assert.match(result.text,/rasp\.yandex\.ru\/suburban\/adler-station--rosa-khutor/);
  assert.equal(yandexTimetableLink({...plan,destination:'Роза Хутор'}),yandexTimetableLink(plan));
});

test('Яндекс: на Адлер — Красная Поляна корректно ищем станцию Роза Хутор, фильтруем сегодняшние будущие электрички',async()=>{
  const requests=[];
  const fetchFn=async(url,opts)=>{
    const u=new URL(url);
    requests.push({url:u,opts});
    assert.equal(opts.headers.Authorization,'test-key');
    assert.equal(u.host,'api.rasp.yandex-net.ru');
    assert.ok(u.pathname.endsWith('/search/'),'известные станции не требуют скачивания 40 МБ справочника');
    assert.equal(u.searchParams.get('from'),'s9613054');
    assert.equal(u.searchParams.get('to'),'s9812791');
    assert.equal(u.searchParams.get('transport_types'),'suburban');
    assert.equal(u.searchParams.get('transfers'),'false');
    return response({segments:[
      segment('2026-11-04T07:10:00+03:00'),
      segment('2026-11-04T09:10:00+03:00'),
      segment('2026-11-04T10:30:00+03:00','train'),
      segment('2026-11-05T09:10:00+03:00'),
      {...segment('2026-11-04T09:20:00+03:00'),has_transfers:true},
    ],pagination:{total:5}});
  };
  const r=await lookupYandexRasp(fetchFn,'test-key',plan,now);
  assert.equal(requests.length,1);
  assert.equal(r.found,true);
  assert.match(r.text,/09:10/);
  assert.doesNotMatch(r.text,/07:10|10:30|09:20/);
  assert.match(r.text,/Ближайшая ж\/д станция направления: Роза Хутор/);
  assert.match(r.text,/Данные предоставлены сервисом Яндекс\.Расписания/);
});

test('Яндекс: другие регионы РФ разрешаются через официальный справочник, без зашитых маршрутов',async()=>{
  const calls=[];
  const fetchFn=async(url,opts)=>{
    const u=new URL(url);
    calls.push(u.pathname);
    if(u.pathname.endsWith('/stations_list/')) return response(sampleCatalog);
    assert.equal(u.searchParams.get('from'),'c1513');
    assert.equal(u.searchParams.get('to'),'c1513');
    return response({segments:[{...segment('2026-11-04T11:00:00+03:00'),from:{title:'Тула'},to:{title:'Тула'}}],pagination:{total:1}});
  };
  const p={...plan,origin:'Тула',destination:'Тула'};
  const r=await lookupYandexRasp(fetchFn,'test-key',p,now);
  assert.equal(r.found,true);
  assert.deepEqual(calls,['/v3.0/stations_list/','/v3.0/search/']);
  assert.equal(resolveRussianStation(sampleCatalog,'Тула').code,'c1513');
});

test('Яндекс: одинаковые станции в разных регионах нельзя выбирать наугад',()=>{
  const catalog={countries:[{title:'Россия',regions:[
    {title:'Калужская область',settlements:[{title:'А',stations:[{title:'Лесная',transport_type:'Электричка',codes:{yandex_code:'s101'}}]}]},
    {title:'Тверская область',settlements:[{title:'Б',stations:[{title:'Лесная',transport_type:'Электричка',codes:{yandex_code:'s202'}}]}]},
  ]}]};
  assert.equal(resolveRussianStation(catalog,'Лесная').error,'ambiguous');
});

test('Яндекс: пустой список или ошибка API не означает, что электричек нет',async()=>{
  const empty=await lookupYandexRasp(async()=>response({segments:[],pagination:{total:0}}),'key',plan,now);
  assert.equal(empty.found,false);
  assert.match(empty.text,/не удалось подтвердить автоматически/);
  const fail=await lookupYandexRasp(async()=>response({},503),'key',plan,now);
  assert.equal(fail.found,false);
  assert.match(fail.text,/HTTP 503/);
  assert.match(fail.text,/rasp\.yandex\.ru/);
});

test('Tutu с подтверждённым отправлением остаётся первым, Яндекс не вызывается',async()=>{
  const calls=[];
  const provider=async(url,opts)=>{
    calls.push(url);
    assert.ok(url.startsWith('https://mcp.tutu.ru/mcp'),'Яндекс не должен вызываться при нормальном ответе Туту');
    const msg=JSON.parse(opts.body);
    if(msg.method==='initialize') return response({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-11-25'}});
    if(msg.method==='notifications/initialized') return {ok:true,status:202};
    return response({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:JSON.stringify({
      offers:[{departure_at:'2026-11-04T09:20:00+03:00',from:{name:'Адлер'},to:{name:'Красная Поляна'}}],
      meta:{complete:true}
    })}]}});
  };
  const r=await lookupRussianTransit(provider,'yandex-key',plan,now,{deadlineMs:0});
  assert.equal(r.found,true);
  assert.equal(r.source,'tutu');
  assert.equal(calls.length,3);
});

test('Tutu пуст, Яндекс отвечает: резерв даёт подтверждённое отправление',async()=>{
  const calls=[];
  const provider=async(url,opts)=>{
    calls.push(url);
    const u=new URL(url);
    assert.ok(u.pathname.endsWith('/search/'));
    return response({segments:[segment('2026-11-04T09:10:00+03:00')],pagination:{total:1}});
  };
  const r=await lookupRussianTransit(provider,'test-key',{...plan,skipTutu:true},now);
  assert.equal(r.found,true);
  assert.equal(r.source,'yandex');
  assert.equal(calls.length,1);
  assert.match(r.text,/09:10/);
});

test('Формат API не должен выводить рейс с неверной датой или без проверенного времени',()=>{
  const r=formatYandexRasp({segments:[
    segment('2026-11-05T09:00:00+03:00'),segment('примерное время'),
    segment('2026-11-04T10:10:00+03:00'),
  ]},plan,now);
  assert.equal(r.found,true);
  assert.equal(r.count,1);
  assert.match(r.text,/10:10/);
  assert.doesNotMatch(r.text,/09:00/);
});
