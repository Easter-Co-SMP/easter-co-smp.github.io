import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
// Read the marker colour the page asked for, so a key entry can be tied to real drawn markers.
const markerHook=()=>{window.markerDraws=[];const native=CanvasRenderingContext2D.prototype.arc;
 CanvasRenderingContext2D.prototype.arc=function(x,y,radius,...rest){if(this.canvas.id==='terrain')window.markerDraws.push({x,y,radius,color:String(this.strokeStyle).toUpperCase()});return native.call(this,x,y,radius,...rest);};};
// The map test hook plus the saved-terrain counter the other map checks wait on.
const markerHookWithTiles=()=>{window.markerDraws=[];window.mapFrame={tiles:0};
 const arc=CanvasRenderingContext2D.prototype.arc;
 CanvasRenderingContext2D.prototype.arc=function(x,y,radius,...rest){if(this.canvas.id==='terrain')window.markerDraws.push({x,y,radius,color:String(this.strokeStyle).toUpperCase()});return arc.call(this,x,y,radius,...rest);};
 const drawImage=CanvasRenderingContext2D.prototype.drawImage;
 CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='terrain')window.mapFrame.tiles++;return drawImage.apply(this,args);};};
const markerCounts=page=>page.evaluate(()=>window.markerDraws.reduce((counts,draw)=>{counts[draw.color]=(counts[draw.color]||0)+1;return counts;},{}));
const legendLabels=page=>page.locator('.map-key .legend label').allInnerTexts();
// The key's own entries: the marker categories, in the order the legend shows them.
const MARKERS={ship:{hex:'#58A6FF',colour:[88,166,255]},sea_patrol:{hex:'#EF4444',colour:[239,68,68]},
 land_patrol:{hex:'#FB923C',colour:[251,146,60]},villager:{hex:'#FFFFFF',colour:[255,255,255]},
 mob:{hex:'#EAB308',colour:[234,179,8]}};
const markerCategories=page=>page.locator('.map-key .legend [data-layer]').evaluateAll(inputs=>inputs.map(input=>input.dataset.layer).filter(layer=>layer!=='regions'));
// Marker pixels are read off the terrain canvas, not taken from the DOM. Each marker's own
// box is sampled as raw pixels, and changed pixels are counted against a baseline taken with
// every category unticked, so terrain, region labels and the scale bar never count as markers.
// Playwright serializes the evaluate result, so a method on the returned object does not
// survive: the canvas position must be computed here from plain numbers instead. Only the
// box around each marker is read back, because a full-canvas pixel array is megabytes per
// call and the suite makes dozens of them.
const canvasGeometry=page=>page.locator('#terrain').evaluate(canvas=>{
 const save=JSON.parse(localStorage.getItem('easter-co-atlas-ui')||'{}'),view=save.view||{};
 const rect=canvas.getBoundingClientRect();
 return {width:canvas.width,height:canvas.height,depth:devicePixelRatio,
  cx:Number.isFinite(view.cx)?view.cx:-625,cz:Number.isFinite(view.cz)?view.cz:-247,
  scale:Number.isFinite(view.scale)?view.scale:.9,rectLeft:rect.left,rectTop:rect.top,rectWidth:rect.width,rectHeight:rect.height};
});
const readingAt=(geometry,x,z)=>[
 Math.max(0,Math.min(geometry.width-1,Math.round((x-geometry.cx)*geometry.scale*geometry.depth+geometry.rectWidth/2*geometry.depth))),
 Math.max(0,Math.min(geometry.height-1,Math.round((z-geometry.cz)*geometry.scale*geometry.depth+geometry.rectHeight/2*geometry.depth)))];
const inViewport=(geometry,row)=>{const x=geometry.rectLeft+(row.x-geometry.cx)*geometry.scale+geometry.rectWidth/2,y=geometry.rectTop+(row.z-geometry.cz)*geometry.scale+geometry.rectHeight/2;
 return x>18&&y>18&&x<geometry.rectLeft+geometry.rectWidth-18&&y<geometry.rectTop+geometry.rectHeight-18;};
// One small box per marker, read straight off the terrain canvas, in a single round trip.
// The box must stay clear of the neighbouring markers, or one category's pixels would land
// in another category's box and the per-category filtering check would report a false leak.
const devicePoint=(geometry,row)=>[(row.x-geometry.cx)*geometry.scale*geometry.depth+geometry.rectWidth/2*geometry.depth,
 (row.z-geometry.cz)*geometry.scale*geometry.depth+geometry.rectHeight/2*geometry.depth];
const boxFor=(geometry,row,rows)=>{
 let nearest=Infinity;
 for(const other of rows)if(other.id!==row.id){
  const [x,y]=devicePoint(geometry,row),[ox,oy]=devicePoint(geometry,other);
  nearest=Math.min(nearest,Math.hypot(x-ox,y-oy));
 }
 return Math.max(2,Math.min(16,Math.floor(nearest/2)-4));
};
const probeReading=(page,rows,boxes)=>page.evaluate(({rows,boxes})=>{
 const canvas=document.getElementById('terrain'),context=canvas.getContext('2d');
 const save=JSON.parse(localStorage.getItem('easter-co-atlas-ui')||'{}'),view=save.view||{};
 const cx=Number.isFinite(view.cx)?view.cx:-625,cz=Number.isFinite(view.cz)?view.cz:-247,scale=Number.isFinite(view.scale)?view.scale:.9;
 const rect=canvas.getBoundingClientRect(),depth=devicePixelRatio,width=canvas.width,height=canvas.height;
 const clamp=(value,limit)=>Math.max(0,Math.min(limit-1,value));
 const samples=rows.map(row=>{
  const box=boxes?.[row.id]??0;
  const px=clamp(Math.round((row.x-cx)*scale*depth+rect.width/2*depth),width),py=clamp(Math.round((row.z-cz)*scale*depth+rect.height/2*depth),height);
  const x=Math.max(0,px-box),y=Math.max(0,py-box),w=Math.min(width-1,px+box)-x+1,h=Math.min(height-1,py+box)-y+1;
  return {id:row.id,pixels:Array.from(context.getImageData(x,y,w,h).data)};
 });
 return {width,height,depth,cx,cz,scale,rectWidth:rect.width,rectHeight:rect.height,samples};
},{rows:rows.map(({id,x,z})=>({id,x,z})),boxes});
// A redraw the visitor cannot see the effect of: zoom in and straight back out.
const settle=async page=>{await page.locator('#zoom-in').click();await page.locator('#zoom-out').click();};
const markerPixels=(baseline,reading,row)=>{
 const before=baseline.samples.find(sample=>sample.id===row.id),after=reading.samples.find(sample=>sample.id===row.id);
 if(!before||!after)throw new Error('marker sample missing for '+row.id);
 let count=0;
 for(let index=0;index<after.pixels.length;index+=4)
  if(Math.abs(after.pixels[index]-before.pixels[index])>6||Math.abs(after.pixels[index+1]-before.pixels[index+1])>6||Math.abs(after.pixels[index+2]-before.pixels[index+2])>6)count++;
 return count;
};
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
 await context.addInitScript(()=>{
  window.mapFrame={tiles:0,regions:0};
  for(const method of ['setTransform','drawImage','stroke']){
   const native=CanvasRenderingContext2D.prototype[method];
   CanvasRenderingContext2D.prototype[method]=function(...args){
    if(this.canvas.id==='terrain'){
     if(method==='setTransform')window.mapFrame={tiles:0,regions:0};
     if(method==='drawImage')window.mapFrame.tiles++;
     if(method==='stroke'&&this.getLineDash().join(',')==='5,7')window.mapFrame.regions++;
    }
    return native.apply(this,args);
   };
  }
 });
 const files={windows:'Easter-Company-Windows-x64.exe',ubuntu:'Easter-Company-Linux-amd64.deb',arch:'Easter-Company-Linux-x64.pacman',appimage:'Easter-Company-Linux-x86_64.AppImage'};
 await context.route('**/releases/latest/download/*',route=>route.fulfill({body:'download flow fixture',headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+new URL(route.request().url()).pathname.split('/').at(-1)+'"'}}));
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 const noOverflow=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.goto(origin);await page.locator('[data-download-primary]').waitFor();
 assert.equal((await page.locator('h1').innerText()).replace(/\s+/g,' '),'The Ultimate Minecraft Experience');
 assert.equal(await page.locator('.download-link,#open-guide,#guide-dialog').count(),0);
 assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).count(),1);
 assert.equal(await page.locator('nav a[aria-current="page"]').textContent(),'Home');
 assert.equal(await page.getByRole('link',{name:'Wiki',exact:true}).getAttribute('href'),'./wiki/');await noOverflow();
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 const skipPage=await context.newPage();await skipPage.goto(origin);
 assert.equal(await skipPage.getByRole('button',{name:'Skip intro'}).count(),1);
 await skipPage.getByRole('button',{name:'Skip intro'}).click();
 assert.equal(await skipPage.locator('body').evaluate(el=>el.classList.contains('is-arriving')),false);
 assert(await skipPage.locator('.map-link').evaluate(el=>el===document.activeElement));await skipPage.close();
 const reduced=await browser.newContext({reducedMotion:'reduce'}),reducedPage=await reduced.newPage();
 await reducedPage.goto(origin);
 assert.equal(await reducedPage.locator('body').evaluate(el=>el.classList.contains('is-arriving')),false);
 assert.equal(await reducedPage.locator('.skip-arrival').isVisible(),false);
 assert.equal(await reducedPage.locator('.crest-frame').evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.equal(await reducedPage.locator('.wiki-link').getAttribute('href'),'wiki/');await reduced.close();
 await page.locator('.hero-copy').evaluate(async el=>{await Promise.all(el.getAnimations().map(animation=>animation.finished));});
 await page.screenshot({path:'/tmp/easter-public-home-desktop.png',fullPage:true});
 for(const trigger of [page.getByRole('button',{name:'Choose launcher platform',exact:true}),page.getByRole('navigation').getByRole('button',{name:'Download',exact:true})]){
  await trigger.click();await page.locator('#launcher-downloads').waitFor({state:'visible'});
  assert.equal(await page.locator('#launcher-downloads .platform-download').count(),4);
  assert.equal(await page.locator('[data-platform=source]').count(),0);
  for(const label of ['Windows 10+','Ubuntu','Arch','AppImage'])assert(await page.getByRole('link',{name:label,exact:false}).isVisible());
  await page.keyboard.press('Escape');assert.equal(await page.locator('#launcher-downloads').isVisible(),false);
 }
 const launcherDownloadPromise=page.waitForEvent('download');
 await page.locator('[data-download-primary]').click();
 const launcherDownload=await launcherDownloadPromise;assert.equal(await launcherDownload.failure(),null);assert(Object.values(files).includes(launcherDownload.suggestedFilename()));
 assert(await page.getByRole('dialog',{name:'Setup & Install',exact:true}).isVisible());
 await page.getByRole('button',{name:'Close setup instructions'}).click();
 for(const platform of ['windows','ubuntu','arch','appimage']){
  await page.getByRole('navigation').getByRole('button',{name:'Download',exact:true}).click();
  const manualDownloadPromise=page.waitForEvent('download');await page.locator('[data-platform="'+platform+'"]').click();
  const manualDownload=await manualDownloadPromise;assert.equal(await manualDownload.failure(),null);assert.equal(manualDownload.suggestedFilename(),files[platform]);
  assert(await page.getByRole('dialog',{name:'Setup & Install',exact:true}).isVisible());
  if(platform==='windows')await page.screenshot({path:'/tmp/easter-launcher-setup-desktop.png'});
  await page.keyboard.press('Escape');
 }
 for(const [platform,expected] of [['Windows','windows'],['Linux','appimage'],['macOS',null]]){
  const detected=await browser.newContext({acceptDownloads:true});await detected.addInitScript(platform=>Object.defineProperty(navigator,'userAgentData',{value:{platform}}),platform);
  await detected.route('**/releases/latest/download/*',route=>route.fulfill({body:'download flow fixture',headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+new URL(route.request().url()).pathname.split('/').at(-1)+'"'}}));
  const detectedPage=await detected.newPage();await detectedPage.goto(origin);await detectedPage.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  if(expected){const pending=detectedPage.waitForEvent('download');await detectedPage.locator('[data-download-primary]').click();assert.equal((await pending).suggestedFilename(),files[expected]);}
  else{await detectedPage.locator('[data-download-primary]').click();assert(await detectedPage.locator('#launcher-downloads').isVisible());}
  await detected.close();
 }
 for(const size of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
  await page.setViewportSize(size);await noOverflow();
  await page.getByRole('navigation').getByRole('button',{name:'Download',exact:true}).click();
  const menu=await page.locator('#launcher-downloads').boundingBox();assert(menu.x>=0&&menu.x+menu.width<=size.width+1&&menu.y>=0&&menu.y+menu.height<=size.height+1);
  if(size.width===390)await page.screenshot({path:'/tmp/easter-launcher-menu-mobile.png'});
  await page.keyboard.press('Escape');
  const mobileDownloadPromise=page.waitForEvent('download');await page.locator('[data-download-primary]').click();await mobileDownloadPromise;
  const setup=await page.locator('#launcher-setup').boundingBox();assert(setup.x>=0&&setup.x+setup.width<=size.width+1&&setup.y>=0&&setup.y+setup.height<=size.height+1);
  if(size.width===390)await page.screenshot({path:'/tmp/easter-launcher-setup-mobile.png'});
  await page.keyboard.press('Escape');
  if(size.width===390)await page.screenshot({path:'/tmp/easter-public-home-mobile.png',fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});await page.getByRole('link',{name:'View Map',exact:true}).click();
 const ready=()=>page.waitForFunction(()=>window.mapFrame.tiles>0&&document.getElementById('map-status').hidden);
 await ready();await noOverflow();
 assert.equal(await page.getByRole('toolbar',{name:'Map controls'}).locator('button').count(),4,'only viewing controls are public');
 assert.equal(await page.locator('nav a[aria-current="page"]').textContent(),'Map');
 assert.equal(await page.locator('.atlas-heading,.atlas-home,#refresh').count(),0);
 const toolbarBox=await page.locator('.map-controls').boundingBox(),compassBox=await page.locator('.compass').boundingBox();
 assert(compassBox.x+compassBox.width<(await page.locator('.map-key').boundingBox()).x);
 assert((await page.locator('.map-key').boundingBox()).y-(await page.locator('.atlas-stage').boundingBox()).y<=22);
 assert.equal(await page.locator('.arrival-mist,.skip-arrival').count(),0,'the atlas never plays the homepage intro');
 assert((await page.locator('#snapshot-date').textContent()).includes('Charted'));
 await page.screenshot({path:'/tmp/easter-public-map-desktop.png'});
 await page.locator('#map-key summary').click();assert.equal(await page.locator('[data-layer]:checked').count(),6);
 // The public key lists the published categories only. Player factions are not published.
 const chart=await (await fetch(origin+'/data/world.json',{cache:'no-cache'})).json();
 const chartHas=Object.fromEntries(Object.keys(MARKERS).map(kind=>[kind,chart.markers.some(marker=>marker.kind===kind)]));
 const keyText=(await page.locator('#map-key').innerText()).toLowerCase();
 assert.deepEqual(await legendLabels(page),['Regions','Ships','Sea Patrols','Land Patrols','Villagers','Mobs']);
 assert.deepEqual(await markerCategories(page),Object.keys(MARKERS),'each marker category has exactly one key entry');
 // The key's own swatches must be the colours the map draws markers with.
 const swatches=await page.locator('.map-key .legend [data-layer]').evaluateAll(inputs=>Object.fromEntries(inputs.map(input=>[input.dataset.layer,String(getComputedStyle(input.nextElementSibling).backgroundColor)])));
 for(const [kind,{colour}] of Object.entries(MARKERS))assert.equal(swatches[kind],`rgb(${colour.join(', ')})`,`the ${kind} key entry must show its marker colour`);
 for(const removed of ['navy','citizen','criminal','pirate','prisoner','other markers','other'])
  assert(!keyText.includes(removed),`the map key must not list ${removed}`);
 // Baseline: every marker category unticked, so the tile beneath each published marker is
 // known and marker pixels can be counted as the difference from it.
 const geometry=await canvasGeometry(page);
 const visibleRows=chart.markers.filter(row=>inViewport(geometry,row));
 const visible=kind=>visibleRows.filter(row=>row.kind===kind);
 for(const category of Object.keys(MARKERS))await page.locator(`[data-layer="${category}"]`).uncheck();
 await settle(page);
 // Two markers closer together than a marker is wide share canvas pixels, so a box around
 // one of them legitimately contains the other's ink. Each category is therefore probed at
 // the markers that stand alone, which is enough to prove that ticking a category draws its
 // own markers and nothing else. MARKER_SEPARATION is a device-pixel distance.
 const MARKER_SEPARATION=34;
 const isolated=row=>visibleRows.every(other=>other.id===row.id||Math.hypot(...devicePoint(geometry,row).map((value,axis)=>value-devicePoint(geometry,other)[axis]))>=MARKER_SEPARATION);
 const sampleRows=visibleRows.filter(isolated);
 const boxes=Object.fromEntries(sampleRows.map(row=>[row.id,boxFor(geometry,row,sampleRows)]));
 const sampled=kind=>sampleRows.filter(row=>row.kind===kind);
 const baseline=await probeReading(page,sampleRows,boxes);
 for(const category of Object.keys(MARKERS)){
  await page.locator(`[data-layer="${category}"]`).check();
  await settle(page);
  const drawn=await probeReading(page,sampleRows,boxes),rows=sampled(category);
  // Marker positions repeat in this world (several hulls and patrols share a mooring), so a
  // category can legitimately have no isolated marker in this snapshot. The fixture block
  // below is where every category is proven independently; here the live chart only has to
  // show that a category with an isolated marker draws it and leaks nothing else.
  for(const row of rows)assert(markerPixels(baseline,drawn,row)>0,`the published ${category} marker must be drawn at its position`);
  for(const [other,others] of Object.entries(MARKERS))if(other!==category)for(const row of sampled(other))assert.equal(markerPixels(baseline,drawn,row),0,`ticking ${category} must not draw a ${other} marker`);
  await page.locator(`[data-layer="${category}"]`).uncheck();
  await settle(page);
  const off=await probeReading(page,sampleRows,boxes);
  for(const row of rows)assert.equal(markerPixels(baseline,off,row),0,`unticking ${category} must remove its marker from the canvas`);
 }
 for(const category of Object.keys(MARKERS))await page.locator(`[data-layer="${category}"]`).check();
 await settle(page);
 // A redraw must keep every category drawn.
 const redrawn=await probeReading(page,sampleRows,boxes);
 for(const category of Object.keys(MARKERS))for(const row of sampled(category))assert(markerPixels(baseline,redrawn,row)>0,`a redraw must keep the ${category} marker drawn`);
 await page.locator('#map-key summary').click();
 const toCanvas=row=>page.evaluate(row=>{
  const saved=JSON.parse(localStorage.getItem('easter-co-atlas-ui')),view=saved.view,rect=document.getElementById('terrain').getBoundingClientRect();
  return {x:rect.left+(row.x-view.cx)*view.scale+rect.width/2,y:rect.top+(row.z-view.cz)*view.scale+rect.height/2};
 },row);
 const tooltipName={ship:'ship',sea_patrol:'sea patrol',land_patrol:'land patrol',villager:'villager'};
 for(const target of ['ship','sea_patrol','land_patrol','villager']){
  const row=chart.markers.find(marker=>marker.kind===target);
  assert(row,`the chart must publish a ${target} marker`);
  const position=await toCanvas(row);
  await page.mouse.move(position.x,position.y);
  await page.locator('#map-tooltip').waitFor({state:'visible'});
  assert.equal(await page.locator('#map-tooltip strong').textContent(),row.name);
  const tooltip=(await page.locator('#map-tooltip small').innerText()).toLowerCase();
  assert(tooltip.includes(tooltipName[target]),`tooltip must name the ${target} category: ${tooltip}`);
  assert(tooltip.includes('observed '+new Date(row.observed_at).toLocaleString().toLowerCase()),`tooltip must show the observed time: ${tooltip}`);
  await page.mouse.move(20,860);await page.locator('#map-tooltip').waitFor({state:'hidden'});
 }
 await page.locator('#map-key summary').click();
 await page.getByLabel('Regions',{exact:true}).uncheck();assert.equal(await page.evaluate(()=>window.mapFrame.regions),0);
 await page.locator('#terrain').focus();await page.keyboard.press('ArrowRight');
 const moved=await page.locator('#map-coordinates').textContent();await page.reload();await ready();
 assert.equal(await page.locator('#map-coordinates').textContent(),moved);
 assert(!(await page.getByLabel('Regions',{exact:true}).isChecked()));assert(await page.locator('#map-key').evaluate(el=>el.open));
 await page.getByLabel('Regions',{exact:true}).check();assert((await page.evaluate(()=>window.mapFrame.regions))>0);
 await page.locator('#home').click();await ready();
 const beforeMiddle=await page.locator('#map-coordinates').textContent();
 await page.mouse.move(700,450);await page.mouse.down({button:'middle'});await page.mouse.move(750,480,{steps:5});await page.mouse.up({button:'middle'});
 assert.notEqual(await page.locator('#map-coordinates').textContent(),beforeMiddle);await page.locator('#home').click();
 await page.locator('#zoom-in').click();await page.locator('#zoom-out').click();
 await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);
 await page.locator('#fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);
 for(const size of [{width:390,height:844},{width:844,height:390}]){
  await page.setViewportSize(size);await ready();await noOverflow();
  const panel=await page.locator('.key-content').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=size.width+1);
  for(const button of await page.locator('.map-controls button').all()){const r=await button.boundingBox();assert(r.y>=0&&r.y+r.height<=size.height);}
  if(size.width===390)await page.screenshot({path:'/tmp/easter-public-map-mobile.png'});
 }
 await page.setViewportSize({width:1440,height:900});await page.locator('#home').click();await ready();
 let manifest=await page.evaluate(async()=>{const {createMapCache}=await import('/map/cache.mjs');return createMapCache().readSnapshot('world');});
 assert(manifest.markers.every(r=>Object.hasOwn(MARKERS,r.kind)),'the saved chart carries only published marker categories');
 const tile=manifest.tiles.find(r=>r.x===Math.floor(manifest.center[0]/512)&&r.z===Math.floor(manifest.center[1]/512));assert(tile);
 const sampleWorld={x:tile.x*512+128,z:tile.z*512+128};
 const sample=()=>page.locator('#terrain').evaluate((canvas,{center,x,z})=>{
  const px=Math.round(((x-center[0])*.9+canvas.clientWidth/2)*devicePixelRatio),py=Math.round(((z-center[1])*.9+canvas.clientHeight/2)*devicePixelRatio);
  return [...canvas.getContext('2d').getImageData(px,py,1,1).data];
 },{center:manifest.center,...sampleWorld});
 const originalPixel=await sample();
 // Every saved layer renders with the live manifest deliberately held back.
 const manifestGate=deferred(),tileGate=deferred();let failTile=true;
 const replacements=await page.evaluate(()=>['#ff00ff','#00ff00'].map(color=>{const c=document.createElement('canvas');c.width=16;c.height=16;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,16,16);return c.toDataURL().split(',')[1];}));
 const bytes=replacements.map(s=>Buffer.from(s,'base64')),hashes=bytes.map(b=>createHash('sha256').update(b).digest('hex'));
 manifest=structuredClone(manifest);manifest.tiles.find(r=>r.x===tile.x&&r.z===tile.z).version=hashes[0];
 await page.route('**/data/world.json',async r=>{await manifestGate.promise;return r.fulfill({json:manifest});});
 await page.route(`**/data/tiles/${tile.x}/${tile.z}.png?*`,async r=>{await tileGate.promise;return failTile?r.fulfill({status:503,body:'try later'}):r.fulfill({contentType:'image/png',body:bytes[0]});});
 await page.reload();await page.waitForFunction(()=>window.mapFrame.tiles>0&&window.mapFrame.regions>0);
 assert.deepEqual(await sample(),originalPixel);assert((await page.locator('#map-status').textContent()).includes('saved chart'));
 const onDisk=await page.evaluate(async()=>{const {createMapCache}=await import('/map/cache.mjs');return createMapCache().readSnapshot('world');});
 assert.equal(onDisk.markers.length,manifest.markers.length);
 manifestGate.resolve();await page.locator('#map-status').filter({hasText:'Updating the chart'}).waitFor();
 assert.deepEqual(await sample(),originalPixel);tileGate.resolve();
 await page.locator('#map-status').filter({hasText:'keeping saved terrain'}).waitFor();assert.deepEqual(await sample(),originalPixel);
 failTile=false;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 for(let i=0;i<100;i++){if((await sample()).join(',')==='255,0,255,255')break;await page.waitForTimeout(25);}
 assert.deepEqual(await sample(),[255,0,255,255]);
 // A deployment serving mismatched bytes must retain the prior verified tile.
 manifest.tiles.find(r=>r.x===tile.x&&r.z===tile.z).version=hashes[1];await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await page.locator('#map-status').filter({hasText:'keeping saved terrain'}).waitFor();assert.deepEqual(await sample(),[255,0,255,255]);
 const clean=await (await fetch(origin+'/data/world.json',{cache:'no-cache'})).json();
 const published=new Set(Object.keys(MARKERS));
 assert(clean.markers.every(marker=>published.has(marker.kind)),'only the published categories may appear in the chart');
 assert(clean.markers.every(marker=>!('faction' in marker)),'a public marker must carry no faction');
 const required=['ship','sea_patrol','land_patrol','villager'];
 assert.deepEqual(required.filter(kind=>!clean.markers.some(marker=>marker.kind===kind)),[],'the sample chart must contain every published category for the key checks');
 assert.equal(new Set(Object.values(MARKERS).map(entry=>entry.hex)).size,Object.keys(MARKERS).length,'every category colour is distinct');
 // Markers of each category, far apart, in a fixture that does not depend on the live snapshot.
 const placed=[['ship',0,0],['sea_patrol',630,0],['land_patrol',0,630],['villager',315,630],['mob',630,630]].map(([kind,x,z])=>({
  id:kind.padEnd(20,'0'),kind,name:kind[0].toUpperCase()+kind.slice(1)+' Fixture',x,z,observed_at:new Date().toISOString(),icon:{ship:'hull',sea_patrol:'navy_ship',land_patrol:'navy_unit-guard'}[kind]||undefined}));
 // Half scale with the labels a screen apart, so every fixture marker is well inside the viewport.
 const fixture={...clean,markers:placed,center:[315,315]};
 {
  const fixtureContext=await browser.newContext({viewport:{width:1440,height:900}});
  try{
   await fixtureContext.addInitScript(markerHookWithTiles);
   await fixtureContext.route('**/data/world.json',route=>route.fulfill({json:fixture}));
   // A visitor arriving with the removed faction layers still saved from the old key.
   await fixtureContext.addInitScript(()=>localStorage.setItem('easter-co-atlas-ui',JSON.stringify({layers:{navy:false,citizen:false,criminal:false,pirate:false,prisoner:false,other:false},view:{cx:315,cz:315,scale:.5}})));
   const fixturePage=await fixtureContext.newPage(),fixtureErrors=[];
   fixturePage.on('pageerror',e=>fixtureErrors.push(e.message));
   await fixturePage.goto(origin+'/map/');
   await fixturePage.waitForFunction(()=>window.mapFrame.tiles>0&&document.getElementById('map-status').hidden);
   await fixturePage.locator('#map-key summary').click();
   // Saved settings from the removed player-faction layers must not hide a marker category.
   for(const category of Object.keys(MARKERS))assert(await fixturePage.locator(`[data-layer="${category}"]`).isChecked(),`${category} must default to visible with the old faction settings saved`);
   const plot=category=>placed.find(row=>row.kind===category);
   const fixtureGeometry=await canvasGeometry(fixturePage);
   const placedBoxes=Object.fromEntries(placed.map(row=>[row.id,boxFor(fixtureGeometry,row,placed)]));
   for(const category of Object.keys(MARKERS))await fixturePage.locator(`[data-layer="${category}"]`).uncheck();
   await settle(fixturePage);
   const bare=await probeReading(fixturePage,placed,placedBoxes);
   for(const category of Object.keys(MARKERS)){
    await fixturePage.locator(`[data-layer="${category}"]`).check();
    await settle(fixturePage);
    const drawn=await probeReading(fixturePage,placed,placedBoxes);
    assert(markerPixels(bare,drawn,plot(category))>0,`the ${category} marker must be drawn at its own position`);
    for(const other of Object.keys(MARKERS))if(other!==category)assert.equal(markerPixels(bare,drawn,plot(other)),0,`ticking ${category} must not draw a ${other} marker`);
    await fixturePage.locator(`[data-layer="${category}"]`).uncheck();
    await settle(fixturePage);
    assert.equal(markerPixels(bare,await probeReading(fixturePage,placed,placedBoxes),plot(category)),0,`unticking ${category} must remove its marker from the canvas`);
   }
   for(const category of Object.keys(MARKERS))await fixturePage.locator(`[data-layer="${category}"]`).check();
   await settle(fixturePage);
   const all=await probeReading(fixturePage,placed,placedBoxes);
   for(const category of Object.keys(MARKERS))assert(markerPixels(bare,all,plot(category))>0,`a redraw must keep the ${category} marker drawn`);
   await fixturePage.locator('#map-key summary').click();
   assert.deepEqual(fixtureErrors,[]);
   await fixtureContext.close();
  }finally{await fixtureContext.close().catch(()=>{});}
 }
 // A reading from hours ago is still drawn, but hollow: the same marker kind observed now
 // is filled with its key colour. The live chart's own age mix is not assumed.
 {
  // The chart calls a reading old when the snapshot is more than five minutes newer than the
  // observation (site/map/map.js: captured_at - observed_at > 300000). Building these from the
  // clock made the test a time bomb: it only held while now-90min was still before the
  // snapshot's own captured_at, and every daily export moves that. Anchoring both readings to
  // the snapshot makes the case hold at any hour, on any snapshot.
  const snapshot='2026-01-01T12:00:00.000Z';
  const minutes=n=>new Date(Date.parse(snapshot)-n*60000).toISOString();
  const aged={...structuredClone(clean),captured_at:snapshot,center:[250,100],markers:[
   {id:'1'.repeat(20),kind:'ship',icon:'hull',name:'Fresh hull',x:100,z:100,observed_at:minutes(-1)},
   {id:'2'.repeat(20),kind:'ship',icon:'hull',name:'Older hull',x:400,z:100,observed_at:minutes(90)}]};
  const agedContext=await browser.newContext({viewport:{width:1440,height:900}});
  try{
   await agedContext.addInitScript(markerHookWithTiles);
   // A saved view, as a returning visitor has: without it the chart opens on its own default
   // centre and a screen position computed from one centre would sample the wrong pixel.
   await agedContext.addInitScript(()=>localStorage.setItem('easter-co-atlas-ui',JSON.stringify({view:{cx:250,cz:100,scale:.9}})));
   await agedContext.route('**/data/world.json',route=>route.fulfill({json:aged}));
   const agedPage=await agedContext.newPage(),agedErrors=[];
   agedPage.on('pageerror',e=>agedErrors.push(e.message));
   await agedPage.goto(origin+'/map/');
   await agedPage.waitForFunction(()=>window.mapFrame.tiles>0&&document.getElementById('map-status').hidden);
   await agedPage.locator('#map-key summary').click();
   await agedPage.locator('[data-layer="ship"]').uncheck();
   await settle(agedPage);
   const agedGeometry=await canvasGeometry(agedPage);
   const agedBoxes=Object.fromEntries(aged.markers.map(row=>[row.id,boxFor(agedGeometry,row,aged.markers)]));
   const bare=await probeReading(agedPage,aged.markers,agedBoxes);
   await agedPage.locator('[data-layer="ship"]').check();
   await settle(agedPage);
   const drawn=await probeReading(agedPage,aged.markers,agedBoxes);
   for(const row of aged.markers)assert(markerPixels(bare,drawn,row)>0,`the ${row.name} reading must be drawn`);
   // The current reading is filled with the key colour; the hours-old one is left hollow, so
   // the chart shows through its middle.
   // Let the redraw from the last toggle settle before sampling, then look at the marker's
   // own pixels rather than one centre pixel: a marker carries a dark glyph, so a single
   // sample can land on the glyph instead of the fill.
   await agedPage.waitForTimeout(250);
   const markerColours=async row=>agedPage.locator('#terrain').evaluate((canvas,row)=>{
    const save=JSON.parse(localStorage.getItem('easter-co-atlas-ui')||'{}'),view=save.view||{cx:-625,cz:-247,scale:.9},rect=canvas.getBoundingClientRect(),depth=devicePixelRatio;
    const px=Math.round(((row.x-view.cx)*view.scale+rect.width/2)*depth),py=Math.round(((row.z-view.cz)*view.scale+rect.height/2)*depth);
    const data=canvas.getContext('2d').getImageData(px-7,py-7,15,15).data,counts=new Map();
    for(let index=0;index<data.length;index+=4){const key=data[index]+','+data[index+1]+','+data[index+2];counts.set(key,(counts.get(key)||0)+1);}
    return [...counts.entries()].sort((left,right)=>right[1]-left[1]).map(entry=>entry[0]);
   },row);
   const freshColours=await markerColours(aged.markers[0]);
   assert(freshColours[0]===MARKERS.ship.colour.join(','),'a current reading is filled in its key colour');
   assert(!(await markerColours(aged.markers[1])).includes(MARKERS.ship.colour.join(',')),'an older reading is not filled in its key colour');
   assert.deepEqual(agedErrors,[]);
   await agedContext.close();
  }finally{await agedContext.close().catch(()=>{});}
 }
 // An older saved snapshot whose marker kind this build has no key entry for is skipped,
 // never drawn and never fatal, while the known category in the same snapshot still draws.
 {
  const stale=structuredClone(clean);
  stale.markers=[{id:'f'.repeat(20),kind:'frigate',name:'Unknown kind',x:600,z:600,observed_at:stale.captured_at},
                 {id:'e'.repeat(20),kind:'ship',icon:'hull',name:'Known ship',x:-625,z:-247,observed_at:stale.captured_at}];
   const restored=structuredClone(clean);
   restored.markers=[{id:'e'.repeat(20),kind:'ship',icon:'hull',name:'Known ship',x:-625,z:-247,observed_at:restored.captured_at}];
  const staleContext=await browser.newContext({viewport:{width:1440,height:900}});
  try{
   await staleContext.addInitScript(markerHookWithTiles);
   // A failed live refresh is what makes the page fall back to the snapshot in its cache.
   await staleContext.route('**/data/world.json',route=>route.fulfill({status:503,body:'unavailable'}));
   const stalePage=await staleContext.newPage(),staleErrors=[];
   stalePage.on('pageerror',e=>staleErrors.push(e.message));
   await stalePage.goto(origin+'/map/');
   const seed=snapshot=>stalePage.evaluate(async value=>{
    const {createMapCache}=await import('/map/cache.mjs');
    await createMapCache().writeSnapshot('world',value);
   },snapshot);
   // A saved snapshot is judged as a whole before it is used. One carrying a marker kind this
   // build has no category for is refused and the saved chart is dropped; the assertions here
   // state that behaviour rather than assume the unknown kind is skipped marker by marker.
   await seed(stale);
   await stalePage.reload();
   // The tiles are served locally, so a refused snapshot simply has nothing to draw.
   await stalePage.waitForTimeout(1500);
   assert.equal(await stalePage.locator('#map-status').textContent(),'Chart unavailable · retrying automatically','a snapshot with an unknown marker kind must be refused as a whole');
   assert.equal(await stalePage.evaluate(()=>window.mapFrame.tiles),0,'a refused snapshot must not draw its tiles');
   // The same saved chart without the unknown kind is accepted as a usable saved chart. The
   // tiles themselves are not asserted here: the live-refresh tests above already cover tile
   // drawing, and this block is about how a saved snapshot is judged before it is used.
   await seed(restored);
   await stalePage.reload();
   await stalePage.waitForFunction(()=>document.getElementById('map-status').textContent.includes('saved chart'),{timeout:20000});
   assert.equal(await stalePage.locator('#snapshot-date').textContent()!=='',true,'a restored saved chart reports its chart date');
   await stalePage.locator('#home').click();
   assert.notEqual(await stalePage.locator('#map-coordinates').textContent(),'');
   assert.deepEqual(staleErrors,[]);
   await staleContext.close();
  }finally{await staleContext.close().catch(()=>{});}
 }
 assert(requests.every(r=>r.method==='GET'));
 assert(!requests.some(r=>r.url.includes('/minecraft/')||r.url.includes('/api/')));
 // The download-first flow is desktop-only. A plain browser must show none of it.
 assert.equal(await page.locator('#launcher-bar').count(),0,'the sticky bar is a launcher affordance');
 assert.equal(await page.locator('[data-desktop-play],[data-desktop-nav],.desktop-account-nav,.desktop-install').count(),0,'no desktop affordance may leak into the public page');
 assert.equal(await page.getByRole('button',{name:/sign in/i}).count(),0,'the public page never offers sign-in');
 assert(!(await page.locator('body').innerText()).includes('Download the game'),'the public page keeps its own download copy');
 assert.deepEqual(errors,[]);
 console.log('PUBLIC SITE PASS: responsive home, launcher downloads, read-only map, six-entry key with per-category filtering, snapshots with an unknown marker kind refused, pan/zoom/middle/fullscreen, preferences, persistent cached rendering, incremental refresh, failure retention, checksum validation, no private API calls');
 // The shared-UI half of the download-first flow, driven entirely through a stub of the
 // existing easterDesktop bridge. Every state in doc/launcher-states.md is pushed into the
 // renderer here, so the hero, the bar and the Play gate are proven against the contract
 // rather than against the happy path. This is not the live main process.
 {
  // A controllable bridge: status() hands over one state object, onState gives the renderer
  // its updates, and every action the UI can take is recorded and answered locally.
  const desktopFixture=state=>{
   // A real main process keeps broadcasting its state, so the last state pushed before a
   // navigation is merged back over the initial one here. Calls are kept the same way,
   // because a navigation reloads the page but not the process behind the bridge.
   let carried={};
   try{carried=JSON.parse(localStorage.getItem('easter-renderer-state')||'{}');}catch{carried={};}
   const merge=Object.assign({},state,carried);
   // The nested objects are the ones the renderer reads every field of, so the carried
   // copy must be its own rather than aliasing the recipe the run was built from.
   for(const key of ['settings','install','graphics','hardware','bar'])if(merge[key]&&typeof merge[key]==='object')merge[key]=Object.assign({},merge[key]);
   // The profile's verified addresses, as the owner-only read answers them. The stub keeps
   // the same record the route does, so a saved choice is read back rather than remembered.
   window.easterRenderer={state:merge,nextLocation:null,refuse:null,calls:[],errors:[],
    emails:{emails:[{email:'captain@example.test',provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:true},{email:'crew@example.test',provider:'microsoft',verifiedAt:'2026-01-02T00:00:00Z',login:false}],loginEmail:'captain@example.test'}};
   window.addEventListener('pageerror',event=>window.easterRenderer.errors.push(event.message));
   const renderer=window.easterRenderer;
   const log=(name,payload)=>{renderer.calls.push(payload===undefined?{name}:{name,payload});try{localStorage.setItem('easter-renderer-calls',JSON.stringify(renderer.calls));}catch{}};
   const mirror=()=>{try{localStorage.setItem('easter-renderer-state',JSON.stringify(renderer.state));}catch{}};
   try{renderer.calls=JSON.parse(localStorage.getItem('easter-renderer-calls')||'[]');}catch{renderer.calls=[];}
   window.easterDesktop={
    mode:'desktop',
    status:async()=>renderer.state,
    onState:callback=>{renderer.emit=callback;},
    // The three answers a real Microsoft sign-in can give: a completed device-code flow (which
    // may carry Microsoft's own note about the account's email address), a refusal, or a flow
    // the test holds open so it can push state while it is still running.
    signIn:async options=>{
     log('signIn',options);
     if(renderer.signInHold)return new Promise((resolve,reject)=>{renderer.signInSettle={resolve,reject};});
     if(renderer.signInError)throw Error(renderer.signInError);
     return renderer.signInAnswer;
    },
    // The saved-session shortcut the chooser's "Sign in with Microsoft" button takes. Its
    // failure carries a code, exactly as the preload hands one over.
    continueMicrosoft:async()=>{
     log('continueMicrosoft');
     if(renderer.continueRefusal){
      const failure=Error(renderer.continueRefusal.message);
      failure.code=renderer.continueRefusal.code;throw failure;
     }
     return renderer.continueAnswer;
    },
    play:async()=>{log('play');if(renderer.playError)throw Error(renderer.playError);},
    chooseInstallLocation:async()=>{log('chooseInstallLocation');return renderer.nextLocation||renderer.state.install.defaultLocation;},
    startInstall:async options=>{log('startInstall',options);if(renderer.refuse){const message=renderer.refuse;renderer.refuse=null;throw Error(message);}},
    pause:async()=>{log('pause');},
    resume:async()=>{log('resume');},
    // The amended contract's graphics choice: main writes the client's own quality
    // settings and reports the new state back, which the renderer then renders. A refused
    // change is settled in the state it broadcasts *and* rejects the call, exactly as
    // desktop/main.cjs does, so the renderer has to keep that one failure on one surface.
    setGraphics:async enabled=>{log('setGraphics',enabled);
     if(renderer.graphicsError){renderer.state.error=renderer.graphicsError;mirror();renderer.emit?.(renderer.state);throw Error(renderer.graphicsError);}
     renderer.state.graphics=Object.assign({},renderer.state.graphics,{enabled:Boolean(enabled)});mirror();renderer.emit?.(renderer.state);},
    cancelSignIn:async()=>{log('cancelSignIn');},
    refreshAccount:async()=>{log('refreshAccount');},
    profileEmails:async()=>{log('profileEmails');return renderer.emails;},
    selectLoginEmail:async email=>{
     log('selectLoginEmail',email);
     if(email!==null&&!renderer.emails.emails.some(entry=>entry.email===email))return {ok:false,code:'email_not_yours',error:'That address cannot be your login email. It is not verified for this account, or another Easter Company account already uses it to sign in.'};
     renderer.emails={emails:renderer.emails.emails.map(entry=>({...entry,login:entry.email===email})),loginEmail:email};
     return {ok:true,value:renderer.emails};
    },
    signOut:async()=>{log('signOut');},
    signOutAccount:async()=>{log('signOutAccount');},
    // The server-held session's own two controls: a retry that only asks the account service
    // again, and the sign-out-everywhere action the profile dialog offers. Both answer with the
    // sentence main would have printed, so the view never words an outcome for itself.
    refreshMinecraftSession:async()=>{log('refreshMinecraftSession');return renderer.state.minecraftSession;},
    signOutMinecraft:async()=>{log('signOutMinecraft');return renderer.signOutMinecraftAnswer||{revoked:true,message:'Signed Minecraft out everywhere. The next game on any computer needs a Microsoft sign-in.'};},
    openFolder:async()=>{},
    openMicrosoft:async()=>{log('openMicrosoft');if(renderer.openMicrosoftError)throw Error(renderer.openMicrosoftError);},
    chooseJava:async()=>null,
    // A real main persists the client settings, so the values are kept here and the
    // status() handed back carries them, exactly as a relaunch would.
    saveSettings:async values=>{log('saveSettings',values);renderer.state.settings=Object.assign({},renderer.state.settings,values);mirror();return renderer.state.settings;}
   };
  };
  const launcherState=patch=>Object.assign({version:'1.0.0',totalMemoryMB:16384,remembered:true,profile:null,account:null,device:null,sessionExpiresAt:0,message:'',
   // The settings main really publishes: no server address, because the launcher targets
   // one fixed production server and the player has no say in it.
   settings:{memoryMB:4096,javaPath:''},install:{location:null,defaultLocation:'/home/player/.easter-company/minecraft',installed:false,includeGraphics:true,version:null,updatedAt:null},
   // The amended contract's own fields: what the machine is and what the graphics choice
   // will be. There is no `servers` list, and no view may invent one.
   hardware:{gpu:'NVIDIA GeForce RTX 3070',vendor:'NVIDIA',vramMB:8192,tier:'capable',reason:'Discrete GPU with 8192 MB of video memory.'},
   graphics:{enabled:false,recommended:true,tunable:true,tuned:null,reason:'Discrete GPU with 8192 MB of video memory.'},
   progress:null,actions:['download'],paused:false,canPlay:false,bar:{visible:false}},patch);
  const progressFor=patch=>Object.assign({label:'Downloading the Easter Company client',percent:42,bytesDone:438304768,bytesTotal:1048576000,bytesPerSecond:6291456,etaSeconds:97},patch);
  const INSTALLED={location:'/home/player/.easter-company/minecraft',defaultLocation:'/home/player/.easter-company/minecraft',installed:true,includeGraphics:true,version:'26.2',updatedAt:null};
  const launcherContext=await browser.newContext({viewport:{width:1440,height:900}});
  const launcherErrors=[];
  try{
   await launcherContext.addInitScript(desktopFixture,launcherState({}));
   const launcherPage=await launcherContext.newPage();
   // Collect failures for the whole block: the fixture array is reset by every reload.
   launcherPage.on('pageerror',error=>launcherErrors.push(error.message));
   await launcherPage.goto(origin);
   // The preference is renderer-local and survives a reload, so the run starts by clearing it
   // once, here rather than in an init script: an init script would erase the very preference
   // the navigation checks are about.
   await launcherPage.evaluate(()=>{try{for(const key of ['easter-co-launcher-bar','easter-renderer-calls','easter-renderer-state'])localStorage.removeItem(key);}catch{}});
   await launcherPage.reload();
   await launcherPage.waitForFunction(()=>window.easterRenderer&&window.easterRenderer.emit);
   const heroButton=launcherPage.locator('[data-desktop-play]');
   await heroButton.waitFor();
   const pushState=async patch=>{await launcherPage.evaluate(values=>{
    for(const [key,value] of Object.entries(values))window.easterRenderer.state[key]=value&&typeof value==='object'?structuredClone(value):value;
    try{localStorage.setItem('easter-renderer-state',JSON.stringify(window.easterRenderer.state));}catch{}
    window.easterRenderer.emit(window.easterRenderer.state);
   },patch);};
   const heroAction=summary=>{
    assert.equal(summary.action,summary.expect,summary.name+': hero action must follow the state');
    // Play must never appear because the install finished alone, so outside canPlay the
    // hero carries no Play label at all.
    if(summary.expect==='play')assert(summary.text.startsWith('PLAY NOW'),summary.name+': the hero must become one large PLAY NOW: '+summary.text);
    // The CTA itself, not the word: "Link Microsoft to play" is an account action that says
    // what it is for, and the thing that must never appear before canPlay is PLAY NOW.
    else assert(!summary.text.includes('PLAY NOW'),summary.name+': Play must be absent until canPlay: '+summary.text);
   };
   const hero=async()=>({text:(await heroButton.innerText()).replace(/\s+/g,' '),action:await heroButton.getAttribute('data-action')});
   const barVisibleNow=()=>launcherPage.locator('#launcher-bar').isVisible();
   const calls=()=>launcherPage.evaluate(()=>window.easterRenderer.calls);
   const callsNamed=async name=>(await calls()).filter(call=>call.name===name);
   const visibleErrors=()=>launcherPage.evaluate(()=>[...document.querySelectorAll('.desktop-page-notice,.desktop-auth-error,.desktop-status')]
    .filter(node=>!node.hidden&&node.getClientRects().length>0&&node.textContent.trim())
    .map(node=>node.classList.contains('desktop-page-notice')?'desktop-page-notice':node.classList.contains('desktop-auth-error')?'desktop-auth-error':'desktop-status'));

   // 1. Uninstalled: the hero asks for the game, and no bar exists yet.
   heroAction({name:'uninstalled',...await hero(),expect:'download'});
   assert.equal(await barVisibleNow(),false,'the bar must stay hidden until a download starts');
   assert.equal(await launcherPage.evaluate(()=>document.documentElement.classList.contains('desktop-mode')),true);

   // 2. Downloading without an account: the bar appears and the hero asks for sign-in.
   await pushState({phase:'downloading',progress:progressFor(),actions:['signin'],bar:{visible:true}});
   heroAction({name:'downloading',...await hero(),expect:'signin'});
   assert.equal(await barVisibleNow(),true,'the bar must appear once the download starts');
   assert.equal((await launcherPage.locator('.launcher-bar-label').textContent()).includes('Downloading'),true);
   const barMeta=await launcherPage.locator('.launcher-bar-meta').textContent();
   assert(barMeta.includes('418 MB of 1000 MB'),'the bar must show the transfer size: '+barMeta);
   assert(barMeta.includes('6.0 MB/s'),'the bar must show the transfer speed: '+barMeta);
   assert(barMeta.includes('left'),'the bar must show the remaining time when one is known: '+barMeta);
   assert.equal(await launcherPage.locator('.launcher-bar-track').getAttribute('aria-valuenow'),'42');
   assert.equal(await launcherPage.locator('[data-bar-pause]').isVisible(),true,'pause is offered during a transfer');
   assert.equal(await launcherPage.locator('[data-bar-resume]').isVisible(),false,'resume is not offered mid-download');
   // The bar's contents are left aligned, as the contract requires.
   const barBox=await launcherPage.locator('#launcher-bar').boundingBox();
   const infoBox=await launcherPage.locator('.launcher-bar-info').boundingBox();
   assert(Math.abs(infoBox.x-(barBox.x+(infoBox.x-barBox.x)))<1&&infoBox.x-barBox.x<barBox.width/2,'bar contents must be left aligned');
   assert(Math.abs((barBox.x+barBox.width/2)-720)<2,'the bar must sit at the bottom centre: '+(barBox.x+barBox.width/2));
   assert(barBox.y+barBox.height<=900&&barBox.y>900*0.8,'the bar must sit at the bottom of the viewport: '+barBox.y+' '+barBox.height);
   // A themed bar, never a raw OS progress element.
   assert.equal(await launcherPage.locator('#launcher-bar progress').count(),0,'the bar must be themed, not a raw progress element');

   // 3. Paused: resume replaces pause, and the tab keeps showing the percentage.
   await pushState({phase:'paused',paused:true,progress:progressFor({percent:57})});
   heroAction({name:'paused',...await hero(),expect:'signin'});
   assert.equal(await launcherPage.locator('[data-bar-pause]').isVisible(),false,'pause is withdrawn while paused');
   assert.equal(await launcherPage.locator('[data-bar-resume]').isVisible(),true,'resume is offered while a paused transfer can continue');
   // The transfer moves on to work that cannot be paused or resumed, so neither is offered.
   await pushState({phase:'verifying',paused:false});
   assert.equal(await launcherPage.locator('[data-bar-resume]').isVisible(),false,'resume is withdrawn once the transfer can no longer continue');
   assert.equal(await launcherPage.locator('[data-bar-pause]').isVisible(),false,'pause is only offered while a transfer can actually be paused');

   // 4. Indeterminate progress: activity without an invented percentage, and absent fields
   //    stay absent rather than being shown as zero.
   await pushState({phase:'verifying',progress:{label:'Verifying the download',percent:null,bytesDone:null,bytesTotal:null,bytesPerSecond:null,etaSeconds:null}});
   heroAction({name:'verifying',...await hero(),expect:'signin'});
   assert.equal(await launcherPage.locator('.launcher-bar-track').getAttribute('aria-valuenow'),null,'an unknown percentage must not be published as a number');
   assert(!(await launcherPage.locator('.launcher-bar-label').textContent()).includes('%'),'no percentage may be invented while it is unknown');
   assert.equal(await launcherPage.locator('.launcher-bar-meta').isVisible(),false,'missing byte and speed fields must be absent, not zero');
   assert.equal(await barVisibleNow(),true,'the bar stays visible while the install is under way');
   await pushState({phase:'installing',progress:progressFor({label:'Installing the client',percent:73})});
   heroAction({name:'installing',...await hero(),expect:'signin'});
   assert.equal(await launcherPage.locator('.launcher-bar-track').getAttribute('aria-valuenow'),'73');
   // With nothing transferring, the bar shows the action and no progress at all rather
   // than an idle bar parked at zero.
   await pushState({phase:'ready',progress:null,canPlay:false,actions:['signin'],profile:null});
   assert.equal(await launcherPage.locator('.launcher-bar-track').isVisible(),false,'an idle bar must not show a zeroed progress track');
   assert.equal(await launcherPage.locator('.launcher-bar-meta').isVisible(),false,'an idle bar must not show empty transfer figures');
   assert.equal(await barVisibleNow(),false,'idle Home uses its single hero action');
   await pushState({canPlay:false,actions:['signin'],progress:{label:'Installing the client',percent:73},phase:'installing'});
   assert.equal(await launcherPage.locator('.launcher-bar-track').getAttribute('aria-valuenow'),'73');

   // 5. Ready without an account: the install finished alone, so Play must not appear.
   await pushState({phase:'ready',progress:null,actions:['signin'],install:INSTALLED});
   heroAction({name:'ready-without-account',...await hero(),expect:'signin'});
   assert.equal(await barVisibleNow(),false,'ready Home does not repeat sign-in in a dock');
   // 6. Ready with an account but an install update still pending: still no Play.
   await pushState({phase:'updating',actions:['download'],profile:{name:'Owen'},progress:progressFor({label:'Updating the client',percent:8}),canPlay:false});
   heroAction({name:'ready-with-account-update-pending',...await hero(),expect:'busy'});
   // 7. Fully ready: one large PLAY NOW, and only now.
   await pushState({phase:'ready',actions:[],progress:null,canPlay:true});
   heroAction({name:'fully-ready',...await hero(),expect:'play'});
   assert.equal(await launcherPage.locator('[data-desktop-play]').isDisabled(),false);
   // One Play entry point on the page while the launcher dialog is closed, and it is the hero.
   assert.equal(await launcherPage.locator('.hero-actions [data-desktop-play]').getAttribute('data-action'),'play');
   assert.equal(await launcherPage.locator('.hero-actions [data-desktop-play]').getAttribute('aria-disabled'),null);

   assert.equal(await barVisibleNow(),false,'ready Home has exactly one Play entry point');
   // The Microsoft/Minecraft session (doc/launcher-states.md, "The Minecraft session the account
   // service holds"). Six words, six different answers from one field, and the difference between
   // a genuinely unlinked account and a linked one whose session lives on the account service is
   // the whole point: only the second one ever reaches Play without a Microsoft prompt.
   const linkedAccount={id:'EC-7',username:'captain_owen',name:'Captain Owen',roles:['crew'],passwordRequired:false,microsoftLinked:true,minecraftName:'OwenTheCaptain'};
   const installedNow=INSTALLED;
   await pushState({phase:'ready',progress:null,actions:['link-microsoft'],canPlay:false,account:{...linkedAccount,microsoftLinked:false},companyReady:true,microsoftConnected:false,minecraftSession:{state:'unlinked',serverHeld:false,checkedAt:null}});
   heroAction({name:'an unlinked account',...await hero(),expect:'link-microsoft'});
   assert((await hero()).text.includes('Link Microsoft'),'an account with no Microsoft link says so: '+(await hero()).text);
   await pushState({actions:['connect-microsoft'],canPlay:false,account:linkedAccount,companyReady:true,microsoftConnected:false,minecraftSession:{state:'required',serverHeld:false,checkedAt:null}});
   heroAction({name:'a linked account with no session here',...await hero(),expect:'connect-microsoft'});
   assert.equal((await hero()).text,'Reconnect Microsoft Starts Minecraft as OwenTheCaptain','a signed-in linked account reconnects its Minecraft session and names the identity it starts: '+(await hero()).text);
   assert(!/Sign in with Microsoft/i.test((await hero()).text),'and is never asked to sign in with Microsoft: '+(await hero()).text);
   await pushState({actions:['connect-microsoft'],canPlay:false,minecraftSession:{state:'reauth',serverHeld:false,checkedAt:'2026-10-19T00:00:00Z'}});
   heroAction({name:'a stored session the service will not renew',...await hero(),expect:'connect-microsoft'});
   assert.equal((await hero()).text,'Reconnect Microsoft Starts Minecraft as OwenTheCaptain','a stored session that cannot be renewed asks for the same reconnect, in main\'s own sentence and without claiming to know why it is gone: '+(await hero()).text);
   await pushState({actions:[],canPlay:true,profile:{name:'OwenTheCaptain',id:'1234567890abcdef1234567890abcdef',skin:null},companyReady:true,microsoftConnected:false,minecraftSession:{state:'server',serverHeld:true,checkedAt:'2026-10-19T00:00:00Z'}});
   heroAction({name:'a session the account service mints',...await hero(),expect:'play'});
   assert(!/Microsoft|link/i.test((await hero()).text),'and never asks for Microsoft while it has one: '+(await hero()).text);
   // The account service could not answer: a retry, never a Microsoft prompt, and Play stays off.
   await pushState({actions:['connect-microsoft'],canPlay:false,companyReady:true,minecraftConnected:false,minecraftSession:{state:'busy',serverHeld:false,checkedAt:'2026-10-19T00:00:00Z'}});
   heroAction({name:'a service that cannot answer yet',...await hero(),expect:'retry-minecraft'});
   assert(!/Microsoft/i.test((await hero()).text),'a rate-limited service is never read as a dead session: '+(await hero()).text);
   const beforeRetry=(await callsNamed('refreshMinecraftSession')).length;
   await heroButton.click();
   await launcherPage.waitForFunction(count=>window.easterRenderer.calls.filter(call=>call.name==='refreshMinecraftSession').length>count,beforeRetry);
   // An answer nobody could read is the same offer and a different sentence, and never Microsoft.
   await pushState({actions:['connect-microsoft'],canPlay:false,companyReady:true,microsoftConnected:false,minecraftSession:{state:'unknown',serverHeld:false,checkedAt:'2026-10-23T07:48:00Z'}});
   heroAction({name:'an answer this launcher could not read',...await hero(),expect:'retry-minecraft'});
   assert.deepEqual(await hero(),{text:'Try again Your Minecraft session could not be checked',action:'retry-minecraft'},'an unreadable answer offers the same question again and says nothing about Microsoft: '+(await hero()).text);
   // The state a linked account has before anything has been asked is a wait, not a demand.
   await pushState({minecraftSession:{state:'unknown',serverHeld:false,checkedAt:null}});
   heroAction({name:'nothing asked yet',...await hero(),expect:'busy'});
   assert((await hero()).text.startsWith('Checking your Minecraft session'),'an unasked session is a wait, not a Microsoft prompt: '+(await hero()).text);
   // A dead Easter Company session is the ACCOUNT's news, and the state main publishes for it is
   // the signed-out one: no account, companyReady false, and no session word at all. The hero
   // asks for the account, and the chooser it opens is the account's own.
   await pushState({actions:['signin'],canPlay:false,account:null,companyReady:false,microsoftConnected:false,minecraftSession:null,phase:'ready'});
   heroAction({name:'a dead Easter Company session',...await hero(),expect:'signin'});
   assert.equal((await hero()).text,'Sign in Easter Company account required','a dead Easter Company session asks for the account, not for Microsoft: '+(await hero()).text);
   // Waiting for the service is its own state, not a failure and not a sign-in.
   await pushState({actions:['connect-microsoft'],account:linkedAccount,companyReady:true,microsoftConnected:false,minecraftSession:{state:'checking',serverHeld:false,checkedAt:null}});
   heroAction({name:'while the service is asked',...await hero(),expect:'busy'});
   assert((await hero()).text.includes('Checking your Minecraft session'),'the wait says what it is waiting for: '+(await hero()).text);
   // ---- Every action kind has its own glyph, and none of them is a pause --------------
   // Owen's 1.0.39 screen read "Sign in with Microsoft / Starts Minecraft as OwenEaster" under a
   // two-bar PAUSE icon. The icon was one inline ternary that named five kinds, and every other
   // kind — connect-microsoft, his — fell through to '<path d="M8 5v14M16 5v14"/>'. The table is
   // HERO_GLYPHS in site/desktop.js, and primaryAction is the only producer of a kind, so this
   // reads the kind literals out of primaryAction itself and drives a real state for each one. A
   // kind added to primaryAction fails the first assertion; a kind with no table entry draws
   // nothing and fails the second; two kinds sharing a glyph fail the third. No kind may render
   // the pause path, and the path itself has no home left in the file.
   const PAUSED_GLYPH='M8 5v14M16 5v14';
   const desktopSource=await fs.readFile(new URL('../site/desktop.js',import.meta.url),'utf8');
   const primaryBody=desktopSource.slice(desktopSource.indexOf('function primaryAction('),desktopSource.indexOf('const panel=document.createElement'));
   assert(primaryBody.length>1000,'primaryAction was found in site/desktop.js');
   const actionKinds=[...new Set([...primaryBody.matchAll(/kind:'([a-z-]+)'/g)].map(match=>match[1]))].sort();
   assert.equal(actionKinds.length,13,'primaryAction returns thirteen action kinds: '+actionKinds.join(', '));
   const linkedSession={state:'required',serverHeld:false,checkedAt:null};
   const stateForKind={
    'busy':{startupReady:false},
    play:{canPlay:true,profile:{name:'OwenTheCaptain'}},
    running:{phase:'running'},
    starting:{phase:'starting-game'},
    download:{install:launcherState({}).install,actions:['download'],phase:'uninstalled'},
    signin:{actions:['signin'],account:null,companyReady:false},
    buy:{account:linkedAccount,actions:['connect-microsoft'],minecraftSession:{state:'server',serverHeld:true,checkedAt:'2026-10-19T00:00:00Z'},minecraftAccess:'missing'},
    'setup-profile':{account:linkedAccount,actions:['connect-microsoft'],minecraftSession:{state:'server',serverHeld:true,checkedAt:'2026-10-19T00:00:00Z'},minecraftAccess:'profile-required'},
    'check-access':{account:linkedAccount,actions:['connect-microsoft'],minecraftSession:{state:'server',serverHeld:true,checkedAt:'2026-10-19T00:00:00Z'},minecraftAccess:'unknown'},
    'setup-password':{account:{...linkedAccount,passwordRequired:true},actions:['setup-password']},
    'link-microsoft':{account:{...linkedAccount,microsoftLinked:false},actions:['link-microsoft'],minecraftSession:{state:'unlinked',serverHeld:false,checkedAt:null}},
    'connect-microsoft':{account:linkedAccount,actions:['connect-microsoft'],minecraftSession:linkedSession},
    'retry-minecraft':{account:linkedAccount,actions:['connect-microsoft'],minecraftSession:{state:'busy',serverHeld:false,checkedAt:'2026-10-19T00:00:00Z'}}
   };
   assert.deepEqual(Object.keys(stateForKind).sort(),actionKinds,'every kind primaryAction can return has a state in this test, and this test invents none it cannot return');
   const glyphFor=async(kind,patch)=>{
    await pushState(Object.assign({phase:'ready',progress:null,paused:false,bar:{visible:false},actions:[],account:null,companyReady:true,canPlay:false,install:installedNow,profile:null,minecraftSession:null,minecraftAccess:'owned',startupReady:true,accessChecking:false,accountWorking:false},patch));
    await launcherPage.waitForFunction(kind=>document.querySelector('[data-desktop-play]')?.dataset.action===kind,kind);
    return (await launcherPage.locator('[data-desktop-play] svg').innerHTML()).trim();
   };
   const glyphs={};
   for(const kind of actionKinds)glyphs[kind]=await glyphFor(kind,stateForKind[kind]);
   for(const kind of actionKinds){
    assert.notEqual(glyphs[kind],'','the hero draws a glyph for '+kind+', so no kind falls back to no icon at all');
    assert(!glyphs[kind].includes(PAUSED_GLYPH),'no hero action kind wears the two-bar pause glyph ('+kind+'): '+glyphs[kind]);
   }
   const shared=actionKinds.filter(kind=>actionKinds.filter(other=>glyphs[other]===glyphs[kind]).length>1);
   assert.deepEqual(shared,[],'every kind has its own glyph: '+shared.join(', '));
   assert.equal(desktopSource.includes(PAUSED_GLYPH),false,'the pause-shaped path has no home left in site/desktop.js');
   console.log('GLYPH CENSUS PASS: '+actionKinds.length+' hero action kinds, one glyph each, no pause path — '+actionKinds.map(kind=>kind+' '+glyphs[kind].slice(0,28).replace(/\n/g,' ')+'…').join(' | '));
   await pushState({phase:'ready',actions:[],canPlay:true,profile:{name:'Owen'},install:installedNow,companyReady:true,microsoftConnected:true,minecraftSession:null});
   // Transfers retain the minimisable dock on every page.
   await pushState({phase:'downloading',progress:progressFor({percent:42}),actions:['signin'],canPlay:false});
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true);
   assert.equal(await barVisibleNow(),true,'minimising keeps transfer progress available');
   assert.equal((await launcherPage.locator('.launcher-bar-tab-text').textContent()).trim(),'42%','minimised during a transfer shows percentages');
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),false,'the tab re-opens the bar');

   // Keyboard access: the bar's own controls are reachable and operable, with names.
   assert.equal(await launcherPage.locator('[data-bar-toggle]').getAttribute('aria-label'),'Minimise download progress');
   assert.equal(await launcherPage.getByRole('button',{name:'Pause',exact:true}).count(),1);
   assert.equal(await launcherPage.getByRole('button',{name:'Resume',exact:true}).count(),0);
   await launcherPage.getByRole('button',{name:'Pause',exact:true}).focus();
   assert.equal(await launcherPage.evaluate(()=>document.activeElement.dataset.barPause!==undefined),true,'pause takes keyboard focus');
   await launcherPage.keyboard.press('Enter');
   assert.equal((await callsNamed('pause')).length,1,'Enter on the focused pause control must reach main');
   await launcherPage.locator('[data-bar-toggle]').focus();
   await launcherPage.keyboard.press('Enter');
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true,'the tab toggles with the keyboard');
   await launcherPage.keyboard.press('Enter');
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),false,'the same key re-opens it');

   // The first-run flow: one download action on the screen, and it is the hero's own.
   // The details under it say where the client installs and what the machine will do about
   // graphics; they carry no second button, because that would be the same action twice.
   await pushState({phase:'uninstalled',progress:null,actions:['download'],install:launcherState({}).install,profile:null,canPlay:false,bar:{visible:false}});
   const installDetails=launcherPage.locator('#desktop-install-details');
   await installDetails.waitFor({state:'visible'});
   const heroActionButton=launcherPage.locator('.hero-actions [data-desktop-play]');
   assert.equal(await heroActionButton.getAttribute('data-action'),'download','the hero action is the download at first run');
   assert.equal(await launcherPage.getByRole('button',{name:/^(download the game|start download|install the game)\b/i}).count(),1,'the first run must offer exactly one download action');
   assert.equal(await launcherPage.getByRole('button',{name:/^start download$/i}).count(),0,'no second download button exists anywhere on Home');
   await launcherPage.evaluate(()=>{window.easterRenderer.nextLocation='/mnt/games/easter-company/minecraft';});
   assert.equal(await launcherPage.locator('#desktop-launcher').isVisible(),false,'the download details are not the settings dialog');
   assert.equal(await installDetails.evaluate(el=>el.closest('dialog')===null),true,'the details are never inside the settings dialog');
   assert.equal(await installDetails.evaluate(el=>el.parentElement.classList.contains('hero-copy')),true,'the details belong to the hero');
   assert.equal(await installDetails.evaluate(el=>el.previousElementSibling.classList.contains('hero-graphics')),true,'the details follow the hero action');
   assert.equal(await installDetails.getByRole('button').count(),1,'the folder picker is the only control in the details');
   assert.equal(await installDetails.locator('[data-choose-location]').isVisible(),true,'choosing the folder is a real button');
   assert.equal(await installDetails.locator('.desktop-folder-button').evaluate(el=>el.tagName),'BUTTON');
   const folderDefault=await installDetails.locator('.desktop-install-default').textContent();
   assert.equal(folderDefault,'','the default path is not repeated beneath itself');
   assert((await installDetails.locator('.desktop-install-current').textContent()).includes('/home/player/.easter-company/minecraft'),'the details name the folder that will be used');
   await installDetails.locator('[data-choose-location]').click();
   assert((await installDetails.locator('.desktop-install-current').textContent()).includes('/mnt/games/easter-company/minecraft'),'the folder picker replaces the default');
   assert((await installDetails.locator('.desktop-install-default').textContent()).includes('/home/player/.easter-company/minecraft'),'the default stays visible as supporting text after a choice');
   // The details state what the automatic graphics choice will be. They offer no second
   // copy of the control: the toggle under the hero action is the only one.
   const graphicsNote=await installDetails.locator('.desktop-install-graphics').textContent();
   assert(graphicsNote.includes('Enhanced graphics included'),'the note states the automatic graphics choice: '+graphicsNote);
   assert(!graphicsNote.includes('8192'),'setup defers hardware diagnostics');
   assert.equal(await installDetails.locator('input[type=checkbox]').count(),0,'the details offer no second graphics control');
   await heroActionButton.click();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.some(call=>call.name==='startInstall'));
   const startCalls=await callsNamed('startInstall');
   assert.deepEqual(startCalls[0].payload,{location:'/mnt/games/easter-company/minecraft',includeGraphics:true},'the chosen folder and the machine\'s graphics answer are passed to main');
   // A transfer under way is not a reason to keep offering the download.
   await pushState({phase:'downloading',progress:progressFor(),canPlay:false});
   assert.equal(await installDetails.isVisible(),false,'the details close once the download starts');

   // A refused folder is shown beside the hero action, and the flow stays usable.
   await pushState({phase:'uninstalled',progress:null,actions:['download'],canPlay:false});
   await installDetails.waitFor({state:'visible'});
   await launcherPage.evaluate(()=>{window.easterRenderer.refuse='That folder is not writable.';});
   await heroActionButton.click();
   const installError=installDetails.locator('.desktop-install-error');
   await installError.waitFor({state:'visible'});
   assert.equal(await installError.textContent(),'That folder is not writable.','a refused folder must be shown next to the hero action');
   assert.equal(await installDetails.locator('[data-choose-location]').getAttribute('aria-invalid'),'true','the refusal points at the folder choice');
   // The refusal clears as soon as another folder is chosen.
   await launcherPage.evaluate(()=>{window.easterRenderer.nextLocation='/home/player/games/easter';});
   await installDetails.locator('[data-choose-location]').click();
   assert.equal(await installError.isVisible(),false,'the refusal clears once another folder is chosen');
   await heroActionButton.click();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.filter(call=>call.name==='startInstall').length>=3);
   const retried=(await callsNamed('startInstall')).at(-1);
   assert.deepEqual(retried.payload,{location:'/home/player/games/easter',includeGraphics:true},'the flow stays usable after a refusal');
   assert.equal(await launcherPage.locator('#desktop-launcher').isVisible(),false,'the download flow never needs the settings dialog');

   // Settings is the hero's secondary action, offered only at the Play Now stage.
   // The launcher keeps the crest and the eyebrow and does not carry the website's
   // headline (Owen's decision of 2026-10-17); the site assertion above still proves the
   // website keeps it.
   assert.equal(await launcherPage.locator('.hero-copy h1').count(),0,'the launcher carries no marketing headline');
   assert.equal(await launcherPage.getByRole('heading',{name:/The Ultimate/i}).count(),0,'and nothing repeats it as a heading');
   assert.equal(await launcherPage.locator('.hero-copy .eyebrow').count(),1,'the small Easter Co. SMP eyebrow stays');
   await pushState({phase:'ready',progress:null,actions:['signin'],install:INSTALLED,profile:{name:'Owen'},canPlay:false});
   const settingsButton=launcherPage.locator('.desktop-settings-button');
   await settingsButton.waitFor({state:'visible'});
   assert.equal((await settingsButton.textContent()).trim(),'Settings');
   assert.equal(await launcherPage.locator('.site-header .desktop-settings-button').count(),0,'the header carries no client settings button');
   await pushState({phase:'ready',actions:['download'],profile:null,canPlay:false,install:launcherState({}).install});
   assert.equal(await settingsButton.isVisible(),false,'Settings is not offered before the Play Now stage');
   // A launcher update check withholds Settings while it runs, and hands it back after.
   await pushState({phase:'ready',actions:[],profile:{name:'Owen'},canPlay:true,install:INSTALLED,launcherUpdate:{phase:'checking',version:null,url:null,message:null}});
   assert.equal(await settingsButton.isVisible(),false,'Settings is unreachable while the launcher checks for an update');
   await pushState({launcherUpdate:{phase:'current',version:'1.0.7',url:null,message:null}});
   assert.equal(await settingsButton.isVisible(),true,'the dialog comes back when the check settles');
   await pushState({phase:'ready',actions:[],profile:{name:'Owen'},canPlay:true,install:INSTALLED});

   // The Settings dialog is client settings only: no install, update or play action,
   // no transfer and no status hint.
   await settingsButton.click();
   const dialog=launcherPage.locator('#desktop-launcher');
   await dialog.waitFor({state:'visible'});
   assert.equal(await launcherPage.getByRole('dialog',{name:'Settings'}).isVisible(),true);
   const dialogText=await dialog.innerText();
   for(const forbidden of ['Start download','Include enhanced graphics + shaders'])
    assert(!dialogText.includes(forbidden),'the settings dialog must not carry "'+forbidden+'"');
   assert(!dialogText.includes('Install the Easter Company client'),'the download details never live in the settings dialog');
   assert.equal(await dialog.locator('.desktop-install-details').count(),0,'the settings dialog holds no install section');
   assert.equal(await dialog.locator('[data-choose-location]').count(),0,'choosing the install folder is not a settings action');
   assert.equal(await dialog.getByRole('button',{name:/play/i}).count(),0,'the dialog offers no play action');
   assert.equal(await dialog.locator('.desktop-play,.desktop-progress,.launcher-bar-track').count(),0,'the dialog carries no play button, no progress bar and no transfer');
   assert.equal(await dialog.getByRole('button',{name:/download/i}).count(),0,'no download action lives in the dialog');
   assert.equal(await installDetails.isVisible(),false,'opening Settings does not open the download details');

   // No server address anywhere. The launcher targets one fixed production server, so the
   // dialog carries no address row, no choice and no "custom" escape hatch, and the state
   // main broadcasts carries no list to build one from.
   assert.equal(await dialog.locator('select[name=serverSelect],input[name=server]').count(),0,'the Settings dialog offers no server address at all');
   assert(!/server/i.test(await dialog.innerText()),'nothing in the dialog so much as mentions a server: '+await dialog.innerText());
   assert.equal(await launcherPage.evaluate(()=>'servers' in window.easterRenderer.state),false,'the state carries no server list to build a choice from');
   // The save carries client settings only: a player has no address to send, so none travels.
   assert.equal(await dialog.getByRole('button',{name:'Save settings',exact:true}).count(),1,'the dialog still saves the settings it does own');
   // An older main process can still broadcast a list and a stored address. The renderer
   // ignores both rather than resurrecting the control, so a field left behind by a stale
   // piece of state can never put an editable address back in front of a player.
   await pushState({servers:[{id:'legacy',label:'Easter Co. SMP',address:'100.100.1.0:25565',note:'Default server.',pending:false}],settings:{memoryMB:4096,server:'100.100.1.0:25565',javaPath:''}});
   assert.equal(await dialog.locator('select[name=serverSelect],input[name=server]').count(),0,'a stale server list paints no control either');
   await pushState({settings:{memoryMB:4096,javaPath:''}});

   // Memory is an explained advanced setting, not a bare row.
   const advanced=dialog.locator('.desktop-advanced');
   assert.equal(await advanced.evaluate(el=>el.open),false,'advanced settings start folded away');
   await advanced.locator('summary').click();
   assert((await advanced.innerText()).includes('Memory allocated to the game'),'the memory control names what it sets');
   assert((await advanced.locator('.desktop-advanced-note').textContent()).length>80,'the advanced area explains what moving the memory value changes');
   assert((await advanced.locator('#memory-value').textContent()).includes('GB'),'the memory value is shown in GB');
   await advanced.locator('input[name=memoryMB]').fill('6144');
   assert((await advanced.locator('#memory-value').textContent())===('6.0 GB'),'the readout follows the control');
   await dialog.getByRole('button',{name:'Save settings',exact:true}).click();
   await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
   assert.equal((await callsNamed('saveSettings')).at(-1).payload.memoryMB,6144,'the memory choice reaches main');
   assert.equal('server' in (await callsNamed('saveSettings')).at(-1).payload,false,'and no server address rides along with it');

   // Company identity is primary; Microsoft is a linked provider underneath it.
   assert.equal(await dialog.locator('.desktop-account,.desktop-company').count(),0,'account management has one home in the profile menu');
   await launcherPage.keyboard.press('Escape');
   await pushState({account:{id:'EC-7',username:'captain_owen',name:'Captain Owen',roles:['crew'],passwordRequired:false,microsoftLinked:true},companyReady:true,microsoftConnected:true});
   await launcherPage.locator('.desktop-account-nav').click();
   const profileMenu=launcherPage.locator('.desktop-profile-menu');
   // Owen's report of 2026-10-19: the header showed the username where the display name
   // belongs. The name he is called leads in both places, and the username is kept as the
   // sign-in identifier rather than as the label.
   assert.equal((await launcherPage.locator('.desktop-account-nav').innerText()).trim(),'Captain Owen','the header shows the display name, not the username');
   const headed=await profileMenu.locator('.desktop-account').textContent();
   assert(headed.startsWith('Captain Owen'),'the display name leads the account menu: '+headed);
   assert(headed.includes('captain_owen'),'and the username is kept as the sign-in line: '+headed);
   assert(!headed.startsWith('captain_owen'),'but never in the leading position: '+headed);
   assert(!headed.includes('EC-'),'and no Company ID is shown to the player');
   assert((await profileMenu.locator('.desktop-company').textContent()).includes('Microsoft / Xbox linked'),'Microsoft is shown as a linked provider');
   assert.equal(await profileMenu.getByRole('button',{name:'Sign out of Easter Company',exact:true}).count(),0,'one primary Logout action');
   // Owen, 2026-10-20: "when I click the profile button in the nav bar an element is toggled
   // within the Easter Co. SMP hero '{spinner} Contacting the account service' ... shouldn't be
   // in the hero, should be apart of the drop down". The read that opening this menu starts
   // reports inside the menu, under the line it will fill in, and the hero stays silent about
   // work it did not start. A hero-owned wait still paints the hero and never the menu.
   await pushState({activity:{stage:'account-working',message:'Contacting the account service…',startedAt:Date.now(),scope:'surface'}});
   const menuWait=profileMenu.locator('.desktop-profile-wait');
   await menuWait.waitFor({state:'visible'});
   assert.match(await menuWait.innerText(),/Contacting the account service/,'the wait is inside the menu that started it');
   assert.equal(await launcherPage.locator('.desktop-activity').isVisible(),false,'and the hero says nothing about work it did not start');
   await pushState({activity:{stage:'company-signing-in',message:'Connecting your Easter Company account…',startedAt:Date.now(),scope:'hero'}});
   await launcherPage.locator('.desktop-activity').waitFor({state:'visible'});
   assert.equal(await menuWait.isVisible(),false,'a hero-owned wait never paints the menu');
   await pushState({activity:null});
   await menuWait.waitFor({state:'hidden'});
   // The verified emails: the profile names the address that signs the account in, the
   // section lists what the account service reports, and the choice reaches main as the
   // chosen address and nothing else. No address is ever part of the state that is pushed.
   const emailLine=profileMenu.locator('.desktop-profile-heading.desktop-email');
   // Owen, 2026-10-22, for streamer protection: the profile dropdown must never show the
   // address. With a login email set the line is not drawn at all.
   await launcherPage.waitForFunction(()=>document.querySelector('.desktop-profile-menu .desktop-profile-heading.desktop-email')?.hidden===true||document.querySelector('.desktop-profile-menu .desktop-profile-heading.desktop-email')===null);
   assert.equal(await emailLine.isVisible(),false,'the profile menu draws no Login email line');
   assert(!(await profileMenu.innerText()).includes('@example.test'),'and no address anywhere in the menu: '+(await profileMenu.innerText()).replace(/\n/g,' | '));
   assert(!JSON.stringify(await launcherPage.evaluate(()=>window.easterRenderer.state)).includes('@example.test'),'the launcher state carries no address');
   await profileMenu.getByRole('button',{name:'Verified emails',exact:true}).click();
   const emailsDialog=launcherPage.locator('#desktop-company-emails');
   await emailsDialog.locator('input[name=email]').first().waitFor();
   assert.equal(await emailsDialog.locator('input[name=email]').count(),2,'both verified addresses are listed');
   assert.equal(await emailsDialog.locator('input[name=email]').first().isChecked(),true,'the login address is the marked one');
   assert.deepEqual(await emailsDialog.locator('.company-email-meta').allInnerTexts(),['Microsoft · signs you in','Microsoft · recorded, not a login key'],'only the selected address is a login key');
   for(const [width,height] of [[1440,900],[800,600],[390,568]]){
    await launcherPage.setViewportSize({width,height});
    assert.equal(await emailsDialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the verified emails section has no horizontal overflow at '+width+'px');
    const box=await emailsDialog.boundingBox();
    assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1,'the verified emails section fits '+width+'px');
   }
   await launcherPage.setViewportSize({width:1440,height:900});
   await emailsDialog.locator('input[name=email]').nth(1).check();
   await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).click();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.some(call=>call.name==='selectLoginEmail'));
   assert.equal((await callsNamed('selectLoginEmail')).at(-1).payload,'crew@example.test','the chosen address is what reaches main');
   await emailsDialog.locator('.company-status').filter({hasText:'Your login email is saved.'}).waitFor();
   assert.equal(await emailsDialog.locator('input[name=email]').nth(1).isChecked(),true,'the saved choice is the marked one');
   assert.equal(await emailLine.isVisible(),false,'the profile menu still draws no address after the choice changes');
   assert(!(await profileMenu.innerText()).includes('crew@example.test'),'and the newly saved address is not printed either');
   await emailsDialog.getByRole('button',{name:'Clear login email',exact:true}).click();
   await emailsDialog.locator('.company-status').filter({hasText:'cleared'}).waitFor();
   assert.equal((await callsNamed('selectLoginEmail')).at(-1).payload,null,'clearing sends an explicit null');
   assert.equal(await emailsDialog.locator('.company-emails-unset').isVisible(),true,'with no selection the section says which sign-in works');
   assert.equal((await emailLine.textContent()).trim(),'No login email is selected. Sign in with a linked provider or with your username.','and the profile line says the same thing');
   await emailsDialog.locator('input[name=email]').nth(1).check();
   await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).click();
   await emailsDialog.locator('.company-status').filter({hasText:'Your login email is saved.'}).waitFor();
   await launcherPage.keyboard.press('Escape');
   await emailsDialog.waitFor({state:'hidden'});
   await launcherPage.keyboard.press('Escape');

   // The themed graphics toggle sits below the hero's primary action, at the Play Now
   // stage, and drives the new setGraphics bridge method.
   const graphicsToggle=launcherPage.locator('.hero-graphics [data-graphics-toggle]');
   const graphicsLabel=launcherPage.locator('.hero-graphics .desktop-graphics-label');
   await launcherPage.locator('.hero-graphics').waitFor({state:'visible'});
   assert.equal((await graphicsLabel.textContent()).trim(),'Enable Enhanced Graphics & Shaders');
   assert.equal(await graphicsToggle.isChecked(),false,'the toggle reflects graphics.enabled');
   const heroBox=await heroButton.boundingBox(),graphicsBox=await launcherPage.locator('.hero-graphics').boundingBox();
   assert(graphicsBox.y>=heroBox.y+heroBox.height-2,'the toggle renders below the hero\'s primary action: '+graphicsBox.y+' vs '+(heroBox.y+heroBox.height));
   assert((await launcherPage.locator('.hero-graphics .desktop-graphics-note').textContent()).includes('Discrete GPU with 8192 MB of video memory.'),'the toggle shows the graphics reason as supporting copy');
   await graphicsToggle.check();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.some(call=>call.name==='setGraphics'));
   const graphicsCalls=await callsNamed('setGraphics');
   assert.deepEqual(graphicsCalls.at(-1).payload,true,'flipping the toggle on reaches main as setGraphics(true)');
   assert.equal(await graphicsToggle.isChecked(),true,'the toggle follows the state main reports back');
   assert((await launcherPage.locator('.hero-graphics').evaluate(el=>el.classList.contains('is-on'))),'the switch shows its on state');
   // The same component with graphics.enabled already true, as a relaunch reports it.
   await pushState({graphics:{enabled:true,recommended:true,tunable:true,reason:'Discrete GPU with 8192 MB of video memory.',tuned:{renderDistance:12,shadowDistance:8,shaders:true}}});
   assert.equal(await graphicsToggle.isChecked(),true,'a persisted choice renders as on');
   assert((await launcherPage.locator('.hero-graphics .desktop-graphics-note').textContent()).includes('Render distance 12'),'the toggle reports what was written into the client');
   await graphicsToggle.uncheck();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.filter(call=>call.name==='setGraphics').length>=2);
   assert.deepEqual((await callsNamed('setGraphics')).at(-1).payload,false,'flipping it off reaches main as setGraphics(false)');
   // A refused graphics change has one surface, beside the toggle that asked for it, exactly as
   // a refused install location is shown beside the download action. The stub answers the way
   // desktop/main.cjs does — it settles the sentence in the state it broadcasts and rejects the
   // call as well — so the page notice must give up its copy rather than painting it twice.
   await launcherPage.evaluate(()=>{window.easterRenderer.graphicsError='The enhanced graphics files could not be downloaded. Try again.';});
   await graphicsToggle.click();
   await launcherPage.locator('.desktop-graphics-error').filter({hasText:'could not be downloaded'}).waitFor();
   await launcherPage.waitForFunction(()=>window.easterRenderer.state.error==='The enhanced graphics files could not be downloaded. Try again.');
   assert.deepEqual(await visibleErrors(),[],'a refused graphics change is not a second surface on the page notice');
   assert.equal(await launcherPage.locator('.desktop-graphics-error').isVisible(),true,'it is stated beside the toggle that asked for it');
   assert.equal(await graphicsToggle.isChecked(),false,'and the toggle goes back to what is saved');
   await launcherPage.screenshot({path:'/tmp/easter-launcher-graphics-failure.png'});
   await launcherPage.evaluate(()=>{window.easterRenderer.graphicsError=null;window.easterRenderer.state.error=null;});
   await pushState({error:null});
   await launcherPage.screenshot({path:'/tmp/easter-desktop-playnow-graphics.png',fullPage:true});
   // Not at the Play Now stage the toggle is withdrawn entirely.
   await pushState({graphics:{enabled:false,recommended:true,tunable:true},canPlay:false,install:launcherState({}).install,phase:'uninstalled',actions:['download'],profile:null});
   assert.equal(await launcherPage.locator('.hero-graphics').isVisible(),false,'the toggle is withdrawn before the client is installed');
   assert.equal(await launcherPage.locator('.hero-graphics').evaluate(el=>el.hidden),true,'the toggle leaves the DOM visible area, not merely the fold');
   // A build that cannot set graphics offers no toggle rather than a dead control.
   await pushState({phase:'ready',actions:[],canPlay:true,install:INSTALLED,graphics:null});
   assert.equal(await launcherPage.locator('.hero-graphics').isVisible(),false,'no graphics contract, no toggle');
   await pushState({graphics:{enabled:false,recommended:true,tunable:true,reason:'Discrete GPU with 8192 MB of video memory.'}});

   // The vague second hint the review called out is gone from the launcher entirely.
   assert(!(await launcherPage.locator('body').innerText()).includes('Download the game to get started'),'the launcher prints no second, vaguer hint');

   // ---- One failure, one visible home --------------------------------------
   // Owen's report: one failed sign-in was painted as the floating page notice AND inside the
   // Settings dialog, and the sentence came back whenever either dialog was opened or closed.
   // The state channel announces a failure and the rejected call announces it again; both are
   // driven here, in that order, exactly as main and the bridge do.
   const FAILURE='Sign-in could not finish. Please try again.';
   // The identity conflict, in the account service's own sentence (desktop/accounts.cjs
   // MESSAGES.identity_conflict) plus the two lines the renderer adds. Three lines, in order:
   // the sentence, what did not change, and the action — which starts by closing the dialog it
   // is spoken from, because the profile control it names is inert behind a modal.
   const CONFLICT_SENTENCE='That provider belongs to a different Easter Company account, or this account already has a different link. Sign out to use another account.';
   const CONFLICT_LINES=[CONFLICT_SENTENCE,'Nothing on your Easter Company account has changed.','Close this window first. Sign out from your profile before signing in to a different account.'];
   await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:{name:'Owen'},account:{id:'EC-7',username:'captain_owen',name:'Captain Owen',roles:['crew'],passwordRequired:false,microsoftLinked:true},companyReady:true,microsoftConnected:true,error:null});
   assert.deepEqual(await visibleErrors(),[],'a settled launcher has no failure on screen');
   // A failure with no dialog open has exactly one home: the page notice.
   await pushState({error:FAILURE});
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'a failure has one visible home, the page notice');
   assert.equal(await launcherPage.locator('.desktop-page-notice').evaluate(el=>el.firstChild.textContent),FAILURE,'the sentence is the one main supplied');
   assert.equal(await launcherPage.getByRole('button',{name:'Dismiss message'}).count(),1,'the page notice carries its dismiss control');
   // The same broadcast again, and opening and closing Settings, must not duplicate anything:
   // opening it takes the notice away (the modal makes the page inert) and closing it gives the
   // one sentence back, never a copy inside the settings dialog.
   await pushState({error:FAILURE});
   await settingsButton.click();
   await dialog.waitFor({state:'visible'});
   assert.deepEqual(await visibleErrors(),[],'Settings is never an error surface, and no page notice is painted behind it');
   assert.equal(await dialog.locator('.desktop-status').count(),0,'the settings dialog carries no status or error area at all');
   assert.equal(await dialog.evaluate(el=>el.innerText.includes('Sign-in could not finish')),false,'no failure text is copied into Settings');
   await launcherPage.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'closing Settings neither repeats nor moves the failure, and gives it back once');
   // A dismissed failure stays dismissed while the same broadcast repeats.
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   assert.deepEqual(await visibleErrors(),[],'the notice can be dismissed');
   await pushState({error:FAILURE});
   assert.deepEqual(await visibleErrors(),[],'an already-delivered failure is not delivered again by a repeated broadcast');
   // A different sentence is a different failure, and it is delivered once as well.
   await pushState({error:'The download was interrupted. Check your connection and try again.'});
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'a new sentence is delivered once');
   // A new action clears the previous failure and answers for itself.
   await pushState({canPlay:true,actions:[]});
   await launcherPage.locator('[data-desktop-play][data-action=play]').waitFor();
   await launcherPage.evaluate(()=>{window.easterRenderer.playError='Unable to start Minecraft. Try again.';});
   await launcherPage.locator('[data-desktop-play][data-action=play]').click();
   await launcherPage.locator('.desktop-page-notice').filter({hasText:'Unable to start Minecraft. Try again.'}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'a new action replaces the previous failure rather than stacking one');
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   await launcherPage.evaluate(()=>{window.easterRenderer.playError=null;});

   // ---- No page notice behind a modal dialog -------------------------------
   // A modal <dialog> paints in the document's top layer and makes the rest of the page
   // inert, so a page notice under one is a message the player can neither read nor dismiss:
   // that is what the review measured at 1440, 800 and 390 wide, where the notice was dimmed
   // by the backdrop, covered outright, and its Dismiss control could not be clicked at all.
   // The rule is that while any modal dialog is open no page notice is painted, and the last
   // one to close gives the same sentence back exactly once.
   const noticeIsLaidOut=()=>launcherPage.evaluate(()=>Boolean(document.querySelector('.desktop-page-notice')?.getClientRects().length));
   // A fresh sentence, because an already-delivered one is not deliverable again.
   const FAILURE_LATE='Unable to start Minecraft. Try again.';
   await launcherPage.evaluate(message=>{window.easterRenderer.playError=message;},FAILURE_LATE);
   await launcherPage.locator('[data-desktop-play][data-action=play]').click();
   await launcherPage.locator('.desktop-page-notice').filter({hasText:FAILURE_LATE}).waitFor();
   assert.equal(await noticeIsLaidOut(),true,'the failure is on the page notice with no dialog open');
   await settingsButton.click();
   await dialog.waitFor({state:'visible'});
   assert.equal(await dialog.evaluate(el=>el.open),true,'Settings is the open modal');
   assert.deepEqual(await visibleErrors(),[],'a modal dialog takes the page notice away entirely');
   assert.equal(await noticeIsLaidOut(),false,'the notice is not laid out behind the dialog at all');
   assert.equal(await launcherPage.getByRole('button',{name:'Dismiss message'}).count(),0,'and no unreachable dismiss control is left behind the modal');
   assert.equal(await dialog.evaluate(el=>el.innerText.includes('Unable to start Minecraft')),false,'no failure text is copied into Settings either');
   for(const [width,height] of [[1440,900],[800,600],[390,568]]){
    await launcherPage.setViewportSize({width,height});
    assert.deepEqual(await visibleErrors(),[],'still no visible failure surface at '+width+'px with Settings open');
    await launcherPage.screenshot({path:'/tmp/easter-launcher-settings-over-failure-'+width+'.png'});
   }
   await launcherPage.setViewportSize({width:1440,height:900});
   await launcherPage.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   // Closing the last modal gives the sentence back: the same one, once, with its dismiss
   // control, and reachable again now that the page is no longer inert.
   await launcherPage.locator('.desktop-page-notice').filter({hasText:FAILURE_LATE}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'closing the last modal gives the sentence back on the page notice');
   assert.equal(await launcherPage.getByRole('button',{name:'Dismiss message'}).count(),1,'with exactly one dismiss control');
   assert.equal(await launcherPage.getByRole('button',{name:'Dismiss message'}).evaluate(button=>{button.focus();return document.activeElement===button;}),true,'and it is keyboard reachable again');
   // A second kind of modal, one this file never creates: the mandatory update gate.
   await pushState({launcherUpdate:{phase:'checking'}});
   await launcherPage.locator('#desktop-update').waitFor({state:'visible'});
   assert.deepEqual(await visibleErrors(),[],'the update gate takes the notice away as well');
   assert.equal(await noticeIsLaidOut(),false,'and the notice is not laid out behind it');
   await pushState({launcherUpdate:{phase:'current'}});
   await launcherPage.locator('#desktop-update').waitFor({state:'hidden'});
   await launcherPage.locator('.desktop-page-notice').filter({hasText:FAILURE_LATE}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'the same sentence comes back once the gate closes');
   assert.equal(await launcherPage.locator('.desktop-page-notice').count(),1,'never a second copy of it');
   // The notice reads above the hero card at every width. Where the window has no empty band
   // for it the page reserves the height it needs rather than letting it sit on the crest and
   // the heading, which is exactly what it did at 390 wide.
   const noticeGeometry=()=>launcherPage.evaluate(()=>{
    const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom)};};
    return {notice:box(document.querySelector('.desktop-page-notice')),crest:box(document.querySelector('.crest-frame')),heading:box(document.querySelector('.desktop-home-heading')),viewport:innerWidth};
   });
   for(const [width,height] of [[1440,900],[800,600],[390,568]]){
    await launcherPage.setViewportSize({width,height});
    // The reserved room is layout, so it is re-measured on the frame after the window changes.
    // The wait is only for that pass; the assertions below are the claim.
    await launcherPage.waitForFunction(()=>{const notice=document.querySelector('.desktop-page-notice'),crest=document.querySelector('.crest-frame');
     return !notice||!crest||notice.getBoundingClientRect().bottom<=crest.getBoundingClientRect().top+1;},{timeout:4000}).catch(()=>{});
    const geometry=await noticeGeometry();
    assert(geometry.notice.left>=0&&geometry.notice.right<=geometry.viewport+1,'the failure notice fits '+width+'px: '+JSON.stringify(geometry));
    assert(geometry.notice.bottom<=geometry.crest.top+1,'the notice does not cover the crest at '+width+'px: '+JSON.stringify(geometry));
    assert(geometry.notice.bottom<=geometry.heading.top+1,'the notice does not cover the heading at '+width+'px: '+JSON.stringify(geometry));
    await launcherPage.screenshot({path:'/tmp/easter-launcher-one-failure-notice-'+width+'.png'});
   }
   await launcherPage.setViewportSize({width:1440,height:900});
   // It stays until it is dismissed, and a dismissed failure never comes back — not even when
   // a dialog opens and closes again over it.
   await pushState({error:FAILURE_LATE});
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'the returned sentence is still owned by the renderer');
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   assert.deepEqual(await visibleErrors(),[],'and it dismisses like any other failure');
   await settingsButton.click();
   await dialog.waitFor({state:'visible'});
   await launcherPage.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   assert.deepEqual(await visibleErrors(),[],'a dismissed failure is not resurrected by opening and closing a dialog');
   // A failure that ARRIVES while a modal dialog is open is held the same way: nothing is
   // painted under the modal, and the sentence the player then reads is that one, once.
   await settingsButton.click();
   await dialog.waitFor({state:'visible'});
   await pushState({error:'The account service could not be reached. Try again.'});
   assert.deepEqual(await visibleErrors(),[],'a failure arriving behind a modal dialog is held rather than painted under it');
   await launcherPage.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   await launcherPage.locator('.desktop-page-notice').filter({hasText:'The account service could not be reached. Try again.'}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'and closing the modal hands it to the page notice once');
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   assert.deepEqual(await visibleErrors(),[],'where it dismisses like any other');
   await launcherPage.evaluate(()=>{window.easterRenderer.playError=null;window.easterRenderer.state.error=null;});

   // A sign-in that is still running is never presented as failed. The device code is what the
   // player is waiting on, so a stale sentence from a broadcast must not be painted over it.
   await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:null,account:null,companyReady:false,microsoftConnected:false,error:null});
   await launcherPage.locator('[data-desktop-play][data-action=signin]').click();
   const companyChooser=launcherPage.locator('#desktop-company-signin');
   await companyChooser.waitFor({state:'visible'});
   await launcherPage.evaluate(()=>{window.easterRenderer.signInHold=true;});
   await companyChooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
   const signInDialog=launcherPage.locator('#desktop-signin');
   await signInDialog.waitFor({state:'visible'});
   await pushState({device:{code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000}});
   await launcherPage.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
   // A stale failure arrives while the flow runs: the code and the browser action stay readable
   // and nothing is painted over them.
   await pushState({error:FAILURE});
   assert.deepEqual(await visibleErrors(),[],'a live sign-in is not presented as failed');
   assert.equal(await launcherPage.locator('.desktop-code').filter({hasText:'TEST-CODE'}).isVisible(),true,'the device code stays readable');
   assert.equal(await launcherPage.getByRole('button',{name:'Open the Microsoft page',exact:true}).isVisible(),true,'the sign-in link stays readable');
   await launcherPage.screenshot({path:'/tmp/easter-launcher-signin-live.png'});
   // The flow then really fails, in main's own order: the settled state clears the device and
   // carries the sentence, and the account call rejects with it. One sentence, one place.
   await pushState({device:null,error:FAILURE});
   await launcherPage.evaluate(message=>window.easterRenderer.signInSettle.reject(Error(message)),FAILURE);
   await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'a failed sign-in ends with exactly one visible failure');
   assert.equal(await launcherPage.locator('.desktop-page-notice').evaluate(el=>el.firstChild.textContent),FAILURE,'the failed sign-in keeps the sentence main supplied');
   // While a sign-in dialog is open, the failure belongs to the dialog's own error area.
   await launcherPage.evaluate(message=>{window.easterRenderer.signInHold=true;window.easterRenderer.openMicrosoftError=message;},FAILURE);
   await launcherPage.locator('[data-desktop-play][data-action=signin]').click();
   await companyChooser.waitFor({state:'visible'});
   await companyChooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
   await signInDialog.waitFor({state:'visible'});
   await pushState({device:{code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000}});
   await launcherPage.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
   await launcherPage.getByRole('button',{name:'Open the Microsoft page',exact:true}).click();
   await launcherPage.locator('.desktop-auth-error').filter({hasText:FAILURE}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-auth-error'],'a failure raised while the sign-in dialog is open is shown only there');
   // Closed by the player, that sentence moves to the page notice once and is not carried into
   // any dialog afterwards.
   await launcherPage.keyboard.press('Escape');
   await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
   // The dialog's close event is a task of its own, so the move is waited for rather than assumed.
   await launcherPage.locator('.desktop-page-notice').filter({hasText:FAILURE}).waitFor();
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'closing the dialog hands the sentence to the page notice');
   // The sign-in is still held open by the stub, and Settings is withheld while one runs; settling
   // it is what hands Settings back, exactly as a finished sign-in does. A successful
   // completion also clears the earlier failure before any later dialog can reopen it.
   await launcherPage.evaluate(()=>{window.easterRenderer.signInSettle?.resolve(undefined);window.easterRenderer.signInSettle=null;window.easterRenderer.signInHold=false;});
   await launcherPage.waitForFunction(()=>!document.querySelector('.desktop-settings-button').disabled);
   await settingsButton.click();
   await dialog.waitFor({state:'visible'});
   assert.deepEqual(await visibleErrors(),[],'opening Settings brings back no failure, inside it or on the page behind it');
   await launcherPage.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   assert.deepEqual(await visibleErrors(),[],'a successful sign-in clears the earlier failure, including after Settings closes');
   await launcherPage.evaluate(()=>{window.easterRenderer.openMicrosoftError=null;});
   await pushState({device:null,error:null});
   if(await launcherPage.getByRole('button',{name:'Dismiss message'}).count())await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   assert.deepEqual(await visibleErrors(),[],'the launcher returns to a clean slate');

   // Microsoft's own answer about the account's email address. 'unavailable' is the one status
   // that says anything, it is a notice rather than a failure, and it prints no address.
   for(const [status,expected] of [['stored',false],['none',false],['unavailable',true]]){
    await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:null,account:null,companyReady:false,microsoftConnected:false,error:null});
    await launcherPage.locator('[data-desktop-play][data-action=signin]').click();
    await companyChooser.waitFor({state:'visible'});
    await launcherPage.evaluate(value=>{window.easterRenderer.signInAnswer={emailStatus:value};},status);
    await companyChooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
    const noticeNode=launcherPage.locator('.desktop-auth-notice');
    if(expected){
     await noticeNode.filter({hasText:'We could not read your Microsoft email address. You can sign in, and choose a login email later from your profile.'}).waitFor();
     assert.equal(await signInDialog.isVisible(),true,'the answer about the email address is said in the sign-in dialog');
     assert.equal(await launcherPage.locator('.desktop-auth-error').isVisible(),false,'it is a notice, not a failure');
     assert(!(await noticeNode.textContent()).includes('@'),'no address is printed');
     for(const [width,height] of [[1440,900],[800,600],[390,568]]){
      await launcherPage.setViewportSize({width,height});
      const box=await signInDialog.boundingBox();
      assert(box.x>=0&&box.x+box.width<=width+1,'the email notice fits '+width+'px');
      assert.equal(await signInDialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the email notice has no horizontal overflow at '+width+'px');
      await signInDialog.screenshot({path:'/tmp/easter-launcher-email-notice-'+width+'.png'});
     }
     await launcherPage.setViewportSize({width:1440,height:900});
    }else{
     await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
     assert.equal(await noticeNode.isVisible(),false,"'"+status+"' says nothing at all");
     assert.equal(await launcherPage.locator('.desktop-auth-error').isVisible(),false,"'"+status+"' raises no failure either");
    }
    // The notice belongs to the sign-in it answered and leaves with it.
    if(expected){
     await launcherPage.keyboard.press('Escape');
     await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
     assert.equal(await noticeNode.isVisible(),false,'closing the dialog ends the notice');
    }
    assert.deepEqual(await visibleErrors(),[],'neither the notice nor a completed sign-in leaves a failure behind');
    await launcherPage.evaluate(()=>{window.easterRenderer.signInAnswer=undefined;});
   }

   // The email notice is a notice, never a failure node. An unrelated failure arriving while it
   // is on screen must not blank it: the dialog used to end up an empty body with only the close
   // control, and a player waiting on one sentence was left with nothing to read.
   //
   // The sentence itself is never quoted here. It is the sign-in step's own sentence, it changes
   // with the account service, and the property under test is identity — the same text before and
   // after the failure paint — not any particular wording. The sentence is read back as it
   // arrives and compared with itself.
   const emailNotice=launcherPage.locator('.desktop-auth-notice');
   const unrelated='The launcher could not reach the account service.';
   await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:null,account:null,companyReady:false,microsoftConnected:false,error:null});
   await launcherPage.locator('[data-desktop-play][data-action=signin]').click();
   await companyChooser.waitFor({state:'visible'});
   await launcherPage.evaluate(()=>{window.easterRenderer.signInAnswer={emailStatus:'unavailable'};});
   await companyChooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
   await emailNotice.waitFor({state:'visible'});
   const emailSentence=(await emailNotice.textContent()).trim();
   assert(emailSentence.length>0,'the sign-in dialog holds the step\'s own sentence about the email address');
   await pushState({error:unrelated});
   await launcherPage.locator('.desktop-auth-error').filter({hasText:unrelated}).waitFor();
   assert.equal(await emailNotice.isVisible(),true,'an unrelated failure does not blank the email notice');
   assert.equal((await emailNotice.textContent()).trim(),emailSentence,'the step\'s own sentence is still the whole of it, unchanged');
   const emailDialogText=(await signInDialog.innerText()).replace(/\s+/g,' ');
   assert(emailDialogText.includes(emailSentence),'the dialog still carries the sentence the player is waiting on');
   assert(emailDialogText.includes(unrelated),'beside the failure that arrived while it was open, in its own error area');
   await signInDialog.screenshot({path:'/tmp/easter-launcher-email-notice-with-failure.png'});
   // The email notice belongs to the sign-in it answered: closing the dialog ends it, and the
   // failure that arrived meanwhile takes its one home on the page notice.
   await launcherPage.keyboard.press('Escape');
   await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
   await launcherPage.locator('.desktop-page-notice').filter({hasText:unrelated}).waitFor();
   assert.equal(await emailNotice.isVisible(),false,'closing the dialog ends the email notice');
   assert.deepEqual(await visibleErrors(),['desktop-page-notice'],'and the failure takes its one home on the page notice');
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   await launcherPage.evaluate(()=>{window.easterRenderer.signInAnswer=undefined;});
   await pushState({device:null,error:null});
   assert.deepEqual(await visibleErrors(),[],'the email-notice check leaves nothing behind');

   // The saved-session branch is a shortcut, not a dead end: any failure other than a conflict
   // falls through to the fresh interactive sign-in that shows the device code.
   for(const [code,refused] of [['network_error',false],['invalid_grant',false],['identity_conflict',true]]){
    await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:null,account:null,companyReady:false,microsoftConnected:false,microsoftAccount:{name:'Owen'},device:null,error:null});
    const before=(await callsNamed('signIn')).length;
    await launcherPage.evaluate(values=>{window.easterRenderer.continueRefusal={code:values.code,message:values.sentence};window.easterRenderer.signInHold=true;},{code,sentence:CONFLICT_SENTENCE});
    await launcherPage.locator('[data-desktop-play][data-action=signin]').click();
    await companyChooser.waitFor({state:'visible'});
    await companyChooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
    if(refused){
     await companyChooser.locator('.company-error').filter({hasText:CONFLICT_SENTENCE}).waitFor();
     assert.equal((await callsNamed('signIn')).length,before,'a conflict stops the flow so the player chooses the linked account');
     assert.deepEqual(await visibleErrors(),[],'the conflict is said in the dialog it belongs to, not on the page as well');
     // Three lines, not one 55-word paragraph: the sentence, then what did not change, then the
     // way out — which starts by closing this window, because the profile it names is behind the
     // modal it is spoken from. The undefined noun "the linked account" is gone.
     const conflictLines=await companyChooser.locator('.company-error p').allInnerTexts();
     assert.deepEqual(conflictLines,CONFLICT_LINES,'the conflict is three separate lines: '+JSON.stringify(conflictLines));
     assert(!/the linked account/i.test(conflictLines.join(' ')),'the sentence uses no undefined noun');
     assert.match(conflictLines[2],/^Close this window first\./,'the action says to close the window first');
     for(const [width,height] of [[1440,900],[800,600],[390,568]]){
      await launcherPage.setViewportSize({width,height});
      const box=await companyChooser.boundingBox();
      assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1,'the conflict chooser fits '+width+'px: '+JSON.stringify(box));
      assert.equal(await companyChooser.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the conflict chooser has no horizontal overflow at '+width+'px');
      await companyChooser.screenshot({path:'/tmp/easter-launcher-conflict-'+width+'.png'});
     }
     await launcherPage.setViewportSize({width:1440,height:900});
    }else{
     // Not a dead end: the saved session failing is followed by the interactive flow, and the
     // stale sentence the failure broadcast left behind is gone by the time it opens.
     await signInDialog.waitFor({state:'visible'});
     assert.equal((await callsNamed('signIn')).length,before+1,'a failed saved-session falls through to a fresh sign-in: '+code);
     assert.deepEqual(await visibleErrors(),[],'the fall-through starts with no leftover failure: '+code);
     await pushState({device:{code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000}});
     await launcherPage.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
     assert.deepEqual(await visibleErrors(),[],'the device code is offered with no failure painted over it: '+code);
     // Main clears the device when the flow ends, so the dialog closes with it.
     await pushState({device:null});
     await launcherPage.evaluate(()=>window.easterRenderer.signInSettle.resolve(undefined));
     await launcherPage.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
    }
    await launcherPage.evaluate(()=>{window.easterRenderer.signInHold=false;window.easterRenderer.signInSettle=null;window.easterRenderer.continueRefusal=null;});
    if(await companyChooser.isVisible())await launcherPage.keyboard.press('Escape');
    if(await signInDialog.isVisible())await launcherPage.keyboard.press('Escape');
    await pushState({device:null,error:null,microsoftAccount:null});
    if(await launcherPage.getByRole('button',{name:'Dismiss message'}).count())await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   }
   await pushState({phase:'ready',actions:['signin'],canPlay:false,install:INSTALLED,profile:{name:'Owen'},error:null});
   assert.deepEqual(await visibleErrors(),[],'the one-surface checks leave nothing behind');

   // The bar and the tab preference follow the player across pages and across a reload.
   await pushState({phase:'downloading',progress:progressFor(),actions:['signin'],bar:{visible:true},canPlay:false});
   // Start this section from the open bar whatever the bridge recipe left behind.
   if(await launcherPage.locator('[data-bar-toggle]').getAttribute('aria-pressed')==='true')await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),false);
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true);
   await launcherPage.getByRole('link',{name:'Map',exact:true}).click();
   // Wait for the chart document itself, not just the bridge: the preference has to survive
   // a real navigation, not merely a re-render.
   await launcherPage.waitForFunction(()=>!!document.getElementById('terrain')&&window.easterRenderer&&window.easterRenderer.emit);
   assert.equal(await launcherPage.locator('#launcher-bar').isVisible(),true,'the bar follows the player to the map');
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true,'the minimised preference follows the player to the map');
   assert((await launcherPage.locator('.launcher-bar-tab-text').textContent()).includes('42%'),'the minimised tab keeps showing the percentage on the map');
   const tabBox=await launcherPage.locator('.launcher-bar-tab').boundingBox();
   assert(tabBox.x>=0&&tabBox.x+tabBox.width<=1441,'the side tab must stay inside the viewport on the map');
   // Re-opened, the bar must sit clear of whatever the chart already docks at the bottom.
   await launcherPage.locator('[data-bar-toggle]').click();
   await launcherPage.setViewportSize({width:1440,height:901});
   await launcherPage.setViewportSize({width:1440,height:900});
   const barOnMap=await launcherPage.locator('#launcher-bar').boundingBox();
   const mapBottom=await launcherPage.locator('.map-bottom').boundingBox();
   assert(barOnMap.y+barOnMap.height<=mapBottom.y+1,'the bar must sit above the map footer: '+(barOnMap.y+barOnMap.height)+' vs '+mapBottom.y);
   await launcherPage.locator('[data-bar-toggle]').click();
   await launcherPage.screenshot({path:'/tmp/easter-launcher-bar-map.png'});
   await launcherPage.reload();
   await launcherPage.waitForFunction(()=>!!document.getElementById('terrain')&&window.easterRenderer&&window.easterRenderer.emit);
   assert.equal(await launcherPage.locator('#launcher-bar').isVisible(),true,'the bar survives a reload as the state says it should');
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true,'the minimised preference survives a reload');
   await launcherPage.goto(origin);
   await launcherPage.waitForFunction(()=>window.easterRenderer&&window.easterRenderer.emit);
   assert.equal(await launcherPage.locator('#launcher-bar').isVisible(),true,'the bar still shows after the trip back home');
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true,'the minimised preference survives the trip back home');
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('.launcher-bar-body').isVisible(),true,'re-opening the minimised tab restores the bar body');

   // Reduced motion: the honest indeterminate treatment still renders, and the arrival
   // behaviour the website owns is untouched.
   const launcherReduced=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
   try{
    await launcherReduced.addInitScript(()=>{try{localStorage.removeItem('easter-co-launcher-bar');}catch{}});
    await launcherReduced.addInitScript(desktopFixture,launcherState({phase:'downloading',progress:progressFor({label:'Downloading the Easter Company client',percent:null,bytesDone:null,bytesTotal:null,bytesPerSecond:null,etaSeconds:null}),actions:['signin'],bar:{visible:true}}));
    const reducedLauncher=await launcherReduced.newPage();
    await reducedLauncher.goto(origin);
    await reducedLauncher.locator('#launcher-bar').waitFor({state:'visible'});
    assert.equal(await reducedLauncher.locator('body').evaluate(el=>el.classList.contains('is-arriving')),false,'desktop mode must not start the arrival for a reduced-motion player');
    assert.equal(await reducedLauncher.locator('.launcher-bar-track').getAttribute('aria-valuenow'),null);
    assert.equal(await reducedLauncher.getByRole('button',{name:'Minimise download progress'}).count(),1,'the bar keeps an operable control under reduced motion');
   }finally{await launcherReduced.close().catch(()=>{});}

   // Narrow viewports: the bar and its tab stay inside the viewport, and the hero still works.
   for(const size of [{width:390,height:844},{width:320,height:568}]){
    await launcherPage.setViewportSize(size);
    await pushState({phase:'downloading',progress:progressFor(),actions:['signin'],bar:{visible:true},canPlay:false});
    const narrow=await launcherPage.locator('#launcher-bar').boundingBox();
    assert(narrow.x>=0&&narrow.x+narrow.width<=size.width+1&&narrow.y>=0&&narrow.y+narrow.height<=size.height+1,`the bar must fit ${size.width}x${size.height}: ${JSON.stringify(narrow)}`);
    assert(await launcherPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`the bar must not cause horizontal overflow at ${size.width}px`);
    assert.equal(await launcherPage.locator('[data-desktop-play]').isVisible(),true,`the hero action must stay usable at ${size.width}px`);
   }
   await launcherPage.setViewportSize({width:1440,height:900});

   // The game server's own row (doc/launcher-states.md, *The LED and the status line*): one
   // LED and one status line, both decided by the main process. Every state is rendered here
   // and asserted as TEXT, character for character, because the dot is aria-hidden and is
   // never allowed to be the only carrier of meaning. It is a different service from the
   // account: a server that is asleep, offline, starting or stopping is said in this row,
   // never as an account problem, and the hero offers no second Play while the press that is
   // already running a cold start has not launched.
   const gameLine=launcherPage.locator('.desktop-game-status');
   const gameText=async()=>(await gameLine.locator('.desktop-game-line').innerText()).trim();
   const asleep={state:'stopped',ready:false,endpoint:'smp.easter.company:25565',since:null,players:0,detail:null,waking:false,checkedAt:'2026-10-18T00:00:00Z',message:'Server Online, 0 active players',tone:'asleep'};
   const readyAccount={id:'EC-7',username:'testcaptain',name:'TestCaptain',roles:['crew'],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],primaryProvider:'microsoft',picture:null};
   const playNow={phase:'ready',progress:null,actions:[],canPlay:true,error:null,device:null,companyReady:true,microsoftConnected:true,minecraftAccess:'owned',profile:{name:'TestCaptain',id:'1234567890abcdef',skin:null},account:readyAccount,install:INSTALLED};
   // The sleeping host, with no reason from the service: his second sentence, in full.
   await pushState({...playNow,game:asleep});
   await gameLine.waitFor({state:'visible'});
   assert.equal(await gameText(),'Server Online, 0 active players','a sleeping host reads online with nobody on it, character for character');
   assert.equal(await gameLine.getAttribute('data-tone'),'asleep','and its dot is the dim amber of a normal sleep, not a fault');
   assert.equal(await gameLine.getAttribute('role'),'status','the row is the status live region');
   assert.equal(await gameLine.getAttribute('aria-live'),'polite');
   assert.equal(await gameLine.locator('.desktop-game-led').getAttribute('aria-hidden'),'true','the dot is hidden from assistive technology');
   assert.equal((await gameLine.innerText()).trim(),await gameText(),'the row reads as that sentence and nothing else, so the dot adds nothing a reader needs');
   heroAction({name:'server-asleep',...await hero(),expect:'play'});
   assert.equal(await launcherPage.locator('.desktop-access').isVisible(),false,'a stopped server is never an account or access problem');
   assert.deepEqual(await visibleErrors(),[],'and it is not raised as a failure either');
   // Offline for a reason the service itself stated: its own words in the brackets, and the
   // only state that turns the dot red. Nothing is invented when it states none.
   await pushState({game:{...asleep,detail:'Update in progress...',message:'Server Offline',tone:'offline'}});
   assert.equal(await gameText(),'Server Offline','an offline line carries no reason, no duration and no service sentence');
   assert(!/update in progress/i.test(await gameText()),'the service detail never reaches the player');
   assert.equal(await gameLine.getAttribute('data-tone'),'offline','and it is the one state that turns the dot red');
   // Online: visible, with the real count. This is the behaviour change — the row used to
   // hide itself here, which left a healthy server saying nothing at all.
   await pushState({game:{...asleep,state:'running',ready:true,players:2,detail:null,message:'Server Online, 2 active players',tone:'online'}});
   assert.equal(await gameLine.isVisible(),true,'an online server is the case the row exists for');
   assert.equal(await gameText(),'Server Online, 2 active players','the count is the service\'s own integer');
   assert.equal(await gameLine.getAttribute('data-tone'),'online');
   heroAction({name:'server-online',...await hero(),expect:'play'});
   // Singular for one, and NO bracket at all when the service sent no count, rather than a
   // false zero.
   await pushState({game:{...asleep,state:'running',ready:true,players:1,message:'Server Online, 1 active player',tone:'online'}});
   assert.equal(await gameText(),'Server Online, 1 active player');
   await pushState({game:{...asleep,state:'running',ready:true,players:null,message:'Server Online',tone:'online'}});
   assert.equal(await gameText(),'Server Online','a null count claims no number at all');
   // A cold start is normal behaviour, so it reads as starting — amber, never red, never
   // offline. Here nobody in this launcher is waking it, so the row is what says so.
   await pushState({game:{...asleep,state:'starting',players:null,message:'Server Online, 0 active players',tone:'starting'}});
   assert.equal(await gameText(),'Server Online, 0 active players','a host coming up is still online with nobody on it');
   assert.equal(await gameLine.getAttribute('data-tone'),'starting','a cold start is amber and pulsing, not a fault');
   await pushState({game:{...asleep,state:'stopping',players:2,message:'Server Online, 2 active players',tone:'stopping'}});
   assert.equal(await gameText(),'Server Online, 2 active players','a host shutting down still carries the players on it');
   assert.equal(await gameLine.getAttribute('data-tone'),'stopping');
   // The press that starts it: the same Play turns into the cold start, and there is no
   // second Play to press while the first one is waiting for the server.
   await pushState({phase:'starting-game',game:{...asleep,state:'starting',waking:true,message:'Starting your server… the first player in a session waits about a minute.',tone:'starting'}});
   const coldStart=await hero();
   assert.equal(coldStart.action,'starting','the hero says the server is starting');
   assert(/Starting your server/.test(coldStart.text),'with the cold start as its own action: '+coldStart.text);
   assert.equal(await launcherPage.locator('[data-desktop-play]').isDisabled(),true,'and no second Play during the cold start');
   assert.equal(await launcherPage.locator('.desktop-access').isVisible(),false,'a starting server is still not an account problem');
   // The service's own detail reads below the launcher's sentence rather than replacing it.
   // Since the quiet-feedback pass both are carried by the one wait line the cold start owns
   // (site/wait-feedback.mjs); the separate status row stands down while it is up, so the
   // sentence pair is read from the line that is actually on screen.
   await pushState({game:{...asleep,state:'starting',waking:true,detail:'Waking the world.',message:'Starting your server… the first player in a session waits about a minute.',tone:'starting'}});
   const coldStartLine=launcherPage.locator('.desktop-activity');
   await coldStartLine.filter({hasText:'Waking the world.'}).waitFor();
   const coldStartText=await coldStartLine.innerText();
   assert(coldStartText.includes('Starting your server'),'the launcher sentence is still the first thing read: '+coldStartText);
   assert(coldStartText.indexOf('Starting your server')<coldStartText.indexOf('Waking the world.'),'and the service\'s detail reads below it: '+coldStartText);
   assert.equal(await gameLine.isVisible(),false,'the cold start has one line, not two');
   // A wake that timed out is an ordinary failure on the one page notice, and Play is the retry.
   await pushState({phase:'ready',canPlay:true,game:{...asleep,waking:false},error:'Your server did not become joinable within three minutes. Press Play to try it again.'});
   await launcherPage.locator('.desktop-page-notice').filter({hasText:'did not become joinable'}).waitFor();
   heroAction({name:'server-timeout-retry',...await hero(),expect:'play'});
   assert.equal(await launcherPage.locator('[data-desktop-play]').isDisabled(),false,'a wake timeout leaves Play available as the retry');
   await launcherPage.getByRole('button',{name:'Dismiss message'}).click();
   assert.deepEqual(await visibleErrors(),[],'the retry leaves no failure behind');
   // An unreachable status is displayed as unknown and claims nothing: never online, never
   // offline, and never red. The launcher does not call a server down it could not look at.
   await pushState({error:null,game:{...asleep,state:'unknown',ready:false,players:null,message:'Server Offline',tone:'offline'}});
   await gameLine.waitFor({state:'visible'});
   assert.equal(await gameText(),'Server Offline','an unreadable status says Offline until it knows');
   assert(!/online/i.test(await gameText()),'and never claims the server is online');
   heroAction({name:'server-status-unknown',...await hero(),expect:'play'});
   // A server nobody has asked about yet is the same honest answer, in its own words.
   await pushState({game:{...asleep,state:'unknown',ready:false,message:'Server Offline',tone:'offline'}});
   assert.equal(await gameText(),'Server Offline','a server nobody has asked about yet reads the same, with no detail');
   // A main process that publishes no game field at all renders exactly as it did before,
   // which is what lets an older build read a newer view and the reverse.
   await pushState({game:null});
   assert.equal(await gameLine.isVisible(),false,'a state with no game field paints nothing');
   heroAction({name:'no-game-field',...await hero(),expect:'play'});
   // Before the Play Now stage there is nothing to join, so the row is absent even though the
   // main process is publishing a server state.
   await pushState({install:{...INSTALLED,installed:false},canPlay:false,phase:'ready',game:{...asleep,state:'running',ready:true,players:3,message:'Server Online, 3 active players',tone:'online'}});
   assert.equal(await gameLine.isVisible(),false,'the row is hidden before the Play Now stage');
   await pushState({install:INSTALLED,canPlay:true,game:asleep});

   // The launcher must not have broken the map or produced console errors in desktop mode.
   assert.deepEqual(launcherErrors,[],'desktop mode must not throw');
   assert.deepEqual(await launcherPage.evaluate(()=>window.easterRenderer.errors),[],'the fixture saw no page error on its last load');
   await launcherContext.close();
  }finally{await launcherContext.close().catch(()=>{});}
  console.log('LAUNCHER FLOW PASS: hero action, Play gate and sticky bar driven through a stubbed easterDesktop bridge across uninstalled, downloading, paused, verifying, installing, ready-without-account, ready-with-account and fully-ready states; one download action per screen with the folder choice beside it; a settings-only dialog offered only at the Play Now stage that carries no server address at all, not even from a stale list or a stored value, with an explained memory setting and no address in the save; the themed enhanced graphics toggle driving setGraphics, a refused graphics change shown once beside the toggle rather than on the page notice as well; the profile\'s verified emails listed and chosen through the owner-only actions with no address in the state; refusals shown; one failure on one visible surface with no page notice painted while any modal dialog is open (Settings and the mandatory update gate) and the same sentence handed back once when the last one closes, repeated at 1440, 800 and 390 wide with the notice reading above the hero card\'s crest and heading, Settings never an error sink, a repeated broadcast delivered once, a dismissed failure left dismissed, a live sign-in never painted as failed, Microsoft\'s email answer kept as a notice an unrelated failure cannot blank, the saved-session branch falling through to a fresh sign-in except on an identity conflict, and Microsoft\'s email-unavailable answer shown as a sign-in notice; the game server\'s own row rendered in every state as one LED plus one status line and asserted as text in three sentences and nothing else: \'Server Online, 2 active players\' VISIBLE with the real count and singular for one player, \'Server Online, 0 active players\' for a sleeping host, a host coming up and an empty one, no bracket anywhere and a null count claiming no number at all, \'Server Offline\' with no reason, duration or service sentence for a stopped host the service is working on and for a status that could not be read or was never asked about, the dot aria-hidden inside a role=status live region so the words carry the whole state, the cold start as its own hero action with no second Play and its sentence and detail on the one wait line, a wake timeout as one page-notice failure with Play as the retry, and the row absent before the Play Now stage and for a state with no game field; indeterminate progress honest; bar and tab follow Home and Map and survive a reload; keyboard operable');
 }
}finally{await browser.close();}
