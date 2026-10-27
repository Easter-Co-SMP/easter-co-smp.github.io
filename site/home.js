// The cinematic arrival belongs only to the homepage. Content remains usable without JS.
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
const skipArrival=document.querySelector('.skip-arrival');
let arrivalTimer;
const finishArrival=()=>{
 document.body.classList.remove('is-arriving');
 // Desktop mode removes the control; the bounded timer and Escape still finish the arrival.
 if(skipArrival)skipArrival.hidden=true;
 clearTimeout(arrivalTimer);
};
// The arrival is the launcher's opening moment, not a page transition. The top bar's Home link
// is a real navigation (`href="./"`), so switching Map -> Home reloads this document and used to
// replay the whole approach. One mark per window session fixes that without touching the
// website, where an arrival per visit is the intended behaviour: sessionStorage survives
// same-window navigations and dies with the window, and window.name is the fallback for a
// context where storage is unavailable.
const ARRIVAL_MARK='easter-arrival-shown';
const desktopMode=window.easterDesktop?.mode==='desktop';
const arrivalAlreadyPlayed=()=>{
 let stored=false;
 try{stored=sessionStorage.getItem(ARRIVAL_MARK)==='1';}catch{}
 if(stored)return true;
 return typeof window.name==='string'&&window.name.split(' ').includes(ARRIVAL_MARK);
};
const noteArrivalPlayed=()=>{
 try{sessionStorage.setItem(ARRIVAL_MARK,'1');}catch{}
 const parts=typeof window.name==='string'?window.name.split(' ').filter(part=>part&&part!==ARRIVAL_MARK):[];
 parts.push(ARRIVAL_MARK);
 window.name=parts.join(' ');
};
const beginArrival=()=>{
 if(motionPreference.matches)return;
 if(desktopMode&&arrivalAlreadyPlayed()){finishArrival();return;}
 noteArrivalPlayed();
 document.body.classList.add('is-arriving');
 if(skipArrival&&!window.easterDesktop)skipArrival.hidden=false;
 // Bounded reveal: never wait on a slow image or network request.
 arrivalTimer=setTimeout(finishArrival,4600);
 skipArrival?.addEventListener('click',()=>{finishArrival();document.querySelector('.map-link')?.focus({preventScroll:true});});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'||event.key==='Tab')finishArrival();});
 window.addEventListener('pagehide',finishArrival,{once:true});
};
// A SIGN-IN THAT CAME BACK TO THIS PAGE DOES NOT START THE ARRIVAL UNDER ITS OWN SPLASH. The site
// root's head script sets `data-signed-in` when `?signed-in=1` arrived (site/index.html), and that
// attribute hides this whole page behind the splash. It hands the page back by removing the
// attribute and dispatching `signed-in:settled`, which is where the arrival is due - so an ordinary
// tab gets its intro at the moment the splash goes, and a popup, which never settles, never starts
// one at all. An attribute already gone means the splash finished before this script ran.
if(document.documentElement.dataset.signedIn==='1')document.addEventListener('signed-in:settled',beginArrival,{once:true});
else if(window.easterDesktop?.mode==='desktop')window.addEventListener('desktop:startup-ready',beginArrival,{once:true});
else beginArrival();
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
 // The launcher drops the notes strip, so this write is optional rather than assumed.
 const worldDate=document.getElementById('home-world-date');if(worldDate)worldDate.textContent='World charted '+new Date(world.captured_at).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}).catch(()=>{});
