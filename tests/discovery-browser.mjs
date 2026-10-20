const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin=process.env.EASTER_PUBLIC_ORIGIN || 'http://127.0.0.1:18100';
const output=process.env.EASTER_REVIEW_OUTPUT; 
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
for(const width of [1440,900,390]){
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
 await page.goto(origin,{waitUntil:'networkidle'});
 assert.equal(await page.locator('.launcher-discovery').count(),0);
 const b=await page.locator('.home-hero').boundingBox();assert.ok(Math.abs(b.x+b.width/2-width/2)<2);
 assert.ok(await page.locator('h1').isVisible());
 if(output)await page.screenshot({path:`${output}/website-center-${width}.png`});await page.close();
}
for(const [name,payload] of [['populated',{schema:1,posts:[{id:'p',title:'A dispatch from the Isles',excerpt:'Fixture post for layout review.',publishedAt:'2026-10-19T16:00:00Z',url:'https://example.com/post'}],featuredItem:{id:'flag',title:'The captain’s pennant',description:'Fixture item for layout review. A personal touch for your next voyage.',category:'Ship cosmetics'}}],['long',{schema:1,posts:[{id:'long',title:'A long dispatch title about the next voyage and the crews preparing to sail across the Isles',excerpt:'Long editorial copy. '.repeat(40),publishedAt:'2026-10-19T16:00:00Z',url:'https://example.com/long'}],featuredItem:{id:'long-item',title:'An unusually long catalogue title for the next Company expedition',description:'Long catalogue description. '.repeat(80),category:'Ship cosmetics'}}],['empty',{schema:1,posts:[],featuredItem:null}],['failed',null]]){
 for(const [width,height] of [[1440,800],[1100,800],[900,800],[600,800],[390,844],[1100,600]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({payload})=>{
 const state={phase:'idle',settings:{},install:{},profile:null,actions:[],startupReady:true};
 window.easterDesktop={mode:'desktop',status:async()=>state,onState:()=>()=>{},homeContent:async()=>{if(!payload)throw Error('offline');return payload;}};
 },{payload});
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.locator('.launcher-discovery[aria-busy="false"]').waitFor();
 assert.equal(await page.locator('.discovery-card').count(),2);assert.equal(await page.locator('h1').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const client=await page.locator('.home-hero>.hero-copy').boundingBox();
 const news=await page.locator('.social-card').boundingBox();
 const store=await page.locator('.store-card').boundingBox();
 if(width>1000){
  for(const card of [news,store]){
   assert.ok(Math.abs(card.y-client.y)<2,'all tiles share a top edge');
   assert.ok(Math.abs(card.height-client.height)<2,'all tiles share a height');
  }
 }else if(width>440){
  assert.ok(news.y>=client.y+client.height,'supporting cards follow the client');
  assert.ok(Math.abs(news.y-store.y)<2,'supporting cards share a top edge');
  assert.ok(Math.abs(news.height-store.height)<2,'supporting cards share a height');
 }else assert.ok(store.y>=news.y+news.height,'narrow cards stack without overlapping');

 if(name==='populated'){
 await page.getByRole('button',{name:'Explore item'}).click();assert.ok(await page.locator('.discovery-dialog').evaluate(d=>d.open));await page.keyboard.press('Escape');assert.ok(!await page.locator('.discovery-dialog').evaluate(d=>d.open));
 assert.equal(await page.locator('.social-card a').getAttribute('target'),'_blank');
 }
 if(name==='failed')assert.ok(await page.getByRole('button',{name:'Try again'}).isVisible());
 assert.deepEqual(errors,[]);
 if(output)await page.screenshot({path:`${output}/discovery-${name}-${width}-${height}.png`});console.log(name,width,'passed');await page.close();
 }
}
await browser.close();
