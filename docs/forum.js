const CATEGORIES=[
 ["Новости проекта","Официальные обновления, объявления и важные изменения.","updates"],
 ["Правила","Правила проекта, регламенты и вопросы по их применению.","rules"],
 ["Государственные структуры","Обсуждение государственных организаций и их деятельности.","state"],
 ["УФСБ","Информация, обсуждения и материалы направления УФСБ.","fsb"],
 ["Армия","Военная служба, подразделения, заявки и внутренние вопросы.","army"],
 ["Правоохранительные органы","Полиция и другие правоохранительные направления.","police"],
 ["Бизнес","Предприятия, экономика, вакансии и игровые бизнес-ситуации.","business"],
 ["Транспорт","Автомобили, дороги, транспорт и связанные игровые темы.","transport"],
 ["Игровые обсуждения","Вопросы по игровому процессу, механикам и предложениям.","game"],
 ["Общение","Свободное общение сообщества.","chat"],
 ["Помощь","Технические вопросы, проблемы и помощь игрокам.","help"]
];
const seed=[
 {id:1,cat:"updates",title:"Добро пожаловать на форум SOSNOVKA RP",body:"Здесь будут публиковаться официальные новости и важные объявления проекта.",author:"SRP Team",date:"23.09.2026"},
 {id:2,cat:"game",title:"Предложения по развитию проекта",body:"Собираем идеи для будущих систем, локаций и игровых механик.",author:"Community",date:"23.09.2026"},
 {id:3,cat:"help",title:"Вопросы по проекту",body:"Если возникла проблема, опиши её максимально подробно.",author:"SRP Team",date:"23.09.2026"}
];
const key="srp_forum_threads_v2";
let threads=JSON.parse(localStorage.getItem(key)||"null")||seed;
const grid=document.getElementById("forumGrid"), filter=document.getElementById("forumFilter"), search=document.getElementById("forumSearch");
const catMap=Object.fromEntries(CATEGORIES.map(c=>[c[2],c]));
CATEGORIES.forEach(c=>{filter.insertAdjacentHTML("beforeend",`<option value="${c[2]}">${c[0]}</option>`);document.getElementById("threadCategory").insertAdjacentHTML("beforeend",`<option value="${c[2]}">${c[0]}</option>`);});
function save(){localStorage.setItem(key,JSON.stringify(threads))}
function render(){
 const q=search.value.trim().toLowerCase(), f=filter.value;
 const counts=Object.fromEntries(CATEGORIES.map(c=>[c[2],0]));
 threads.forEach(t=>counts[t.cat]=(counts[t.cat]||0)+1);
 const cats=CATEGORIES.filter(c=>(f==="all"||c[2]===f)&&(!q||c[0].toLowerCase().includes(q)||c[1].toLowerCase().includes(q)||threads.some(t=>t.cat===c[2]&&(`${t.title} ${t.body}`).toLowerCase().includes(q))));
 grid.innerHTML=cats.map(c=>`<article class="forum-category" data-cat="${c[2]}"><span class="section-kicker">${String(CATEGORIES.indexOf(c)+1).padStart(2,"0")}</span><h3>${c[0]}</h3><p>${c[1]}</p><div class="forum-meta"><span>${counts[c[2]]||0} тем</span><span>ОТКРЫТЬ →</span></div></article>`).join("");
 const matches=threads.filter(t=>(f==="all"||t.cat===f)&&(!q||`${t.title} ${t.body} ${catMap[t.cat]?.[0]||""}`.toLowerCase().includes(q)));
 if(matches.length) grid.insertAdjacentHTML("beforeend",`<div class="thread-list">${matches.slice(0,20).map(t=>`<div class="thread-item" data-thread="${t.id}"><b>${esc(t.title)}</b><small>${catMap[t.cat]?.[0]||"Форум"} · ${esc(t.author)} · ${esc(t.date)}</small></div>`).join("")}</div>`);
 if(!cats.length&&!matches.length)grid.innerHTML=`<div class="forum-note">По вашему запросу ничего не найдено.</div>`;
 document.querySelectorAll(".forum-category").forEach(x=>x.onclick=()=>{filter.value=x.dataset.cat;render();document.getElementById("forum").scrollIntoView({behavior:"smooth"});});
 document.querySelectorAll(".thread-item").forEach(x=>x.onclick=()=>openThread(Number(x.dataset.thread)));
}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function openThread(id){const t=threads.find(x=>x.id===id);if(!t)return;document.getElementById("threadView").innerHTML=`<div class="section-kicker">${esc(catMap[t.cat]?.[0]||"ФОРУМ")}</div><h2>${esc(t.title)}</h2><p class="thread-body">${esc(t.body)}</p><div class="forum-meta"><span>${esc(t.author)}</span><span>${esc(t.date)}</span></div>`;openModal("viewModal")}
function openModal(id){document.getElementById(id).classList.add("open");document.getElementById(id).setAttribute("aria-hidden","false")}
function closeModals(){document.querySelectorAll(".modal").forEach(m=>{m.classList.remove("open");m.setAttribute("aria-hidden","true")})}
document.querySelectorAll("[data-close]").forEach(x=>x.onclick=closeModals);
document.getElementById("newThreadBtn").onclick=()=>openModal("threadModal");
document.getElementById("threadForm").onsubmit=e=>{e.preventDefault();const title=document.getElementById("threadTitle").value.trim(),body=document.getElementById("threadBody").value.trim(),cat=document.getElementById("threadCategory").value;if(!title||!body)return;threads.unshift({id:Date.now(),cat,title,body,author:"Вы",date:new Date().toLocaleDateString("ru-RU")});save();e.target.reset();closeModals();render();document.getElementById("forum").scrollIntoView({behavior:"smooth"});}
search.oninput=render;filter.onchange=render;render();

const obs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)e.target.classList.add("visible")}),{threshold:.12});
document.querySelectorAll(".reveal").forEach(e=>obs.observe(e));
document.querySelectorAll("[data-count]").forEach(el=>{let done=false;const o=new IntersectionObserver(es=>{if(es[0].isIntersecting&&!done){done=true;let n=+el.dataset.count,c=0,step=Math.max(1,Math.ceil(n/35));const i=setInterval(()=>{c=Math.min(n,c+step);el.textContent=c;if(c>=n)clearInterval(i)},30);o.disconnect()}});o.observe(el)});
const nav=document.getElementById("nav"),menu=document.getElementById("menuBtn");menu.onclick=()=>nav.classList.toggle("open");nav.querySelectorAll("a").forEach(a=>a.onclick=()=>nav.classList.remove("open"));
const progress=document.getElementById("progress"),topbar=document.getElementById("topbar");
addEventListener("scroll",()=>{const h=document.documentElement.scrollHeight-innerHeight;progress.style.width=(scrollY/Math.max(1,h)*100)+"%";topbar.classList.toggle("scrolled",scrollY>20)},{passive:true});
const glow=document.getElementById("cursorGlow");addEventListener("pointermove",e=>{glow.style.left=e.clientX+"px";glow.style.top=e.clientY+"px"},{passive:true});
addEventListener("keydown",e=>{if(e.key==="Escape")closeModals()});
