// The cinematic arrival belongs only to the homepage. Content remains usable without JS.
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
const skipArrival=document.querySelector('.skip-arrival');
let arrivalTimer;
const finishArrival=()=>{
 document.body.classList.remove('is-arriving');
 skipArrival.hidden=true;
 clearTimeout(arrivalTimer);
};
if(!motionPreference.matches){
 document.body.classList.add('is-arriving');
 skipArrival.hidden=false;
 // Bounded reveal: never wait on a slow image or network request.
 arrivalTimer=setTimeout(finishArrival,4600);
 skipArrival.addEventListener('click',()=>{finishArrival();document.querySelector('.map-link').focus({preventScroll:true});});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'||event.key==='Tab')finishArrival();});
 window.addEventListener('pagehide',finishArrival,{once:true});
}
motionPreference.addEventListener('change',event=>{if(event.matches)finishArrival();});
const guide=document.getElementById('guide-dialog');
document.getElementById('open-guide').onclick=()=>guide.showModal();
document.getElementById('close-guide').onclick=()=>guide.close();
guide.addEventListener('click',event=>{const r=guide.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)guide.close();});
document.getElementById('copyright-year').textContent=new Date().getFullYear();
// Small camera drift gives the opening scene depth; static for reduced-motion users.
if(!motionPreference.matches){
 let pointerX=0,pointerY=0,frame=null;
 const renderScene=()=>{frame=null;if(motionPreference.matches)return;document.documentElement.style.setProperty('--scene-x',pointerX+'px');document.documentElement.style.setProperty('--scene-y',(pointerY-Math.min(scrollY*.06,40))+'px');};
 const scheduleScene=()=>{if(frame===null)frame=requestAnimationFrame(renderScene);};
 window.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;pointerX=(e.clientX/innerWidth-.5)*-12;pointerY=(e.clientY/innerHeight-.5)*-8;scheduleScene();},{passive:true});
 window.addEventListener('scroll',scheduleScene,{passive:true});
}
fetch('data/client.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(client=>{
 document.getElementById('mod-version').textContent='v'+client.mod.version+' · Fabric';
 document.getElementById('minecraft-version').textContent='Minecraft '+client.minecraft;
 const list=document.getElementById('dependency-list');list.replaceChildren();
 for(const mod of client.dependencies){
  const li=document.createElement('li'),a=document.createElement('a');a.href=mod.url;a.textContent=mod.name+' · '+mod.version;a.target='_blank';a.rel='noopener';li.append(a);list.append(li);
 }
}).catch(()=>{});
fetch('data/world.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(world=>{
 document.getElementById('home-world-date').textContent='World charted '+new Date(world.captured_at).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}).catch(()=>{});
