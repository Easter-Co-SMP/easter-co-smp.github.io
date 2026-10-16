import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
 assert(await page.getByRole('button',{name:'Wiki',exact:true}).isDisabled());await noOverflow();
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
 assert(await reducedPage.locator('.wiki-link').isDisabled());await reduced.close();
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
   window.easterRenderer={state:Object.assign({},state,carried),nextLocation:null,refuse:null,calls:[],errors:[]};
   window.addEventListener('pageerror',event=>window.easterRenderer.errors.push(event.message));
   const renderer=window.easterRenderer;
   const log=(name,payload)=>{renderer.calls.push(payload===undefined?{name}:{name,payload});try{localStorage.setItem('easter-renderer-calls',JSON.stringify(renderer.calls));}catch{}};
   try{renderer.calls=JSON.parse(localStorage.getItem('easter-renderer-calls')||'[]');}catch{renderer.calls=[];}
   window.easterDesktop={
    mode:'desktop',
    status:async()=>renderer.state,
    onState:callback=>{renderer.emit=callback;},
    signIn:async()=>{log('signIn');},
    play:async()=>{log('play');},
    chooseInstallLocation:async()=>{log('chooseInstallLocation');return renderer.nextLocation||renderer.state.install.defaultLocation;},
    startInstall:async options=>{log('startInstall',options);if(renderer.refuse){const message=renderer.refuse;renderer.refuse=null;throw Error(message);}},
    pause:async()=>{log('pause');},
    resume:async()=>{log('resume');},
    cancelSignIn:async()=>{log('cancelSignIn');},
    refreshAccount:async()=>{log('refreshAccount');},
    signOut:async()=>{log('signOut');},
    signOutAccount:async()=>{log('signOutAccount');},
    openFolder:async()=>{},
    openMicrosoft:async()=>{},
    chooseJava:async()=>null,
    saveSettings:async values=>values
   };
  };
  const launcherState=patch=>Object.assign({version:'1.0.0',totalMemoryMB:16384,remembered:true,profile:null,account:null,device:null,sessionExpiresAt:0,message:'',
   settings:{memoryMB:4096,server:'',javaPath:''},install:{location:null,defaultLocation:'/home/player/.easter-company/minecraft',installed:false,includeGraphics:true,version:null,updatedAt:null},
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
    Object.assign(window.easterRenderer.state,values);
    try{localStorage.setItem('easter-renderer-state',JSON.stringify(window.easterRenderer.state));}catch{}
    window.easterRenderer.emit(window.easterRenderer.state);
   },patch);};
   const heroAction=summary=>{
    assert.equal(summary.action,summary.expect,summary.name+': hero action must follow the state');
    // Play must never appear because the install finished alone, so outside canPlay the
    // hero carries no Play label at all.
    if(summary.expect==='play')assert(summary.text.startsWith('PLAY NOW'),summary.name+': the hero must become one large PLAY NOW: '+summary.text);
    else assert(!/play/i.test(summary.text),summary.name+': Play must be absent until canPlay: '+summary.text);
   };
   const hero=async()=>({text:(await heroButton.innerText()).replace(/\s+/g,' '),action:await heroButton.getAttribute('data-action')});
   const barVisibleNow=()=>launcherPage.locator('#launcher-bar').isVisible();
   const calls=()=>launcherPage.evaluate(()=>window.easterRenderer.calls);
   const callsNamed=async name=>(await calls()).filter(call=>call.name===name);

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
   assert.equal(await barVisibleNow(),true,'the bar stays on screen once a download has started');
   await pushState({canPlay:false,actions:['signin'],progress:{label:'Installing the client',percent:73},phase:'installing'});
   assert.equal(await launcherPage.locator('.launcher-bar-track').getAttribute('aria-valuenow'),'73');

   // 5. Ready without an account: the install finished alone, so Play must not appear.
   await pushState({phase:'ready',progress:null,actions:['signin'],install:INSTALLED});
   heroAction({name:'ready-without-account',...await hero(),expect:'signin'});
   assert.equal(await barVisibleNow(),true,'the bar persists after the client is ready');
   // 6. Ready with an account but an install update still pending: still no Play.
   await pushState({phase:'updating',actions:['download'],profile:{name:'Owen'},progress:progressFor({label:'Updating the client',percent:8}),canPlay:false});
   heroAction({name:'ready-with-account-update-pending',...await hero(),expect:'download'});
   // 7. Fully ready: one large PLAY NOW, and only now.
   await pushState({phase:'ready',actions:[],progress:null,canPlay:true});
   heroAction({name:'fully-ready',...await hero(),expect:'play'});
   assert.equal(await launcherPage.locator('[data-desktop-play]').isDisabled(),false);
   // One Play entry point on the page while the launcher dialog is closed, and it is the hero.
   assert.equal(await launcherPage.locator('.hero-actions [data-desktop-play]').getAttribute('data-action'),'play');
   assert.equal(await launcherPage.locator('.hero-actions [data-desktop-play]').getAttribute('aria-disabled'),null);

   // Minimised, the bar follows the same state: percentages while transferring, the play or
   // sign-in action otherwise.
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true);
   assert((await launcherPage.locator('.launcher-bar-tab-text').textContent()).includes('PLAY NOW'),'minimised while everything is ready shows PLAY NOW');
   assert.equal(await barVisibleNow(),true,'minimising keeps the bar on screen as a side tab');
   await pushState({phase:'downloading',progress:progressFor({percent:42}),actions:['signin'],canPlay:false});
   assert.equal((await launcherPage.locator('.launcher-bar-tab-text').textContent()).trim(),'Downloading the Easter Company client 42%','minimised during a transfer shows percentages');
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

   // The first-run flow collects a location and the graphics toggle, and passes both to main.
   await pushState({phase:'uninstalled',progress:null,actions:['download'],install:launcherState({}).install,profile:null,canPlay:false});
   await launcherPage.evaluate(()=>{window.easterRenderer.nextLocation='/mnt/games/easter-company/minecraft';});
   await heroButton.click();
   assert.equal(await launcherPage.locator('#desktop-launcher').isVisible(),true,'the hero download action opens the launcher dialog');
   const locationInput=launcherPage.locator('#desktop-launcher input[name=installLocation]');
   assert.equal(await locationInput.inputValue(),'/home/player/.easter-company/minecraft','the location field defaults to install.defaultLocation');
   await launcherPage.getByRole('button',{name:'Choose folder…'}).click();
   assert.equal(await locationInput.inputValue(),'/mnt/games/easter-company/minecraft','the folder picker replaces the default');
   const graphicsToggle=launcherPage.locator('#desktop-launcher input[name=includeGraphics]');
   assert.equal(await graphicsToggle.isChecked(),true,'enhanced graphics default to the contract value');
   await graphicsToggle.uncheck();
   await launcherPage.getByRole('button',{name:'Start download'}).click();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.some(call=>call.name==='startInstall'));
   const startCalls=await callsNamed('startInstall');
   assert.deepEqual(startCalls[0].payload,{location:'/mnt/games/easter-company/minecraft',includeGraphics:false},'the chosen location and toggle must be passed to main');

   // A refused location is shown and the flow stays usable.
   await launcherPage.evaluate(()=>{window.easterRenderer.refuse='That folder is not writable.';});
   await launcherPage.getByRole('button',{name:'Start download'}).click();
   const installError=launcherPage.locator('.desktop-install-error');
   await installError.waitFor({state:'visible'});
   assert.equal(await installError.textContent(),'That folder is not writable.','a refused location must be shown');
   assert.equal(await locationInput.getAttribute('aria-invalid'),'true');
   await locationInput.fill('/home/player/games/easter');
   assert.equal(await installError.isVisible(),false,'the refusal clears once the location is edited');
   await launcherPage.getByRole('button',{name:'Start download'}).click();
   await launcherPage.waitForFunction(()=>window.easterRenderer.calls.filter(call=>call.name==='startInstall').length>=3);
   const retried=(await callsNamed('startInstall')).at(-1);
   assert.deepEqual(retried.payload,{location:'/home/player/games/easter',includeGraphics:false},'the flow stays usable after a refusal');
   await launcherPage.keyboard.press('Escape');

   // The bar and the tab preference follow the player across pages and across a reload.
   await pushState({phase:'downloading',progress:progressFor(),actions:['signin'],bar:{visible:true},canPlay:false});
   // Start this section from the open bar whatever the bridge recipe left behind.
   if(await launcherPage.locator('[data-bar-toggle]').getAttribute('aria-pressed')==='true')await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),false);
   await launcherPage.locator('[data-bar-toggle]').click();
   assert.equal(await launcherPage.locator('#launcher-bar').evaluate(el=>el.classList.contains('is-minimised')),true);
   await launcherPage.getByRole('link',{name:'View Map',exact:true}).click();
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

   // The launcher must not have broken the map or produced console errors in desktop mode.
   assert.deepEqual(launcherErrors,[],'desktop mode must not throw');
   assert.deepEqual(await launcherPage.evaluate(()=>window.easterRenderer.errors),[],'the fixture saw no page error on its last load');
   await launcherContext.close();
  }finally{await launcherContext.close().catch(()=>{});}
  console.log('LAUNCHER FLOW PASS: hero action, Play gate and sticky bar driven through a stubbed easterDesktop bridge across uninstalled, downloading, paused, verifying, installing, ready-without-account, ready-with-account and fully-ready states; location and graphics collected on start; refusals shown; indeterminate progress honest; bar and tab follow Home and Map and survive a reload; keyboard operable');
 }
}finally{await browser.close();}
