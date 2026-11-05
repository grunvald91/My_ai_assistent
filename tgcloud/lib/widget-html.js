// Telegram Bot API 10.4 HTMLBubble. Source is immutable; only chat_data changes.
// No external resources, no user data in HTML/public_data; forwarded copies
// cannot see private state. Keep under 32 KB HTML / 4 KB zlib-compressed.
export const ASSISTANT_WIDGET_HTML = String.raw\`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{margin:0;padding:12px;color:var(--tg-theme-text-color);font-family:system-ui,sans-serif;font-size:14px}
h3{margin:0;font-size:17px;font-weight:700}
small,.muted{color:var(--tg-theme-hint-color);font-size:12px}
.head,.between{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mark{color:var(--tg-theme-accent-text-color);font-weight:700;font-size:11px}
.bar{height:5px;border-radius:8px;background:var(--tg-theme-secondary-bg-color);overflow:hidden;margin:12px 0}
.fill{height:100%;background:var(--tg-theme-button-color);border-radius:8px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
button{cursor:pointer;border:0;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);border-radius:10px;padding:11px 10px;font-size:13px;text-align:left;font-family:inherit;min-height:39px}
button:disabled{opacity:.55}
button.primary{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-weight:600}
.row{display:flex;gap:8px;margin-top:8px}
.row button{flex:1;text-align:center}
.task{display:flex;gap:10px;align-items:center;width:100%;margin-top:6px;overflow-wrap:anywhere}
.task .tick{flex:none;width:20px;height:20px;border:1px solid var(--tg-theme-hint-color);border-radius:6px;display:flex;align-items:center;justify-content:center}
.task.done{opacity:.66;text-decoration:line-through}
.task.done .tick{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);border:0}
.fact{background:var(--tg-theme-secondary-bg-color);border-radius:8px;padding:9px;margin-top:6px;overflow-wrap:anywhere}
.notice{font-size:12px;color:var(--tg-theme-hint-color);margin:9px 0}
.status{font-size:12px;margin-top:8px;color:var(--tg-theme-accent-text-color)}
</style></head><body><div id="app"></div>
<script>
(function(){
var tw=window.TelegramWidget,root=document.getElementById('app'),current=null,busy=false,error='';
function parse(s){try{var x=JSON.parse(s);return x&&typeof x==='object'?x:null}catch(e){return null}}
function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)x.textContent=String(txt);return x}
function put(parent,tag,cls,txt){var x=el(tag,cls,txt);parent.appendChild(x);return x}
function action(label,cmd,style){var b=el('button',style||'',label);b.disabled=busy||!cmd;b.addEventListener('click',function(){
if(busy)return;busy=true;error='';paint();
tw.request(cmd).then(function(ans){
var next=parse(ans.result);if(next)current=next;else error='Не удалось обновить карточку';
busy=false;paint();
},function(e){busy=false;error='Ошибка связи: '+(e.code||'повтори действие');paint()});
});return b}
function buttons(container,defs,cls){var row=put(container,'div',cls||'row');defs.forEach(function(x){row.appendChild(action(x[0],x[1],x[2]))})}
function nav(container,back){buttons(container,[['← Панель','w:home'],['↻ Обновить',back]],'row')}
function paint(){
root.innerHTML='';
if(!current){put(root,'h3','','My AI Assistant');put(root,'p','muted','Личная панель доступна в чате с ботом.');return}
var h=put(root,'div','head');put(h,'h3','',current.k==='home'?'✦ Моя панель':current.k==='tasks'?'✓ Задачи':current.k==='memory'?'◈ Память':current.k==='calendar'?'▣ Календарь':current.k==='routes'?'⇄ Маршруты':'◉ Агент');
put(h,'span','mark','AI ASSISTANT');
if(current.k==='home'){
put(root,'p','muted','Задачи и память · данные обновляются на сервере');
put(root,'div','','Задачи: '+current.d+'/'+current.n+' выполнено');
var bar=put(root,'div','bar');var fill=put(bar,'div','fill');fill.style.width=(current.n?Math.round(current.d*100/current.n):0)+'%';
put(root,'div','muted','Сохранённых фактов: '+current.m);
buttons(root,[['✓ Задачи','w:tasks:0'],['◈ Память','w:memory'],['▣ Календарь','w:calendar'],['⇄ Маршруты','w:routes'],['◉ Агент','w:agent'],['↻ Обновить','w:home']],'tiles');
}else if(current.k==='tasks'){
put(root,'p','muted','Выполнено '+current.d+' из '+current.n);
var items=current.items||[];
if(!items.length)put(root,'p','notice','Пока нет задач. Добавьте первую.');
items.forEach(function(t){
var b=el('button','task'+(t.d?' done':''));
var square=el('span','tick',t.d?'✓':'');
b.appendChild(square);b.appendChild(el('span','',t.t));
b.disabled=busy;b.addEventListener('click',function(){
if(busy)return;busy=true;error='';paint();
tw.request('w:toggle:'+current.rev+':'+t.i+':'+current.page).then(function(ans){current=parse(ans.result)||current;busy=false;paint()},function(e){busy=false;error='Ошибка: '+(e.code||'повтори');paint()});
});
root.appendChild(b)});
if(current.pages>1)buttons(root,[['←',current.page>0?'w:tasks:'+(current.page-1):null],[(current.page+1)+'/'+current.pages,'w:tasks:'+current.page],['→',current.page+1<current.pages?'w:tasks:'+(current.page+1):null]],'row');
buttons(root,[['+ Добавить задачу','w:add','primary']],'row');
nav(root,'w:tasks:'+current.page);
}else if(current.k==='memory'){
put(root,'p','muted','Сохранено фактов: '+current.m);
(current.facts||[]).forEach(function(x){put(root,'div','fact',x)});
put(root,'p','notice','Добавить: /remember текст. Удалить: /forget номер');
nav(root,'w:memory');
}else{
put(root,'p','notice',current.info||'Раздел ещё не подключён');
nav(root,'w:'+current.k);
}
if(current.note)put(root,'p','status',current.note);
if(error)put(root,'p','status',error);
}
current=parse(tw.chatData);
tw.onEvent('chatDataChanged',function(){current=parse(tw.chatData)||current;paint()});
paint();tw.ready();
})();
</script></body></html>\`;
