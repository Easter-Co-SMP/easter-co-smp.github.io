import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 for(const width of [1440,390,320]){
  const page=await browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  await page.goto(origin+'/store/',{waitUntil:'networkidle'});
  assert.equal(await page.evaluate(()=>typeof window.easterDesktop),'undefined');
  const store=page.locator('.company-store');await store.locator('.store-product').first().waitFor();
  assert.match(await store.innerText(),/No charges or in-game delivery/);
  assert.ok(await store.evaluate(n=>n.scrollWidth<=n.clientWidth));
  await store.getByRole('button',{name:'Add 1,000 Crowns to cart'}).click();await store.getByRole('button',{name:'Cart · 1'}).click();await store.getByRole('button',{name:'Review checkout'}).click();await store.getByRole('checkbox').check();await store.getByRole('button',{name:/Place test order/}).click();await store.getByRole('heading',{name:'Your test order is complete.'}).waitFor();
  assert.match(await store.innerText(),/No money was charged/);
  await page.keyboard.press('Escape');const trigger=page.getByRole('button',{name:'Open mock store',exact:true});assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.match(await page.locator('.preview-notice').innerText(),/No real payment/);
  await trigger.click();await store.locator('.store-product').first().waitFor();await store.getByRole('button',{name:'Close store',exact:true}).click();
  for(const label of ['Privacy','Terms']){const href=await page.getByRole('link',{name:label,exact:true}).getAttribute('href');const response=await page.request.get(new URL(href,page.url()).href);assert.equal(response.status(),200);}
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('Public store preview passed:',width);await page.close();
 }
}finally{await browser.close();}
