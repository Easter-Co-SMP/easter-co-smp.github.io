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
 assert.deepEqual(errors,[]);
 console.log('DRAWINGS PASS: all seven drawing tools, eraser, undo/redo, durable IndexedDB, world anchoring after camera movement/reload, middle-camera-only, visibility persistence, responsive palette, compass placement');
}finally{await browser.close();}
