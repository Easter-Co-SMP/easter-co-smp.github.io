import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();
 await page.goto(process.env.EASTER_PUBLIC_ORIGIN || 'http://127.0.0.1:18100');
 await page.clock.install();
 await page.evaluate(async()=>{
  const {createProfileStatus}=await import('/profile-status.mjs');
  const host=document.createElement('p');host.id='profile-status-test';document.body.append(host);
  window.profileStatus=createProfileStatus(host);
 });
 const row=page.locator('#profile-status-test');
 const start=()=>page.evaluate(()=>profileStatus.set({message:'Refreshing account details…'}));
 await start();await page.clock.runFor(200);await page.evaluate(()=>profileStatus.set(null));await page.clock.runFor(1000);
 assert.equal(await row.isVisible(),false,'fast responses never flash');
 await start();await page.clock.runFor(400);await start();await page.clock.runFor(100);
 assert.equal(await row.isVisible(),true,'repeated state paints do not postpone slow feedback');
 assert.equal(await row.textContent(),'Refreshing account details…');
 assert.equal(await row.locator('*').count(),0,'no spinner or decorative child elements');
 assert.equal(await row.getAttribute('role'),'status');
 await page.evaluate(()=>profileStatus.set(null));assert.equal(await row.isVisible(),false,'completion clears feedback');
 await start();await page.clock.runFor(250);await page.evaluate(()=>profileStatus.clear());await page.clock.runFor(1000);
 assert.equal(await row.isVisible(),false,'closing before the delay cancels feedback');
 await start();await page.clock.runFor(500);assert.equal(await row.isVisible(),true,'reopening gets its own delay');
 await page.evaluate(()=>profileStatus.clear());assert.equal(await row.textContent(),'','clear removes stale status');
 console.log('Profile status: fast/slow refresh, repeated paints, completion, close/reopen and text-only accessibility passed');
}finally{await browser.close();}
