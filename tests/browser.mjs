import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
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
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 const noOverflow=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.goto(origin);await page.locator('#mod-version').filter({hasText:'v2.'}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).count(),1);
 assert.equal(await page.locator('nav a[aria-current="page"]').textContent(),'Home');
 assert(await page.getByRole('button',{name:'Wiki',exact:true}).isDisabled());await noOverflow();
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 const skipPage=await context.newPage();await skipPage.goto(origin);
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
 await page.getByRole('button',{name:'Getting started'}).click();await page.locator('#guide-dialog').waitFor();
 assert.equal(await page.locator('#dependency-list a').count(),5);await page.keyboard.press('Escape');
 for(const trigger of [page.getByRole('button',{name:'Choose launcher platform',exact:true}),page.getByRole('navigation').getByRole('button',{name:'Download',exact:true})]){
  await trigger.click();await page.locator('#launcher-downloads').waitFor({state:'visible'});
  assert.equal(await page.locator('#launcher-downloads .platform-download').count(),5);
  for(const label of ['Windows 64bit Version','Ubuntu','Arch','AppImage','Source'])assert(await page.getByRole('link',{name:label,exact:false}).isVisible());
  await page.keyboard.press('Escape');assert.equal(await page.locator('#launcher-downloads').isVisible(),false);
 }
 const launcherDownloadPromise=page.waitForEvent('download');
 await page.locator('[data-download-primary]').click();
 const launcherDownload=await launcherDownloadPromise;assert.equal(await launcherDownload.failure(),null);assert(launcherDownload.suggestedFilename().endsWith('-placeholder.txt'));
 assert(await page.getByRole('dialog',{name:'Setup & Install',exact:true}).isVisible());
 await page.getByRole('button',{name:'Close setup instructions'}).click();
 for(const platform of ['windows','ubuntu','arch','appimage','source']){
  await page.getByRole('navigation').getByRole('button',{name:'Download',exact:true}).click();
  const manualDownloadPromise=page.waitForEvent('download');await page.locator('[data-platform="'+platform+'"]').click();
  const manualDownload=await manualDownloadPromise;assert.equal(await manualDownload.failure(),null);assert.equal(manualDownload.suggestedFilename(),'Easter-Company-'+platform+'-placeholder.txt');
  assert(await page.getByRole('dialog',{name:'Setup & Install',exact:true}).isVisible());
  if(platform==='windows')await page.screenshot({path:'/tmp/easter-launcher-setup-desktop.png'});
  await page.keyboard.press('Escape');
 }
 for(const [platform,expected] of [['Windows','windows'],['Linux','appimage'],['macOS',null]]){
  const detected=await browser.newContext({acceptDownloads:true});await detected.addInitScript(platform=>Object.defineProperty(navigator,'userAgentData',{value:{platform}}),platform);
  const detectedPage=await detected.newPage();await detectedPage.goto(origin);await detectedPage.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  if(expected){const pending=detectedPage.waitForEvent('download');await detectedPage.locator('[data-download-primary]').click();assert.equal((await pending).suggestedFilename(),'Easter-Company-'+expected+'-placeholder.txt');}
  else{await detectedPage.locator('[data-download-primary]').click();assert(await detectedPage.locator('#launcher-downloads').isVisible());}
  await detected.close();
 }
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Download our mod'}).click();
 const download=await downloadPromise;assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),'easter-navy.jar');
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
  await page.getByRole('button',{name:'Getting started'}).click();
  const dialog=await page.locator('#guide-dialog').boundingBox();assert(dialog.x>=0&&dialog.x+dialog.width<=size.width+1);
  await page.locator('#close-guide').click();
  if(size.width===390)await page.screenshot({path:'/tmp/easter-public-home-mobile.png',fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});await page.getByRole('link',{name:'View Map',exact:true}).click();
 const ready=()=>page.waitForFunction(()=>window.mapFrame.tiles>0&&document.getElementById('map-status').hidden);
 await ready();await noOverflow();
 assert.equal(await page.getByRole('toolbar',{name:'Map controls'}).locator('button').count(),5,'only viewing controls are public');
 assert.equal(await page.locator('nav a[aria-current="page"]').textContent(),'Map');
 assert.equal(await page.locator('.arrival-mist,.skip-arrival').count(),0,'the atlas never plays the homepage intro');
 assert((await page.locator('#snapshot-date').textContent()).includes('Charted'));
 await page.screenshot({path:'/tmp/easter-public-map-desktop.png'});
 await page.locator('#map-key summary').click();assert.equal(await page.locator('[data-layer]:checked').count(),7);
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
 assert(manifest.markers.every(r=>['ship','npc'].includes(r.kind)));
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
 failTile=false;await page.locator('#refresh').click();
 for(let i=0;i<100;i++){if((await sample()).join(',')==='255,0,255,255')break;await page.waitForTimeout(25);}
 assert.deepEqual(await sample(),[255,0,255,255]);
 // A deployment serving mismatched bytes must retain the prior verified tile.
 manifest.tiles.find(r=>r.x===tile.x&&r.z===tile.z).version=hashes[1];await page.locator('#refresh').click();
 await page.locator('#map-status').filter({hasText:'keeping saved terrain'}).waitFor();assert.deepEqual(await sample(),[255,0,255,255]);
 assert(requests.every(r=>r.method==='GET'));
 assert(!requests.some(r=>r.url.includes('/minecraft/')||r.url.includes('/api/')));
 assert.deepEqual(errors,[]);
 console.log('PUBLIC SITE PASS: responsive home, download, guide, read-only map, all layers, pan/zoom/middle/fullscreen, preferences, persistent cached rendering, incremental refresh, failure retention, checksum validation, no private API calls');
}finally{await browser.close();}
