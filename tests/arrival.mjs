// The opening arrival plays once per launcher session, not once per page.
//
// The top bar's Home link is a real navigation (`href="./"`), so Map -> Home reloads the
// document and re-ran every animation in site/home.js: the mist, the harbour approach and
// the content reveal all played again under a player who had already been sitting in the
// launcher. The fix marks the arrival for the window session, so this harness pins both
// halves of it: the launcher shows it once, and the website keeps showing it per visit.
import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const base=(process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100').replace(/\/$/,'')+'/';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const desktopStub=()=>{window.easterDesktop={mode:'desktop',status:async()=>({}),onState:()=>{}};};
const startArrival=page=>page.evaluate(()=>window.dispatchEvent(new Event('desktop:startup-ready')));
const arriving=page=>page.evaluate(()=>document.body.classList.contains('is-arriving'));
const fresh=async stub=>{
 const context=await browser.newContext({viewport:{width:1360,height:900}});
 if(stub)await context.addInitScript(desktopStub);
 const page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 return {page,errors};
};

try{
 // 1. The launcher's first visit plays it.
 const launcher=await fresh(true);
 await launcher.page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await startArrival(launcher.page);
 await launcher.page.waitForTimeout(120);
 assert.equal(await arriving(launcher.page),true,'the first visit plays the arrival');

 // 2. Map, then Home: the same window session must not play it again.
 await launcher.page.goto(base+'map/',{waitUntil:'domcontentloaded'});
 await launcher.page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await startArrival(launcher.page);
 await launcher.page.waitForTimeout(120);
 assert.equal(await arriving(launcher.page),false,'returning to Home does not replay the arrival');
 assert.deepEqual(launcher.errors,[],'no page errors');

 // 3. A new window is a new session, so the arrival belongs there again.
 const reopened=await fresh(true);
 await reopened.page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await startArrival(reopened.page);
 await reopened.page.waitForTimeout(120);
 assert.equal(await arriving(reopened.page),true,'a reopened launcher plays it again');

 // 4. The website is untouched: an arrival per visit is its intended behaviour.
 const site=await fresh(false);
 await site.page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await site.page.waitForTimeout(120);
 assert.equal(await arriving(site.page),true,'the website keeps its arrival');
 await site.page.goto(base+'map/',{waitUntil:'domcontentloaded'});
 await site.page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await site.page.waitForTimeout(120);
 assert.equal(await arriving(site.page),true,'the website plays it again on a new visit');
 assert.deepEqual(site.errors,[],'no page errors');

 console.log('ARRIVAL PASS: the launcher plays the opening once per window session, returning to Home by the top bar does not replay it, a reopened launcher does, and the website keeps its per-visit arrival');
}finally{
 await browser.close();
}
