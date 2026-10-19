import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const read=async page=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('easter-co-personal-map',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('annotations','readonly'),request=tx.objectStore('annotations').get('overworld');request.onsuccess=()=>{resolve(request.result);db.close();};request.onerror=()=>reject(request.error);};r.onerror=()=>reject(r.error);}));
async function saved(page,count){for(let i=0;i<100;i++){const value=await read(page);if(value?.shapes.length===count&&!(await page.locator('.drawing-saved').textContent()).includes('Saving'))return value;await page.waitForTimeout(30);}assert.fail('Drawings were not persisted: '+count);}
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/map/');await page.waitForFunction(()=>document.getElementById('map-status').hidden);
 await page.locator('#map-drawing summary').click();
 await page.getByRole('button',{name:'Circle',exact:true}).waitFor({state:'visible'});
 await page.locator('input[aria-label="Drawing colour"]').evaluate(el=>{el.value='#ff00ff';el.dispatchEvent(new Event('change'));});
 const stroke=async(name,x,y,ex,ey)=>{await page.getByRole('button',{name,exact:true}).click();await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(ex,ey,{steps:12});await page.mouse.up();};
 let count=0;
 for(const [index,name] of ['Brush','Line','Square','Rectangle','Circle','Triangle','Diamond'].entries()){
  await stroke(name,500+index*60,360,540+index*60,410);await saved(page,++count);
 }
 let data=await read(page);assert.deepEqual(data.shapes.map(s=>s.tool),['brush','line','square','rectangle','circle','triangle','diamond']);
 const before=structuredClone(data.shapes);
 await page.getByRole('button',{name:'Brush',exact:true}).click();
 const coordinates=await page.locator('#map-coordinates').textContent();
 await page.mouse.move(800,500);await page.mouse.down({button:'middle'});await page.mouse.move(920,560,{steps:6});await page.mouse.up({button:'middle'});
 assert.notEqual(await page.locator('#map-coordinates').textContent(),coordinates);
 assert.deepEqual((await read(page)).shapes,before,'middle pan cannot alter drawings');
 await page.locator('#zoom-in').click();
 assert.deepEqual((await read(page)).shapes,before,'zoom cannot alter world coordinates');
 const screen=async point=>page.evaluate(point=>{const v=JSON.parse(localStorage.getItem('easter-co-atlas-ui')).view,r=document.querySelector('#terrain').getBoundingClientRect();return {x:r.left+(point[0]-v.cx)*v.scale+r.width/2,y:r.top+(point[1]-v.cz)*v.scale+r.height/2};},point);
 const circle=before[4],radius=Math.hypot(circle.points[1][0]-circle.points[0][0],circle.points[1][1]-circle.points[0][1]);
 const edgeWorld=[circle.points[0][0]+radius,circle.points[0][1]];
 const checkPixel=async()=>{const position=await screen(edgeWorld);return page.locator('#terrain').evaluate((canvas,p)=>{const r=canvas.getBoundingClientRect(),d=devicePixelRatio;return [...canvas.getContext('2d').getImageData(Math.round((p.x-r.left)*d),Math.round((p.y-r.top)*d),1,1).data];},position);};
 assert.deepEqual(await checkPixel(),[255,0,255,255],'circle follows its world location after pan and zoom');
 await page.reload();await page.waitForFunction(()=>document.getElementById('map-status').hidden);await page.getByRole('button',{name:'Circle',exact:true}).waitFor();
 assert.deepEqual((await read(page)).shapes,before);
 assert.deepEqual(await checkPixel(),[255,0,255,255],'saved drawing restores at the same world location');
 await page.screenshot({path:'/tmp/easter-map-drawings-desktop.png'});
 // A fresh line in a quiet spot is erased as a whole stroke, then recovered.
 await stroke('Line',1050,550,1150,550);await saved(page,++count);
 await page.getByRole('button',{name:'Eraser',exact:true}).click();await page.mouse.move(1100,540);await page.mouse.down();await page.mouse.move(1100,560,{steps:4});await page.mouse.up();await saved(page,--count);
 await page.getByRole('button',{name:'Undo',exact:true}).click();await saved(page,++count);
 await page.getByRole('button',{name:'Redo',exact:true}).click();await saved(page,--count);
 await page.getByLabel('Show drawings',{exact:true}).uncheck();await page.reload();await page.waitForFunction(()=>!document.querySelector('[data-show-drawings]').disabled);assert.equal(await page.getByLabel('Show drawings',{exact:true}).isChecked(),false);assert.equal((await read(page)).shapes.length,count);
 await page.getByLabel('Show drawings',{exact:true}).check();
 await page.getByRole('button',{name:'Clear',exact:true}).click();await saved(page,0);await page.getByRole('button',{name:'Undo',exact:true}).click();await saved(page,count);
 for(const size of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
  await page.setViewportSize(size);
  const panel=await page.locator('.drawing-panel').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=size.width&&panel.y>=0&&panel.y+panel.height<=size.height);
  const compass=await page.locator('.compass').boundingBox(),key=await page.locator('.map-key').boundingBox(),toolbar=await page.locator('.map-controls').boundingBox();
  assert(compass.x+compass.width<key.x);assert(toolbar.x>key.x+key.width);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(size.width===390)await page.screenshot({path:'/tmp/easter-map-drawings-mobile.png'});
 }
 // ---- Palette geometry: the width the chart is at now, and the room under the panel ---------
 // Round-three review measured two chart-internal defects on this palette. Its inline left was
 // captured once at load, so a chart loaded at 390 kept 148px after the window widened to 1440,
 // where the palette covered the last 6.4px of the map key's 91.4px summary so that a click in
 // that strip opened Draw instead of the key, while a chart loaded wide kept 166px at 390, 18px
 // right of the position the narrow rule gives it. And .drawing-panel's max-height accounted for
 // neither the launcher's sticky bar nor the notice band's reserved room, so at 390 Colour and
 // Stroke sat behind the bar before any sentence was on screen.
 //
 // The palette now takes its left from the stylesheet at whatever width the chart is at, and its
 // panel is capped by the room between its own top and the first edge under it - the chart's own
 // footer, or the launcher's bar where the bar stands over the palette's columns - published as
 // --drawing-panel-room. The bar belongs to the launcher, so on the website this fixture stands one
 // in on the same selector in the place the launcher floats it; the launcher's real bar is driven
 // by tests/desktop/ui-review.electron.mjs.
 const paletteGeometry=target=>target.evaluate(()=>{
  const box=node=>{if(!node||!node.getClientRects().length)return null;const r=node.getBoundingClientRect();
   return {left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom),width:Math.round(r.width),height:Math.round(r.height)};};
  const hit=node=>{const r=node.getBoundingClientRect(),x=Math.round((r.left+r.right)/2),y=Math.round((r.top+r.bottom)/2);
   if(x<0||y<0||x>=innerWidth||y>=innerHeight)return {at:{x,y},name:'offscreen',inside:false,onBar:false};
   const el=document.elementFromPoint(x,y);
   return {at:{x,y},name:el?(el.id||el.className||el.tagName):null,inside:Boolean(el&&(el===node||node.contains(el))),
    onBar:Boolean(el&&el.closest('#launcher-bar'))};};
  const palette=document.querySelector('.map-drawing'),panel=palette.querySelector('.drawing-panel');
  const key=document.querySelector('.map-key'),summaryBox=box(palette.querySelector('summary')),keySummary=box(key.querySelector('summary'));
  const panelBox=panel.getBoundingClientRect(),open=palette.open;
  const controls=[...document.querySelectorAll('.drawing-tools button')].map(node=>({name:node.querySelector('small').textContent,node}));
  controls.push({name:'colour',node:document.querySelector('input[aria-label="Drawing colour"]')});
  controls.push({name:'stroke',node:document.querySelector('select[aria-label="Stroke width"]')});
  // Each control read where the panel puts it after scrolling it into the room the panel has: a
  // control below the fold is reached by scrolling the panel, never by sitting under the bar where
  // no scroll reaches it.
  const reached=open?controls.map(control=>{control.node.scrollIntoView({block:'nearest'});const r=control.node.getBoundingClientRect();
   return {name:control.name,box:box(control.node),hit:hit(control.node),
    insidePanel:r.top>=panelBox.top-1&&r.bottom<=panelBox.bottom+1&&r.left>=panelBox.left-1&&r.right<=panelBox.right+1};}):[];
  const footer=document.querySelector('.map-bottom'),bar=document.getElementById('launcher-bar');
  const footerTop=footer.getBoundingClientRect().top,barBox=bar?bar.getBoundingClientRect():null,barUp=Boolean(barBox&&barBox.height>0&&!bar.hidden);
  return {width:innerWidth,height:innerHeight,open,
   left:getComputedStyle(palette).left,inlineLeft:palette.style.left||null,
   palette:box(palette),summary:summaryBox,panel:box(panel),keySummary,keyOpen:key.open,
   // The strip the reviewer clicked: the key summary's own last few pixels under the palette.
   stripOverlap:keySummary&&summaryBox?Math.round(keySummary.right-summaryBox.left):0,
   bar:barBox?box(bar):null,barUp,footer:box(footer),footerTop:Math.round(footerTop),panelTop:Math.round(panelBox.top),
   room:getComputedStyle(palette).getPropertyValue('--drawing-panel-room').trim(),
   reached,scrolling:panel.scrollHeight>panel.clientHeight+1,
   overflow:document.documentElement.scrollWidth<=innerWidth+1};
 });
 const openPalette=async target=>{
  if(!await target.evaluate(()=>document.querySelector('.map-drawing').open))await target.locator('#map-drawing summary').click();
  await target.waitForFunction(()=>document.querySelector('.map-drawing').open);
 };
 const closePalette=async target=>{
  if(await target.evaluate(()=>document.querySelector('.map-drawing').open))await target.locator('#map-drawing summary').click();
  await target.waitForFunction(()=>!document.querySelector('.map-drawing').open);
 };
 // The room is layout, so it is re-measured on the frame after anything that feeds it moves: wait
 // for the published room to stop changing rather than sampling it once.
 const settledPalette=async(target,where)=>{
  let previous=null;
  for(let attempt=0;attempt<240;attempt++){
   const probe=await paletteGeometry(target);
   // An open palette always publishes its room: an empty one is either a stale read or the chart
   // not measuring at all, and neither is a settled palette.
   if(previous&&probe.open&&probe.room!==''&&previous.room===probe.room&&previous.panel&&probe.panel&&previous.panel.bottom===probe.panel.bottom)return probe;
   previous=probe;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('the palette never settled '+where+': '+JSON.stringify(previous));
 };
 // A chart the visitor loaded at 390: the narrow rule applies on load, and the wide rule has to
 // apply once the window widens, without a reload.
 const narrow=await browser.newContext({viewport:{width:390,height:844}});
 try{
  const narrowPage=await narrow.newPage();narrowPage.on('pageerror',e=>errors.push(e.message));
  await narrowPage.goto(origin+'/map/');await narrowPage.waitForFunction(()=>document.getElementById('map-status').hidden);
  const loaded=await paletteGeometry(narrowPage);
  assert.equal(loaded.left,'148px','a chart loaded at 390 puts the palette at the narrow rule\'s 148px: '+loaded.left);
  assert.equal(loaded.inlineLeft,null,'and leaves the designed position to the stylesheet rather than freezing an inline copy of it');
  await narrowPage.setViewportSize({width:1440,height:900});
  await narrowPage.waitForFunction(()=>getComputedStyle(document.querySelector('.map-drawing')).left==='166px',{timeout:4000})
   .catch(()=>{throw Error('the palette never took the wide rule\'s 166px after the window widened from 390');});
  const wide=await paletteGeometry(narrowPage);
  assert.equal(wide.left,'166px','after widening, the palette sits where the wide rule puts it: '+wide.left);
  assert.equal(wide.inlineLeft,null,'with no inline left left over from the narrow width');
  assert(wide.summary.left>=wide.keySummary.right,'and the palette clears the map key summary entirely instead of covering its last 6.4px: '+JSON.stringify({palette:wide.summary,key:wide.keySummary}));
  // The interaction the reviewer measured: a click in the key summary's own strip opens the key.
  const strip={x:wide.keySummary.right-3,y:Math.round((wide.keySummary.top+wide.keySummary.bottom)/2)};
  await narrowPage.mouse.click(strip.x,strip.y);
  await narrowPage.waitForFunction(()=>document.querySelector('.map-key').open);
  assert.equal(await narrowPage.evaluate(()=>document.querySelector('.map-drawing').open),false,'a click in the key summary\'s strip opens the key, not Draw');
  await narrowPage.mouse.click(strip.x,strip.y);
  await narrowPage.waitForFunction(()=>!document.querySelector('.map-key').open);
  // The negative control freezes the old narrow position. A stylesheet override is intentional:
  // the live layout callback clears inline left on the frame after the key closes. Injecting an
  // inline value here raced that callback, so the falsifier sometimes measured the repaired
  // 166px instead. Force the old geometry through that frame and the strip click itself.
  const frozenPosition=await narrowPage.addStyleTag({content:'.map-drawing{left:148px!important}'});
  // Deliver a pending layout frame deliberately: it must not repair the negative control.
  await narrowPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const frozen=await paletteGeometry(narrowPage);
  assert(frozen.summary.left<frozen.keySummary.right,'the frozen narrow left covers the key summary\'s strip: '+JSON.stringify({palette:frozen.summary,key:frozen.keySummary,overlap:frozen.stripOverlap}));
  await narrowPage.mouse.click(strip.x,strip.y);
  await narrowPage.waitForFunction(()=>document.querySelector('.map-drawing').open);
  assert.equal(await narrowPage.evaluate(()=>document.querySelector('.map-key').open),false,'and that strip opens Draw instead of the key, which is exactly the defect the chart-side fix removes');
  await frozenPosition.evaluate(node=>node.remove());
  await closePalette(narrowPage);
  // The reverse: the same chart narrowed to 390 must take the narrow rule back.
  await narrowPage.setViewportSize({width:390,height:844});
  await narrowPage.waitForFunction(()=>getComputedStyle(document.querySelector('.map-drawing')).left==='148px',{timeout:4000})
   .catch(()=>{throw Error('the palette never went back to the narrow rule\'s 148px after the window narrowed from 1440');});
  const narrowed=await paletteGeometry(narrowPage);
  assert.equal(narrowed.left,'148px','the palette follows the current width in both directions');
  assert.equal(narrowed.inlineLeft,null,'still without an inline left of its own');
  assert(narrowed.summary.left>=narrowed.keySummary.right,'and 18px left of where the wide rule would have frozen it, clear of the key: '+JSON.stringify({palette:narrowed.summary,key:narrowed.keySummary}));
 } finally{await narrow.close();}
 // The chart the visitor loaded wide: resizing down must move the palette, not keep it.
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.map-drawing')).left==='148px',{timeout:4000})
  .catch(()=>{throw Error('a chart loaded wide never took the narrow rule\'s 148px');});
 assert.equal((await paletteGeometry(page)).inlineLeft,null,'a chart loaded wide keeps no inline left either');
 await page.setViewportSize({width:1440,height:900});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.map-drawing')).left==='166px',{timeout:4000});
 // The room under the panel, with the launcher's bar stood in on its own selector.
 await page.evaluate(()=>{
  const bar=document.createElement('div');bar.id='launcher-bar';bar.className='launcher-bar';bar.hidden=false;
  bar.setAttribute('role','region');bar.setAttribute('aria-label','Client download');
  // The shape the launcher's bar has when it is merely present - no progress track, which is the
  // bar the review measured at 390 - built from the same classes the launcher's own markup uses.
  bar.innerHTML='<button type="button" class="launcher-bar-tab" aria-pressed="false"><span class="launcher-bar-tab-icon" aria-hidden="true">▾</span><span class="launcher-bar-tab-text">PLAY NOW</span></button><div class="launcher-bar-body"><div class="launcher-bar-info"><p class="launcher-bar-label">Ready to play</p><p class="launcher-bar-meta" hidden></p></div><div class="launcher-bar-actions"><button type="button" class="launcher-bar-button">Play now</button></div></div>';
  document.body.append(bar);
  // site/desktop.js floats the bar above the chart's own footer and publishes the offset it used;
  // placing the stand-in with that same published variable is what makes the room the chart
  // measures here the room it measures in the launcher.
  document.documentElement.style.setProperty('--launcher-bar-offset',Math.round(innerHeight-document.querySelector('.map-bottom').getBoundingClientRect().top+12)+'px');
 });
 for(const size of [{width:390,height:568},{width:800,height:600},{width:1440,height:900}]){
  await page.setViewportSize(size);
  await openPalette(page);
  const geometry=await settledPalette(page,'under the launcher bar at '+size.width+'px');
  assert.equal(geometry.barUp,true,'the launcher bar is on screen at '+size.width+'px');
  assert(geometry.panel.bottom<=geometry.bar.top,'the open panel stops above the launcher bar at '+size.width+'px: '+JSON.stringify({panel:geometry.panel,bar:geometry.bar,room:geometry.room}));
  assert(geometry.panel.bottom<=geometry.footerTop,'and above the chart footer at '+size.width+'px: '+JSON.stringify({panel:geometry.panel,footer:geometry.footer}));
  assert(geometry.room!=='','the room the panel may use is published at '+size.width+'px');
  // Every tool, Colour and Stroke is reached by scrolling the panel, and elementFromPoint over
  // each one answers that control - never the launcher bar.
  for(const control of geometry.reached){
   assert.equal(control.hit.inside,true,'elementFromPoint over '+control.name+' is that control at '+size.width+'px: '+JSON.stringify(control));
   assert.equal(control.hit.onBar,false,'and never the launcher bar, '+control.name+' at '+size.width+'px: '+JSON.stringify(control));
   assert.equal(control.insidePanel,true,control.name+' is inside the room the panel has at '+size.width+'px: '+JSON.stringify({control:control.box,panel:geometry.panel}));
   assert(control.box.bottom<=geometry.bar.top,'and above the bar itself, '+control.name+' at '+size.width+'px: '+JSON.stringify({control:control.box,bar:geometry.bar}));
  }
  // The negative control. The room above the footer on its own, and the stylesheet's own viewport
  // subtraction, are both where this panel ended before the bar was in the sum - and both reach
  // past the bar's own top edge, which is the reviewer's overlap. Take the bar term out of the sum
  // in site/map/map.js and the measured room becomes one of those numbers.
  const footerOnly=geometry.footerTop-geometry.panelTop-10,barRoom=geometry.bar.top-geometry.panelTop;
  assert(Number.parseInt(geometry.room,10)<=barRoom,'the published room is the room above the bar, '+size.width+'px: '+JSON.stringify({room:geometry.room,barRoom,footerOnly}));
  assert(footerOnly>barRoom,'while the footer-only room would reach under the bar, '+size.width+'px: '+JSON.stringify({footerOnly,barRoom}));
  // The same overlap, executed: with nothing measured the panel is the stylesheet's own height
  // again, which is the height it had before this fix.
  await page.evaluate(()=>document.querySelector('.map-drawing').style.removeProperty('--drawing-panel-room'));
  const unfixed=await page.evaluate(()=>{
   const panel=document.querySelector('.drawing-panel'),bar=document.getElementById('launcher-bar');
   // Read the panel from its own end, which is where Colour and Stroke live.
   panel.scrollTop=panel.scrollHeight;
   const covered=[...document.querySelectorAll('.drawing-tools button, input[aria-label="Drawing colour"], select[aria-label="Stroke width"]')].filter(node=>{
    const r=node.getBoundingClientRect(),x=Math.round((r.left+r.right)/2),y=Math.round((r.top+r.bottom)/2);
    if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;
    const el=document.elementFromPoint(x,y);return Boolean(el&&el.closest('#launcher-bar'));}).map(node=>node.getAttribute('aria-label')||node.querySelector('small').textContent);
   return {panelBottom:Math.round(panel.getBoundingClientRect().bottom),barTop:Math.round(bar.getBoundingClientRect().top),covered};
  });
  // Only where the content is taller than the room the stylesheet allows does the panel reach the
  // bar at all; at 1440 it is shorter than either edge and there is nothing to reproduce. (The
  // controls themselves disappear under the bar in the launcher, where the notice band has also
  // moved the strip down: that reproduction is in tests/desktop/ui-review.electron.mjs, against the
  // launcher's real bar. Here the stand-in proves the room is what the chart measures, not the CSS.)
  if(geometry.scrolling)assert(unfixed.panelBottom>unfixed.barTop,'without the bar term the panel runs under the bar, '+size.width+'px: '+JSON.stringify(unfixed));
  // Put the measured room back the way the chart itself does it: on the next layout pass.
  await page.setViewportSize({width:size.width,height:size.height-1});
  await page.setViewportSize(size);
  const restored=await settledPalette(page,'after the room was measured again at '+size.width+'px');
  assert(restored.panel.bottom<=restored.bar.top,'the measured room is back at '+size.width+'px: '+JSON.stringify({panel:restored.panel,bar:restored.bar}));
  await page.screenshot({path:'/tmp/easter-map-drawings-palette-'+size.width+'.png'});
  await closePalette(page);
 }
 await page.evaluate(()=>document.getElementById('launcher-bar')?.remove());
 assert.deepEqual(errors,[]);
 console.log('DRAWINGS PALETTE PASS: the palette takes its left from the stylesheet at the current width in both directions (148px at 390, 166px at 1440) with no inline left left over, a click in the key summary strip opens the key and not Draw, and with the launcher bar on screen the open panel stops above the bar and above the chart footer at 390, 800 and 1440 with every tool, Colour and Stroke reached by elementFromPoint - while the footer-only room the round-three review measured puts the panel back under the bar.');
 console.log('DRAWINGS PASS: all seven drawing tools, eraser, undo/redo, durable IndexedDB, world anchoring after camera movement/reload, middle-camera-only, visibility persistence, responsive palette, compass placement');
}finally{await browser.close();}
