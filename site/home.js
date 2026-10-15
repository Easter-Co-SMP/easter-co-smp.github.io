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
document.getElementById('copyright-year').textContent=new Date().getFullYear();
// Small camera drift gives the opening scene depth; static for reduced-motion users.
if(!motionPreference.matches){
 let pointerX=0,pointerY=0,frame=null;
 const renderScene=()=>{frame=null;if(motionPreference.matches)return;document.documentElement.style.setProperty('--scene-x',pointerX+'px');document.documentElement.style.setProperty('--scene-y',(pointerY-Math.min(scrollY*.06,40))+'px');};
 const scheduleScene=()=>{if(frame===null)frame=requestAnimationFrame(renderScene);};
 window.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;pointerX=(e.clientX/innerWidth-.5)*-12;pointerY=(e.clientY/innerHeight-.5)*-8;scheduleScene();},{passive:true});
 window.addEventListener('scroll',scheduleScene,{passive:true});
}
fetch('data/world.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(world=>{
 document.getElementById('home-world-date').textContent='World charted '+new Date(world.captured_at).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}).catch(()=>{});
