import {createDrawings} from './drawings.mjs';
import {createMapCache} from './cache.mjs';
import {project,visible,contains,labelSpans} from './geometry.mjs';
const $=id=>document.getElementById(id),canvas=$('terrain'),stage=$('map-stage'),g=canvas.getContext('2d');
const cache=createMapCache(),tiles=new Map(),pointers=new Map();
const SETTINGS='easter-co-atlas-ui';let settings={};
try{const saved=JSON.parse(localStorage.getItem(SETTINGS));if(saved&&typeof saved==='object'&&!Array.isArray(saved))settings=saved;}catch{}
const save=()=>{try{localStorage.setItem(SETTINGS,JSON.stringify(settings));}catch{}};
const savedView=settings.view,heldView=savedView&&[savedView.cx,savedView.cz,savedView.scale].every(Number.isFinite)&&savedView.scale>=.04&&savedView.scale<=12;
let cx=heldView?savedView.cx:-625,cz=heldView?savedView.cz:-247,scale=heldView?savedView.scale:.9,width=1,height=1;
let annotations;
let world=null,cached=false,failed=false,running=0,serial=0,timer=null;
const view=()=>({cx,cz,scale,width,height}),key=r=>r.x+','+r.z,point=(x,z)=>project(x,z,view());
const enabled=layer=>settings.layers?.[layer]!==false;
function rememberView(){settings.view={cx,cz,scale};save();}
// One public category per marker kind, and one key entry per category. A kind outside
// this map (an older cached snapshot, or a future server-side addition) is skipped, not
// drawn and never fatal. Player factions are not public categories and are not listed.
const layers={ship:{color:'#58a6ff'},sea_patrol:{color:'#ef4444'},land_patrol:{color:'#fb923c'},villager:{color:'#ffffff'},mob:{color:'#eab308'}};
const layerOf=row=>layers[row?.kind]?row.kind:null;
// The chart may only carry published categories, so a report that invents a marker kind
// is refused and the saved chart kept. A marker kind this build does not know is still
// skipped rather than drawn or thrown on, so an older cached snapshot stays usable.
const markerKinds=Object.freeze(Object.keys(layers));
const inputs=[...document.querySelectorAll('[data-layer]')];
for(const input of inputs){input.checked=enabled(input.dataset.layer);input.onchange=()=>{settings.layers={...settings.layers,[input.dataset.layer]:input.checked};save();draw();};}
$('map-key').open=settings.keyOpen===true;
// The personal-drawings palette is chart furniture on a full-bleed chart, and two separate things
// own its geometry for as long as the page is open: the stylesheet's own rule — and the media query
// that overrides it below 600px — decides where the palette sits at the current width, and the
// edges below it decide how tall the panel it opens is allowed to be. Neither may be captured once
// at load, which is what round-three review measured. A chart loaded at 390 kept the narrow 148px
// after the window widened to 1440, where the palette covered 6.4px of the map key's summary so a
// click in that strip opened Draw instead of the key; a chart loaded wide kept 166px at 390, 18px
// right of the position the narrow rule gives it. The panel's own max-height was a bare viewport
// subtraction that knew about neither the launcher's sticky bar nor the notice band's reserved
// room, so at 390 Colour and Stroke were behind the bar before a sentence was even on screen.
const PANEL_GAP=10;
function drawingParts(){
 const palette=document.querySelector('.map-drawing'),panel=palette?.querySelector('.drawing-panel');
 return palette&&panel?{palette,panel}:null;
}
// The designed left is read from the stylesheet every time it is wanted, with the inline value
// taken out first: an inline `left` outranks the media query, so a number written at one width
// would otherwise freeze the palette at that width for the rest of the session.
function stylesheetLeft(palette){
 palette.style.removeProperty('left');
 return parseFloat(getComputedStyle(palette).left)||0;
}
// The key and the palette share the top-left corner, and the palette sits above the key: once the
// key is open its box would swallow clicks on the key's left entries. While the key is open, slide
// the palette to the right edge of the open key (it keeps the gap its panel is offset by, so the
// panel clears the key exactly) and leave it untouched when the key closes. A viewport too narrow
// to hold the shifted palette keeps the stylesheet layout instead — the stylesheet's position at
// the current width, which is what taking the inline value out restores.
function alignDrawingPanel(){
 const parts=drawingParts();if(!parts)return;
 const {palette,panel}=parts,base=stylesheetLeft(palette);
 const key=$('map-key').getBoundingClientRect();
 // left is relative to the offset parent, so convert the wanted viewport box back to it.
 const parentLeft=palette.offsetParent?.getBoundingClientRect().left??0,moved=Math.round(key.right+base-parentLeft);
 const fits=parentLeft+moved+base+panel.offsetWidth<document.documentElement.clientWidth-8;
 if($('map-key').open&&fits)palette.style.left=moved+'px';
}
// The panel grows downward from its own summary, so the room it may use is measured from its own
// top to the first edge it would run into. Two edges can be under it, and both are read as boxes
// rather than as numbers in this file: the chart's own footer, and the launcher's sticky bar, which
// floats above that footer and spans the window at narrow widths. An edge only counts where it
// really stands over the panel's own columns — at 1440 the bar is a narrower band that ends to the
// right of where the panel does — and the room is published as --drawing-panel-room for
// site/styles.css to cap the panel with. The notice band's reserved height needs no term of its
// own: it moves the whole strip down, so the panel's measured top already carries it. Nothing is
// capped unless the panel would really run under something, so a chart with room to spare keeps
// exactly the panel it always had.
function fitDrawingPanel(){
 const parts=drawingParts();if(!parts)return;
 const {palette,panel}=parts;
 if(!palette.open){palette.style.removeProperty('--drawing-panel-room');return;}
 const box=panel.getBoundingClientRect();
 let ceiling=innerHeight;
 for(const node of [document.querySelector('.map-bottom'),document.getElementById('launcher-bar')]){
  if(!node||!node.getClientRects().length)continue;
  const edge=node.getBoundingClientRect();
  if(edge.height<=0||edge.top<=box.top||edge.right<=box.left||edge.left>=box.right)continue;
  ceiling=Math.min(ceiling,edge.top);
 }
 const room=Math.max(0,Math.round(ceiling-box.top-PANEL_GAP))+'px';
 if(palette.style.getPropertyValue('--drawing-panel-room')!==room)palette.style.setProperty('--drawing-panel-room',room);
}
// Both answers are layout, so both are re-read whenever anything that feeds them moves.
function placeDrawingPanel(){alignDrawingPanel();fitDrawingPanel();}
$('map-key').addEventListener('toggle',()=>{settings.keyOpen=$('map-key').open;save();placeDrawingPanel();});
function validWorld(value){
 return value?.schema===1&&typeof value.captured_at==='string'&&Array.isArray(value.center)&&value.center.length===2&&value.center.every(Number.isFinite)&&
  Array.isArray(value.tiles)&&value.tiles.every(r=>Number.isInteger(r.x)&&Number.isInteger(r.z)&&/^[a-f0-9]{64}$/.test(r.version))&&
  Array.isArray(value.regions)&&value.regions.every(r=>typeof r.name==='string'&&Array.isArray(r.points)&&r.points.length>=3&&r.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))&&
  Array.isArray(value.markers)&&value.markers.every(r=>markerKinds.includes(r.kind)&&Number.isFinite(r.x)&&Number.isFinite(r.z));
}
async function hydrate(r){
 const id=key(r),entry={hydrating:true};tiles.set(id,entry);
 try{
  const saved=await cache.readTile(id);
  if(saved?.blob){const image=await createImageBitmap(saved.blob);if(tiles.get(id)!==entry){image.close();return;}entry.image=image;entry.version=saved.version;}
 }catch{void cache.removeTile(id);}
 finally{entry.hydrating=false;entry.hydrated=true;draw();}
}
async function load(r){
 const id=key(r),entry=tiles.get(id);entry.loading=true;entry.attempted=r.version;running++;
 try{
  const response=await fetch('../data/tiles/'+r.x+'/'+r.z+'.png?v='+r.version,{cache:'no-cache'});
  if(!response.ok)throw Error('Tile unavailable');
  const blob=await response.blob(),image=await createImageBitmap(blob);
  if(tiles.get(id)!==entry||world?.tiles.find(row=>key(row)===id)?.version!==r.version){image.close();return;}
  // A rolling Pages update or proxy must not stamp old bytes with the new tile hash.
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==r.version){image.close();throw Error('Tile is still updating');}
  if(tiles.get(id)!==entry||world?.tiles.find(row=>key(row)===id)?.version!==r.version){image.close();return;}
  const previous=entry.image;entry.image=image;entry.version=r.version;entry.error=false;previous?.close();
  void cache.writeTile(id,r.version,blob);
 }catch{if(tiles.get(id)===entry)entry.error=true;}
 finally{entry.loading=false;running--;draw();}
}
function drawRegions(){
 if(!enabled('regions')||!world)return;
 const labels=[];
 for(const region of world.regions){
  const pts=region.points.map(p=>point(...p));g.save();g.beginPath();pts.forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));g.closePath();
  g.setLineDash([5,7]);g.strokeStyle='rgba(232,226,206,.38)';g.lineWidth=1;g.stroke();g.setLineDash([]);
  for(const span of labelSpans(pts)){
   const letters=Array.from(region.name.toLocaleUpperCase());let size=Math.min(25,Math.max(10,span.width/15)),tracking;
   const measure=()=>{g.font=`${size}px Georgia,serif`;tracking=size*.15;return letters.reduce((w,c)=>w+g.measureText(c).width,0)+Math.max(0,letters.length-1)*tracking;};
   let textWidth=measure();while(textWidth>span.width*.8&&size>10){size--;textWidth=measure();}if(textWidth>span.width*.8)continue;
   const box={left:span.x-textWidth/2-5,right:span.x+textWidth/2+5,top:span.y-size,bottom:span.y+size};
   if(box.right<0||box.left>width||box.bottom<0||box.top>height||labels.some(b=>box.left<b.right&&box.right>b.left&&box.top<b.bottom&&box.bottom>b.top))continue;
   g.save();g.clip();g.textBaseline='middle';g.textAlign='left';g.fillStyle='rgba(239,226,190,.82)';g.shadowColor='#0d130f';g.shadowBlur=4;
   let x=span.x-textWidth/2;for(const c of letters){g.fillText(c,x,span.y);x+=g.measureText(c).width+tracking;}
   g.restore();labels.push(box);break;
  }
  g.restore();
 }
}
function drawMarkers(){
 for(const row of world?.markers||[]){
  row.sx=undefined;row.sy=undefined;const layer=layerOf(row);if(!layer||!enabled(layer))continue;
  const [x,y]=point(row.x,row.z);if(x<-30||y<-30||x>width+30||y>height+30)continue;
  const hull=(row.icon==='hull'||row.icon==='navy_ship'),r=hull?10:5,color=layers[layer].color;
  const old=!row.observed_at||Date.parse(world.captured_at)-Date.parse(row.observed_at)>300000;
  g.save();g.globalAlpha=old ? .75 : 1;g.beginPath();g.arc(x,y,r,0,Math.PI*2);
  g.fillStyle=old?'#0d2029':color;g.fill();g.strokeStyle=color;g.lineWidth=1.5;if(old)g.setLineDash([3,2]);g.stroke();g.setLineDash([]);
  const icon=row.icon||(layer.endsWith('_patrol')?'navy_unit-guard':'');
  if(icon){
   g.strokeStyle=old?color:'#0d2029';g.lineWidth=1.4;g.beginPath();
   if(icon==='hull'||icon==='navy_ship'){g.moveTo(x-6,y+3);g.lineTo(x+6,y+3);g.lineTo(x+3,y+6);g.lineTo(x-3,y+6);g.closePath();g.moveTo(x,y+2);g.lineTo(x,y-7);g.lineTo(x+5,y);g.lineTo(x,y);}
   else{g.moveTo(x-5,y-5);g.lineTo(x+5,y-5);g.lineTo(x+4,y+2);g.quadraticCurveTo(x+2,y+5,x,y+7);g.quadraticCurveTo(x-2,y+5,x-4,y+2);g.closePath();}
   g.stroke();
  }
  g.restore();row.sx=x;row.sy=y;
 }
}
function draw(){
 const dpr=window.devicePixelRatio||1;g.setTransform(dpr,0,0,dpr,0,0);g.fillStyle='#0b1c24';g.fillRect(0,0,width,height);g.imageSmoothingEnabled=false;
 const rows=visible(world?.tiles||[],view());
 for(const r of rows){const t=tiles.get(key(r)),[x,y]=point(r.x*512,r.z*512);if(t?.image)g.drawImage(t.image,x,y,512*scale,512*scale);}
 drawRegions();drawMarkers();annotations?.render(g);
 if(world){const [x,y]=point(...world.center);g.beginPath();g.arc(x,y,5,0,Math.PI*2);g.fillStyle='#e9c17d';g.fill();g.strokeStyle='#14242b';g.lineWidth=2;g.stroke();}
 const meters=10**Math.floor(Math.log10(120/scale));g.strokeStyle='#d4dec8';g.lineWidth=2;g.beginPath();g.moveTo(width-24-meters*scale,height-67);g.lineTo(width-24,height-67);g.stroke();g.fillStyle='#d4dec8';g.font='10px system-ui';g.textAlign='right';g.fillText(meters+' blocks',width-24,height-76);
 $('map-coordinates').textContent='X '+Math.round(cx)+' · Z '+Math.round(cz);
 const errors=rows.some(r=>tiles.get(key(r))?.error),missing=rows.some(r=>!tiles.get(key(r))?.image);
 const message=failed?(world?'Connection unavailable · showing saved chart':'Chart unavailable · retrying automatically'):cached?'Showing saved chart · checking for updates':errors?'Some tiles are still updating · keeping saved terrain':running?(missing?'Loading the world chart…':'Updating the chart…'):'';
 $('map-status').textContent=message;$('map-status').hidden=!message;
 for(const r of rows)if(!tiles.has(key(r)))void hydrate(r);
 let started=false;
 for(const r of rows){if(running>=3)break;const t=tiles.get(key(r));if(t?.hydrated&&!t.loading&&!cached&&t.version!==r.version&&t.attempted!==r.version){started=true;void load(r);}}
 if(started)queueMicrotask(draw);
 if(tiles.size>80){const keep=new Set(rows.map(key));for(const [id,t]of tiles)if(!keep.has(id)&&!t.loading&&!t.hydrating){t.image?.close();tiles.delete(id);if(tiles.size<=64)break;}}
}
function setWorld(fresh){
 const first=!world;world=fresh;if(first&&!heldView)[cx,cz]=fresh.center;
 $('snapshot-date').textContent='Charted '+new Date(fresh.captured_at).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const keep=new Set(fresh.tiles.map(key));for(const [id,t]of tiles)if(!keep.has(id)){t.image?.close();tiles.delete(id);void cache.removeTile(id);}
 draw();
}
async function refresh(){
 const epoch=++serial;
 try{
  const response=await fetch('../data/world.json',{cache:'no-cache'});if(!response.ok)throw Error();const fresh=await response.json();if(!validWorld(fresh))throw Error();if(epoch!==serial)return;
  failed=false;cached=false;for(const t of tiles.values())if(t.error&&!t.loading){t.error=false;t.attempted=undefined;}
  setWorld(fresh);void cache.writeSnapshot('world',fresh);
 }catch{if(epoch===serial){failed=true;draw();}}
}
function zoom(factor,x=width/2,y=height/2){const old=scale;scale=Math.max(.04,Math.min(12,scale*factor));cx+=(x-width/2)*(1/old-1/scale);cz+=(y-height/2)*(1/old-1/scale);rememberView();draw();}
// The stage's own box is what a window resize, a rotation or a fullscreen change moves first, and
// the palette's width-dependent position lives behind a media query on the window's width, so the
// palette is re-placed here rather than at whichever width the chart happened to load at.
function resize(){width=stage.clientWidth;height=stage.clientHeight;const dpr=window.devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);draw();placeDrawingPanel();}
function hover(e){
 const rect=canvas.getBoundingClientRect(),px=e.clientX-rect.left,py=e.clientY-rect.top,x=cx+(px-width/2)/scale,z=cz+(py-height/2)/scale;
 const region=world?.regions.find(r=>contains(r.points,x,z));$('map-location').textContent=region?.name||'The Wilds';
 let hit=null,distance=18;for(const row of world?.markers||[])if(row.sx!==undefined){const d=Math.hypot(row.sx-px,row.sy-py);if(d<distance){distance=d;hit=row;}}
 const tip=$('map-tooltip');tip.style.display=hit?'block':'none';
 if(hit){const kind={ship:'Ship',sea_patrol:'Sea patrol',land_patrol:'Land patrol',villager:'Villager',mob:'Mob'}[hit.kind]||'Marker',when=hit.observed_at?'Observed '+new Date(hit.observed_at).toLocaleString():'Observation time unknown';
  tip.querySelector('strong').textContent=hit.name;tip.querySelector('small').textContent=kind+' · '+when;tip.style.left=Math.max(10,Math.min(width-tip.offsetWidth-10,px+16))+'px';tip.style.top=Math.max(10,Math.min(height-tip.offsetHeight-110,py+16))+'px';}
}
canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0&&e.button!==1)return;e.preventDefault();canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);$('map-tooltip').style.display='none';});
canvas.addEventListener('pointermove',e=>{
 if(!pointers.has(e.pointerId)){hover(e);return;}
 const before=[...pointers.values()],old=pointers.get(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);
 if(pointers.size===2){const after=[...pointers.values()],d=a=>Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);if(d(before)>0)zoom(d(after)/d(before));}
 else{cx-=(e.clientX-old[0])/scale;cz-=(e.clientY-old[1])/scale;rememberView();draw();}
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>pointers.delete(e.pointerId));
canvas.addEventListener('pointerleave',()=>{$('map-tooltip').style.display='none';$('map-location').textContent='';});
canvas.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.002),e.clientX-r.left,e.clientY-r.top);},{passive:false});
canvas.addEventListener('keydown',e=>{const d=80/scale;if(e.key==='ArrowLeft')cx-=d;else if(e.key==='ArrowRight')cx+=d;else if(e.key==='ArrowUp')cz-=d;else if(e.key==='ArrowDown')cz+=d;else if(e.key==='+'||e.key==='=')zoom(1.5);else if(e.key==='-')zoom(1/1.5);else return;e.preventDefault();rememberView();draw();});
$('zoom-in').onclick=()=>zoom(1.5);$('zoom-out').onclick=()=>zoom(1/1.5);
$('home').onclick=()=>{[cx,cz]=world?.center||[-625,-247];scale=.9;rememberView();draw();};
$('fullscreen').onclick=()=>{if(document.fullscreenElement)void document.exitFullscreen();else void stage.requestFullscreen?.().catch(()=>{});};
document.addEventListener('fullscreenchange',()=>{const label=document.fullscreenElement?'Exit full screen':'Enter full screen';$('fullscreen').setAttribute('aria-label',label);$('fullscreen').title=label;});
function schedule(){clearTimeout(timer);if(document.visibilityState==='visible')timer=setTimeout(async()=>{await refresh();schedule();},300000);}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();schedule();});
// The personal-drawings palette is created by createDrawings, so it exists only now, and every
// edge that places it or caps it arrives later still: the palette opening, the chart's footer after
// the first draw, and the launcher's sticky bar whenever the launcher has something to report. The
// two numbers site/desktop.js publishes on the document - the bar's own offset and the room the
// notice band reserves - arrive on <html style>, and both move this furniture without touching the
// stage's size. So each of those is watched rather than sampled once at load.
annotations=createDrawings({canvas,stage,getView:view,redraw:draw});
const palette=document.querySelector('.map-drawing');
palette?.addEventListener('toggle',placeDrawingPanel);
// The window's own size is what the palette's position is a function of, and a resize observer
// reports only the change it sees between frames: a window that comes back to the size it last
// reported - dragging a window edge and letting go, or a rotation - delivers no record at all, and
// the palette would keep the geometry of the size in between. The event fires for every change.
window.addEventListener('resize',placeDrawingPanel,{passive:true});
if(typeof ResizeObserver==='function'){
 const edges=new ResizeObserver(()=>placeDrawingPanel());
 const watchEdges=()=>{for(const node of [document.querySelector('.map-bottom'),document.getElementById('launcher-bar')])if(node)edges.observe(node);};
 watchEdges();
 if(typeof MutationObserver==='function')new MutationObserver(watchEdges).observe(document.body,{childList:true});
}
if(typeof MutationObserver==='function')new MutationObserver(()=>placeDrawingPanel()).observe(document.documentElement,{attributes:true,attributeFilter:['style']});
placeDrawingPanel();
new ResizeObserver(resize).observe(stage);
void(async()=>{const saved=await cache.readSnapshot('world');if(!world&&validWorld(saved)){cached=true;setWorld(saved);}await refresh();schedule();})();
