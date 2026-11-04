import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, OWNER } from './helpers/world.js';
import { isTransitCandidate, understandTransitQuestion, callTutuTool } from '../tgcloud/lib/transit.js';
import { resolveRussianStation, yandexTransportType, formatYandexRasp, lookupYandexRasp } from '../tgcloud/lib/yandex-rasp.js';

const isoSoon=(w)=>new Date((w.now+3600)*1000).toISOString();

test('Автобус Москва — Тверь: ИИ выбирает search_bus, Tutu получает взрослых, не passengers', async()=>{
  const w=await createWorld();
  w.tutuReply={offers:[{departure_at:isoSoon(w),from:{name:'Москва'},to:{name:'Тверь'}}],meta:{complete:true}};
  await w.say('Покажи междугородние автобусы на завтра из Москвы в Тверь');
  const args=w.tutuCalls.find(m=>m.method==='tools/call');
  assert.ok(args);
  assert.equal(args.params.name,'search_bus');
  assert.equal(args.params.arguments.adults,1);
  assert.equal(args.params.arguments.passengers,undefined);
  assert.equal(args.params.arguments.departure_date,'2027-01-16');
  assert.equal(w.llmCalls.length,1);
});

test('Авиарейс Москва — Сочи: ИИ вызывает search_avia, время может прийти только от Tutu',async()=>{
  const w=await createWorld();
  w.tutuReply={offers:[{departure_at:isoSoon(w),from:{name:'Москва'},to:{name:'Сочи'}}],meta:{complete:true}};
  await w.say('Какие самолёты летят сегодня из Москвы в Сочи?');
  assert.equal(w.tutuCalls.find(m=>m.method==='tools/call')?.params?.name,'search_avia');
  assert.match(w.last(OWNER).text,/Туту MCP: Москва → Сочи/);
});

test('Поиск вариантов разными видами транспорта вызывает отдельный поиск Tutu',async()=>{
  const w=await createWorld();
  w.tutuReply={offers:[],meta:{complete:true}};
  await w.say('Как добраться из Москвы в Казань разным транспортом завтра?');
  const call=w.tutuCalls.find(m=>m.method==='tools/call');
  assert.equal(call?.params?.name,'search_multitransport');
  assert.equal(call?.params?.arguments?.optimize_for,'time');
  assert.equal(call?.params?.arguments?.sort,undefined);
  assert.match(w.last(OWNER).text,/rasp\.yandex\.ru/);
});

test('Следующий автобус сохраняет автобусный тип и маршрут',async()=>{
  const w=await createWorld();
  w.tutuReply={offers:[{departure_at:isoSoon(w),from:{name:'Москва'},to:{name:'Тверь'}}],meta:{complete:true}};
  await w.say('Покажи автобусы сегодня из Москвы в Тверь');
  await w.say('А следующий?');
  assert.equal(w.tutuCalls.filter(m=>m.method==='tools/call').length,2);
  assert.equal(w.tutuCalls.filter(m=>m.method==='tools/call').at(-1).params.name,'search_bus');
});

test('Вопрос «почему самолёт летает» не запускает транзитный поиск',()=>{
  assert.equal(isTransitCandidate('Почему самолёт летает?',null,1800000000),false);
  assert.equal(isTransitCandidate('Покажи расписание автобусов из Москвы в Тверь',null,1800000000),true);
});

test('Неизвестный транспорт нельзя незаметно подменить электричкой',async()=>{
 const intent=await understandTransitQuestion('Когда паром из Сочи в Крым?',null,1800000000,3,async()=>JSON.stringify({
   intent:'schedule',origin:'Сочи',destination:'Крым',date:'today',mode:'water',next:false,
 }));
 assert.equal(intent.plan.kind,'search_water');
 assert.equal(intent.plan.modes[0],'water');
});

test('Официальный справочник Яндекса различает автовокзал и аэропорт',()=>{
 const catalog={countries:[{title:'Россия',regions:[{title:'Московская область',
   settlements:[{title:'Городок',codes:{yandex_code:'c130'},stations:[
     {title:'Аэропорт',transport_type:'Самолёт',codes:{yandex_code:'s111'}},
     {title:'Аэропорт',transport_type:'Автобус',codes:{yandex_code:'s222'}},
   ]}]}]}]};
 assert.equal(resolveRussianStation(catalog,'Аэропорт','search_avia').code,'s111');
 assert.equal(resolveRussianStation(catalog,'Аэропорт','search_bus').code,'s222');
 assert.equal(resolveRussianStation(catalog,'Городок','search_bus').code,'c130');
 assert.equal(yandexTransportType('search_bus'),'bus');
 assert.equal(yandexTransportType('search_avia'),'plane');
});

test('Яндекс рейс: прибытие, длительность, перевозчик и запрос деталей thread',async()=>{
 const p={origin:'Адлер',destination:'Роза Хутор',kind:'search_etrain',date:'2027-01-15',details:true,offset:0};
 const now=Date.parse('2027-01-15T08:00:00+03:00')/1000;
 const segment={departure:'2027-01-15T09:10:00+03:00',arrival:'2027-01-15T10:15:00+03:00',duration:3900,
   has_transfers:false,from:{title:'Адлер',code:'s9613054'},to:{title:'Роза Хутор',code:'s9812791'},
   thread:{transport_type:'suburban',number:'6103',uid:'6103_demo',carrier:{title:'Перевозчик'}}};
 const paths=[];
 const fetchFn=async(url,opts)=>{const u=new URL(url);paths.push(u.pathname);
   assert.equal(opts.headers.Authorization,'test-key');
   if(u.pathname.endsWith('/search/'))return {ok:true,json:async()=>({segments:[segment],pagination:{total:1}})};
   assert.equal(u.searchParams.get('uid'),'6103_demo');
   return {ok:true,json:async()=>({stops:[
     {station:{title:'Адлер'},departure:'2027-01-15T09:10:00+03:00'},
     {station:{title:'Эсто-Садок'},arrival:'2027-01-15T09:50:00+03:00',departure:'2027-01-15T09:52:00+03:00'},
     {station:{title:'Роза Хутор'},arrival:'2027-01-15T10:15:00+03:00'},
   ]})};
 };
 const r=await lookupYandexRasp(fetchFn,'test-key',p,now);
 assert.equal(r.found,true);
 assert.deepEqual(paths,['/v3.0/search/','/v3.0/thread/']);
 assert.match(r.text,/прибытие 10:15/);
 assert.match(r.text,/в пути 1 ч 5 мин/);
 assert.match(r.text,/Перевозчик/);
 assert.match(r.text,/Эсто-Садок/);
 assert.match(r.text,/Данные предоставлены сервисом Яндекс\.Расписания/);
});
