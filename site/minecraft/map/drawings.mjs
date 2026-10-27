// Private browser annotations. Every point and stroke width is stored in world blocks.
import {project} from './geometry.mjs';
const TOOLS=['view','brush','eraser','line','square','rectangle','circle','triangle','diamond'];
const MAX_POINTS=100000;
export function vertices(shape){
 const [a,b]=shape.points;
 if(shape.tool==='brush'||shape.tool==='line')return shape.points;
 const [x,z]=a,[dx,dz]=[b[0]-x,b[1]-z];
 if(shape.tool==='circle'){
  const radius=Math.hypot(dx,dz);
  return Array.from({length:65},(_,i)=>[x+Math.cos(i*Math.PI/32)*radius,z+Math.sin(i*Math.PI/32)*radius]);
 }
 let ex=b[0],ez=b[1];
 if(shape.tool==='square'){const edge=Math.max(Math.abs(dx),Math.abs(dz));ex=x+(dx<0?-edge:edge);ez=z+(dz<0?-edge:edge);}
 if(shape.tool==='triangle')return [[(x+ex)/2,z],[ex,ez],[x,ez],[(x+ex)/2,z]];
 if(shape.tool==='diamond')return [[(x+ex)/2,z],[ex,(z+ez)/2],[(x+ex)/2,ez],[x,(z+ez)/2],[(x+ex)/2,z]];
 return [[x,z],[ex,z],[ex,ez],[x,ez],[x,z]];
}
export function segmentDistance(point,a,b){
 const dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz;
 const t=length?Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dz)/length)):0;
 return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dz);
}
function crosses(a,b,c,d){
 const side=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 return side(a,b,c)*side(a,b,d)<0&&side(c,d,a)*side(c,d,b)<0;
}
export function touches(shape,from,to,radius){
 const points=vertices(shape),hitRadius=radius+shape.width/2;
 if(points.length===1)return segmentDistance(points[0],from,to)<=hitRadius;
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];
  if(crosses(a,b,from,to)||Math.min(segmentDistance(from,a,b),segmentDistance(to,a,b),segmentDistance(a,from,to),segmentDistance(b,from,to))<=hitRadius)return true;
 }
 return false;
}
export function validShapes(value){
 return Array.isArray(value)&&value.length<=1000&&value.reduce((n,s)=>n+(s.points?.length||0),0)<=MAX_POINTS&&value.every(s=>s&&TOOLS.includes(s.tool)&&!['view','eraser'].includes(s.tool)&&/^#[a-f0-9]{6}$/i.test(s.color)&&Number.isFinite(s.width)&&s.width>0&&s.width<=2000&&Array.isArray(s.points)&&s.points.length>0&&(s.tool==='brush'||s.points.length===2)&&s.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<1e9)));
}
function storage(){
 let dbPromise;
 const open=()=>dbPromise||=new Promise((resolve,reject)=>{
  const request=indexedDB.open('easter-co-personal-map',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('annotations');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Drawing storage is blocked by another tab.'));
 });
 return {
  async read(){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('annotations','readonly'),request=tx.objectStore('annotations').get('overworld');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});},
  async write(value){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('annotations','readwrite');tx.objectStore('annotations').put(value,'overworld');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
 };
}
export function createDrawings({canvas,stage,getView,redraw}){
 const panel=document.createElement('details');panel.className='map-drawing';panel.id='map-drawing';
 panel.innerHTML='<summary>Draw <span aria-hidden="true">✎</span></summary><div class="drawing-panel"><div class="drawing-heading"><strong>Your chart notes</strong><label><input type="checkbox" data-show-drawings checked> Show drawings</label></div><div class="drawing-tools" role="toolbar" aria-label="Drawing tools"></div><div class="drawing-options"><label>Colour<input type="color" value="#ffd166" aria-label="Drawing colour"></label><label>Stroke<select aria-label="Stroke width"><option value="2">Fine</option><option value="4" selected>Medium</option><option value="8">Bold</option><option value="14">Heavy</option></select></label></div><div class="drawing-history"><button type="button" data-undo>Undo</button><button type="button" data-redo>Redo</button><button type="button" data-clear>Clear</button></div><p class="drawing-help">Drag to draw. Middle-drag pans the map.<br>Notes stay attached to world locations and are private to this browser.</p><output class="drawing-saved" role="status" aria-live="polite">Opening your saved notes…</output></div>';
 const key=stage.querySelector('#map-key');key.after(panel);
 const $=selector=>panel.querySelector(selector),tools=$('.drawing-tools'),status=$('.drawing-saved'),color=$('input[type=color]'),stroke=$('select'),show=$('[data-show-drawings]');
 let shapes=[],draft=null,active=null,tool='view',loaded=false,visible=true,undo=[],redo=[],beforeErase=null,erasing=false,lastErase=null,revision=0,saveQueue=Promise.resolve();
 const disk=storage();
 const icons={view:'↖',brush:'✎',eraser:'⌫',line:'╱',square:'□',rectangle:'▭',circle:'○',triangle:'△',diamond:'◇'};
 function world(event){const r=canvas.getBoundingClientRect(),v=getView();return [v.cx+(event.clientX-r.left-v.width/2)/v.scale,v.cz+(event.clientY-r.top-v.height/2)/v.scale];}
 function update(){
  for(const button of tools.children){button.setAttribute('aria-pressed',String(button.dataset.tool===tool));button.disabled=!loaded;}
  $('[data-undo]').disabled=!loaded||!undo.length;$('[data-redo]').disabled=!loaded||!redo.length;$('[data-clear]').disabled=!loaded||!shapes.length;
  color.disabled=stroke.disabled=show.disabled=!loaded;
  canvas.dataset.drawingTool=tool;
 }
 function save(){
  const version=++revision,value={schema:1,shapes,color:color.value,stroke:Number(stroke.value),visible,panelOpen:panel.open};
  try{localStorage.setItem('easter-co-drawing-preferences',JSON.stringify({color:value.color,stroke:value.stroke,visible:value.visible,panelOpen:value.panelOpen}));}catch{}
  status.textContent='Saving on this device…';
  saveQueue=saveQueue.catch(()=>{}).then(()=>disk.write(value)).then(()=>{if(version===revision)status.textContent=shapes.length+' drawing'+(shapes.length===1?'':'s')+' · Saved on this device';}).catch(()=>{status.textContent='Browser storage unavailable. Keep this tab open: changes are not saved.';});
 }
 function history(previous){undo.push(previous);if(undo.length>40)undo.shift();redo=[];update();save();redraw();}
 function select(next){if(erasing&&beforeErase)shapes=beforeErase;tool=next;draft=null;active=null;beforeErase=null;erasing=false;update();redraw();}
 for(const name of TOOLS){
  const button=document.createElement('button');button.type='button';button.dataset.tool=name;button.setAttribute('aria-label',name==='view'?'View & pan':name[0].toUpperCase()+name.slice(1));button.title=name==='view'?'View & pan':name[0].toUpperCase()+name.slice(1);
  const icon=document.createElement('span');icon.textContent=icons[name];icon.setAttribute('aria-hidden','true');const label=document.createElement('small');label.textContent=name==='view'?'View':name[0].toUpperCase()+name.slice(1);button.append(icon,label);button.onclick=()=>{select(name);canvas.focus({preventScroll:true});};tools.append(button);
 }
 const changeHistory=(from,to)=>{if(active||!from.length)return;to.push(shapes);shapes=from.pop();update();save();redraw();};
 $('[data-undo]').onclick=()=>changeHistory(undo,redo);$('[data-redo]').onclick=()=>changeHistory(redo,undo);
 $('[data-clear]').onclick=()=>{if(!shapes.length)return;const old=shapes;shapes=[];history(old);};
 show.onchange=()=>{visible=show.checked;if(!visible)select('view');save();redraw();};
 color.onchange=stroke.onchange=()=>save();
 panel.addEventListener('toggle',()=>{if(panel.open)key.open=false;if(!panel.open)select('view');if(loaded)save();});
 key.addEventListener('toggle',()=>{if(key.open)panel.open=false;});
 function intercept(event){event.preventDefault();event.stopImmediatePropagation();}
 function erase(point){
  shapes=shapes.filter(shape=>!touches(shape,lastErase||point,point,12/getView().scale));lastErase=point;redraw();
 }
 canvas.addEventListener('pointerdown',event=>{
  if(event.button===1&&active!==null){draft=null;if(erasing)shapes=beforeErase;active=null;erasing=false;beforeErase=null;redraw();return;}
  if(!loaded||!visible||tool==='view'||event.button!==0||active!==null)return;
  intercept(event);canvas.setPointerCapture(event.pointerId);active=event.pointerId;
  if(tool==='eraser'){beforeErase=shapes;erasing=true;lastErase=null;erase(world(event));return;}
  const p=world(event);draft={tool,color:color.value,width:Number(stroke.value)/getView().scale,points:tool==='brush'?[p]:[p,p]};redraw();
 },true);
 canvas.addEventListener('pointermove',event=>{
  if(active!==event.pointerId)return;intercept(event);const p=world(event);
  if(erasing){erase(p);return;}
  if(draft.tool==='brush'){
   const previous=draft.points.at(-1);if(Math.hypot(p[0]-previous[0],p[1]-previous[1])*getView().scale>=1&&draft.points.length<10000)draft.points.push(p);
  }else draft.points[1]=p;
  redraw();
 },true);
 function finish(event,cancel){
  if(active!==event.pointerId)return;intercept(event);active=null;
  if(erasing){const old=beforeErase;erasing=false;beforeErase=null;if(cancel){shapes=old;redraw();return;}if(shapes.length!==old.length)history(old);return;}
  const shape=draft;draft=null;
  if(!cancel&&shape){
   const next=[...shapes,shape];
   if(validShapes(next)){const old=shapes;shapes=next;history(old);}else{status.textContent='Your chart is full. Remove some notes before adding more.';redraw();}
  }else redraw();
 }
 canvas.addEventListener('pointerup',event=>finish(event,false),true);
 for(const name of ['pointercancel','lostpointercapture'])canvas.addEventListener(name,event=>finish(event,true),true);
 stage.addEventListener('keydown',event=>{
  if(event.target.closest('input,select,textarea,[contenteditable]'))return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();changeHistory(event.shiftKey?redo:undo,event.shiftKey?undo:redo);}
  else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();changeHistory(redo,undo);}
  else if(event.key==='Escape')select('view');
 });
 function render(g){
  if(!visible)return;const v=getView();
  g.save();g.lineCap='round';g.lineJoin='round';g.setLineDash([]);
  for(const shape of draft?[...shapes,draft]:shapes){
   const pts=vertices(shape).map(p=>project(...p,v));g.strokeStyle=shape.color;g.fillStyle=shape.color;g.lineWidth=Math.max(.3,shape.width*v.scale);g.globalAlpha=shape===draft ? .8 : 1;
   g.beginPath();pts.forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));
   if(pts.length===1){g.arc(...pts[0],g.lineWidth/2,0,Math.PI*2);g.fill();}else g.stroke();
  }
  g.restore();
 }
 update();
 const ready=disk.read().then(saved=>{
  let preferences;try{preferences=JSON.parse(localStorage.getItem('easter-co-drawing-preferences'));}catch{}
  if(preferences&&saved)saved={...saved,...preferences};
  if(saved?.schema===1&&validShapes(saved.shapes)){shapes=saved.shapes;if(/^#[a-f0-9]{6}$/i.test(saved.color))color.value=saved.color;if([2,4,8,14].includes(saved.stroke))stroke.value=saved.stroke;visible=saved.visible!==false;show.checked=visible;panel.open=saved.panelOpen===true;}
  status.textContent=shapes.length+' drawing'+(shapes.length===1?'':'s')+' · Saved on this device';
 }).catch(()=>{status.textContent='Browser storage unavailable. Changes will remain only in this tab.';}).finally(()=>{loaded=true;update();redraw();});
 return {render,ready};
}
