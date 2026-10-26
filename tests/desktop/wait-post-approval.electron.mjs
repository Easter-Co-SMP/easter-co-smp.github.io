// After Microsoft approval, the launcher must stop asking for the code.
//
// Owen's report of 2026-10-19: having entered the code and finished on Microsoft's page -
// "Done! you are safe to close this page" - the launcher sat on the code and "Open the
// Microsoft page". The 1.0.31 pass is supposed to replace that panel with the current stage
// as soon as the approval is consumed. This proves it against the real account service:
// tests/launcher_api_fixture.py from /root/easter-co-cloud, behind a proxy that holds the
// account call open for longer than the ten-second reassurance threshold.
//
//   cd /root/easter-co-cloud && PYTHONPATH=/root/easter-co-cloud \
//     EASTER_API_FIXTURE_PORT=18798 .venv/bin/python tests/launcher_api_fixture.py &
//   xvfb-run -a node tests/desktop/wait-post-approval.electron.mjs
//
// The proxy is this test's own: it adds no endpoint and changes no launcher code, it only
// makes the account service slow in the one place a human cannot control.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const fixtureOrigin=process.env.EASTER_FIXTURE_ORIGIN||'http://127.0.0.1:18798';
const images=process.env.EASTER_WAIT_IMAGES||'/tmp/easter-wait-post-approval';
await fs.mkdir(images,{recursive:true});
const HOLD_MS=Number(process.env.EASTER_HOLD_MS||13000);
// How long the logout call is held open at step 5. The launcher's own bound on that call is
// eight seconds (desktop/accounts.cjs), so this stays inside it and the sign-out still finishes.
const LOGOUT_HOLD_MS=Number(process.env.EASTER_LOGOUT_HOLD_MS||6000);

const steps=[];
const note=(name,detail)=>{steps.push(name);console.log(`  ok  ${name}${detail?' — '+detail:''}`);};

// A proxy in front of the fixture that can hold one route open, or refuse it, so the wait
// after approval is long enough to see and the failure after approval can be exercised.
const held={requests:[],released:[],holdMs:HOLD_MS,mode:'hold',logout:{holdMs:0,requests:[],released:[]}};
const forward=(request,body)=>new Promise((resolve,reject)=>{
 const target=new URL(fixtureOrigin);
 const call=http.request({hostname:target.hostname,port:target.port,path:request.url,method:request.method,headers:{...request.headers,host:target.host}},response=>{
  const chunks=[];
  response.on('data',chunk=>chunks.push(chunk));
  response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
 });
 call.on('error',reject);
 if(body.length)call.write(body);
 call.end();
});
const proxy=http.createServer((request,response)=>{
 const chunks=[];
 request.on('data',chunk=>chunks.push(chunk));
 request.on('end',async()=>{
  const body=Buffer.concat(chunks);
  const isAccountLogin=request.method==='POST'&&request.url==='/v2/accounts/microsoft';
  if(isAccountLogin){
   const entry={at:Date.now(),mode:held.mode};
   held.requests.push(entry);
   if(held.mode==='hold'){await new Promise(resolve=>setTimeout(resolve,held.holdMs));entry.released=Date.now();held.released.push(entry);}
   else if(held.mode==='refuse'){
    // The account service failing *after* the approval was consumed. Whatever the sentence,
    // the code the player no longer needs must not come back.
    entry.released=Date.now();held.released.push(entry);
    response.writeHead(500,{'Content-Type':'application/json'});return response.end('{"error":"fixture_failure"}');
   }
  }
  // Signing out is a request the account service answers in its own time. The view must not
  // wait for that answer, so this route is held open at step 5 to make the window the defect
  // lived in as wide as the service is slow rather than as narrow as it is fast.
  if(request.method==='POST'&&request.url==='/v2/accounts/logout'){
   const entry={at:Date.now()};
   held.logout.requests.push(entry);
   if(held.logout.holdMs>0)await new Promise(resolve=>setTimeout(resolve,held.logout.holdMs));
   entry.released=Date.now();held.logout.released.push(entry);
  }
  try{
   const answer=await forward(request,body);
   response.writeHead(answer.status,answer.headers);response.end(answer.body);
  }catch{
   response.writeHead(502,{'Content-Type':'application/json'});response.end('{"error":"fixture_unreachable"}');
  }
 });
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const apiBase='http://127.0.0.1:'+proxy.address().port;

const home=await fs.mkdtemp(path.join(os.tmpdir(),'easter-wait-'));
const launch=()=>electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),
 args:['--no-sandbox',path.resolve('tests/desktop/wait-harness.cjs')],
 env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:apiBase,EASTER_WAIT_UHS:String(Date.now()).slice(-9)}});

let app=await launch();
let failed=null;
try{
 let page=await app.firstWindow();
 page.setDefaultTimeout(30000);
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const device=()=>page.evaluate(()=>({
  visible:Boolean(document.querySelector('#desktop-signin')?.open)&&document.querySelector('.desktop-device')?.getBoundingClientRect().height>0,
  // There is no code any more: what the player is waiting on is Microsoft's own page, in their
  // own browser, and the only thing on screen about it is the action that brings it back.
  codeNodes:document.querySelectorAll('.desktop-code').length,
  instruction:(document.querySelector('.desktop-device-instruction')?.textContent||'').trim(),
  open:Boolean(document.querySelector('#desktop-signin')?.open),
  title:document.querySelector('#desktop-signin h2')?.textContent||'',
  wait:(document.querySelector('.desktop-auth-wait')?.innerText||'').trim(),
  box:(()=>{const dialog=document.querySelector('#desktop-signin');if(!dialog?.open)return null;const box=dialog.getBoundingClientRect();return {width:Math.round(box.width),height:Math.round(box.height)};})()
 }));

 // 1. The player is waiting on Microsoft's page, and there is nothing to copy.
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 await page.locator('[data-open-microsoft]').waitFor({state:'visible'});
 const before=await device();
 assert.equal(before.visible,true,'the waiting panel is up while approval is pending');
 assert.equal(before.codeNodes,0,'there is no code element for a player to copy from');
 assert.equal(before.instruction,'The Microsoft sign-in page is open in your browser.','the panel says where the sign-in is: '+before.instruction);
 assert.equal(await page.getByRole('button',{name:'Open the Microsoft sign-in page again',exact:true}).isVisible(),true,'and the browser action is beside it');
 await page.screenshot({path:path.join(images,'1-browser-pending.png')});
 note('approval pending: the browser action and its sentence are on screen, with nothing to copy');

 // 2. The player finishes on Microsoft's page. The approval is consumed by the real account
 //    call, which the proxy holds open, so what happens next is what Owen did not see.
 const approvedAt=Date.now();
 await app.evaluate(()=>global.easterTestApprove());
 await page.waitForFunction(()=>document.querySelector('.desktop-device')?.getBoundingClientRect().height===0,{timeout:10000});
 const hiddenAt=Date.now();
 const afterApproval=await device();
 assert.equal(afterApproval.visible,false,'the waiting panel is gone once the approval is consumed');
 assert.equal(await page.getByRole('button',{name:'Open the Microsoft sign-in page again',exact:true}).isVisible(),false,'the browser action goes with it');
 assert.equal(afterApproval.codeNodes,0,'and no code was ever on screen to leave behind');
 assert.equal(afterApproval.open,true,'the dialog stays for the work that is still running');
 assert.equal(afterApproval.title,'Finishing sign-in…','and says what it is doing now');
 assert.match(afterApproval.wait,/Verifying your Microsoft sign-in|Connecting your Easter Company account|account service is waking|Contacting the account service/,'the stage text replaces the waiting state: '+JSON.stringify(afterApproval.wait));
 assert(hiddenAt-approvedAt<1500,'the panel is replaced at once, not after the account answers ('+(hiddenAt-approvedAt)+'ms)');
 await page.screenshot({path:path.join(images,'2-approval-consumed.png')});
 note('approval consumed: the panel is replaced by stage text', (hiddenAt-approvedAt)+'ms');

 // 3. The account service is slow. The stage text follows the real stage, and after ten
 //    seconds the one quiet reassurance appears without moving anything on screen.
 assert.equal(held.requests.length,1,'the held request is the account call for the approval that was consumed');
 await page.waitForFunction(()=>/Still working/.test(document.querySelector('.desktop-auth-wait')?.innerText||''),null,{timeout:30000});
 const reassurance=await device();
 assert.equal(held.released.length,0,'the reassurance is on screen while the account call is still open');
 assert.equal(reassurance.visible,false,'and the panel is still gone during the long wait');
 assert.deepEqual(reassurance.box,afterApproval.box,'the reassurance does not move or resize the dialog: '+JSON.stringify([afterApproval.box,reassurance.box]));
 assert.match(reassurance.wait,/Still working\. You can leave this open\./,'the ten-second reassurance is the quiet sentence');
 await page.screenshot({path:path.join(images,'3-long-wait-reassurance.png')});
 note('long wait: the ten-second reassurance appears in place, with no panel and no layout move');

 // The stage the launcher is in comes from the main process, not from a guess in the view.
 const duringHold=await status();
 // What replaced "main still holds the code it issued": main still believes the sign-in it
 // started is the live operation while the account call is held open. There is no code to hold
 // any more — the state carries a flag, and that flag is the thing that must not have been
 // cleared early, or the dialog would have let go of a sign-in that is still running.
 assert.equal(duringHold.signInPage,true,'main still knows the sign-in it started is running');
 assert.equal(duringHold.device,undefined,'and it holds no code, because there is none to hold');
 assert(['company-signing-in','company-waking','account-working'].includes(duringHold.activity?.stage),'main names the stage the dialog is showing: '+(duringHold.activity?.stage));

 // 4. The held answer lands: the sign-in finishes and the dialog closes by itself.
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).account!==null,null,{timeout:40000});
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin')?.open,null,{timeout:20000});
 const signed=await status();
 assert.equal(signed.device,undefined,'the state carries no code at all, before or after the sign-in');
 assert.equal(signed.signInPage,null,'and nothing says a sign-in page is open once it is finished');
 assert.equal(signed.account.username,null,'the fixture account has no username yet, so it is asked for one');
 assert.equal(signed.account.name,'FixtureCaptain','the account the launcher signed in to is the fixture provider\'s');
 assert.equal(await page.locator('.desktop-account-nav').innerText(),'FixtureCaptain','the header shows the account name the launcher now holds');
 assert.equal(await page.locator('.desktop-code').count()>0&&await page.locator('.desktop-code').isVisible(),false,'no code is left on screen after a completed sign-in');
 await page.screenshot({path:path.join(images,'4-signed-in.png')});
 note('the held answer completes the sign-in: dialog closed, no code, header names the account');

 // 5. The same dialog after a failure that happens *after* the approval: the code must not
 //    come back as if it were still needed. This is the second start of the sign-in, so the
 //    launcher is signed out and the proxy is told to refuse the account call.
 //    The fixture account has no username yet, so the launcher asks for one over the page;
 //    that is its own step and is dismissed here before the account menu is opened.
 await page.locator('#desktop-company-username .dialog-close').click();
 await page.locator('#desktop-company-username').waitFor({state:'hidden'});
 await page.locator('.desktop-account-nav').click();
 // Signing out is a round trip to the account service, and the view is not allowed to wait for
 // it. Main drops the account at once; this proxy holds the logout call open for
 // LOGOUT_HOLD_MS so the window the defect lived in is as wide as the service is slow rather
 // than as narrow as it is fast - before the fix the header still read "FixtureCaptain" for the
 // whole hold, and a click on it reopened the profile menu for the account that was already
 // gone instead of opening the sign-in chooser (25 ms samples on the page clock from the Logout
 // click: account===null at 64 ms, header read "Sign in" at 676 ms, ~611 ms of the gone
 // account on offer). Held open, the window cannot be "unlikely": it would be six seconds wide.
 held.logout.holdMs=LOGOUT_HOLD_MS;
 await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).account===null,null,{timeout:15000});
 const signedOut=await page.evaluate(async()=>{
  const nav=document.querySelector('.desktop-account-nav'),menu=document.querySelector('.desktop-profile-menu');
  return {header:(nav?.innerText||'').trim(),label:nav?.getAttribute('aria-label')||'',haspopup:nav?.getAttribute('aria-haspopup')||'',
   menuOpen:Boolean(menu?.matches(':popover-open')),chooserOpen:Boolean(document.querySelector('#desktop-company-signin')?.open),
   account:(await window.easterDesktop.status()).account};
 });
 assert.equal(held.logout.released.length,0,'the header is read while the logout call is still open');
 assert.equal(signedOut.account,null,'main has dropped the account');
 assert.equal(signedOut.header,'Sign in','so the header offers to sign in, not the account that just left');
 assert.equal(signedOut.label,'Sign in','and its accessible name says the same');
 assert.equal(signedOut.haspopup,'dialog','and the header opens the sign-in chooser rather than an account menu');
 assert.equal(signedOut.menuOpen,false,'no profile menu is open for the account that is gone');
 assert.equal(signedOut.chooserOpen,false,'and nothing has opened on its own');
 // The click that used to land on the stale menu, made while the logout call is still open.
 await page.locator('.desktop-account-nav').click();
 const clicked=await page.evaluate(()=>{
  const menu=document.querySelector('.desktop-profile-menu'),button=document.querySelector('#desktop-company-signin .company-microsoft');
  const box=button?.getBoundingClientRect();
  return {menuOpen:Boolean(menu?.matches(':popover-open')),heading:(menu?.querySelector('.desktop-account-name')?.textContent||'').trim(),
   chooserOpen:Boolean(document.querySelector('#desktop-company-signin')?.open),button:box?{w:Math.round(box.width),h:Math.round(box.height)}:null};
 });
 assert.equal(held.logout.released.length,0,'the click lands inside the held logout too, not after it');
 assert.equal(clicked.menuOpen,false,'the click does not open a menu for the account that is already gone');
 assert.equal(clicked.heading,'','and no menu is left headed by it');
 assert.equal(clicked.chooserOpen,true,'it opens the sign-in chooser');
 assert(clicked.button&&clicked.button.h>0,'with the sign-in action at a real height, so the click is not dead: '+JSON.stringify(clicked.button));
 await page.screenshot({path:path.join(images,'5-signed-out-header.png')});
 note('signed out: header is its own and the click opens the chooser', 'logout held open '+LOGOUT_HOLD_MS+'ms, nothing repainted by the answer');
 // The chooser is closed again before the held logout settles, so the last broadcast of the
 // sign-out lands on a quiet view and the restart below runs on a settled launcher.
 await page.locator('#desktop-company-signin .dialog-close').click();
 await page.locator('#desktop-company-signin').waitFor({state:'hidden'});
 while(held.logout.released.length===0)await new Promise(resolve=>setTimeout(resolve,50));
 held.logout.holdMs=0;
 held.mode='refuse';
 const signInNav=page.locator('.desktop-account-nav').filter({hasText:'Sign in'});
 await signInNav.waitFor();
 await signInNav.click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 await app.evaluate(()=>global.easterTestApprove());
 await page.waitForFunction(()=>document.querySelector('.desktop-device')?.getBoundingClientRect().height===0,{timeout:10000});
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin')?.open,null,{timeout:30000});
 const refused=await page.evaluate(()=>({
  error:(document.querySelector('.desktop-auth-error')?.textContent||'').trim()||(document.querySelector('.desktop-page-notice')?.firstChild?.textContent||'').trim(),
  codeVisible:Boolean(document.querySelector('.desktop-code')),
  notice:(document.querySelector('.desktop-page-notice')?.textContent||'').trim()
 }));
 assert.equal(refused.codeVisible,false,'a sign-in that failed after approval leaves no code on screen');
 assert(refused.error.length>0,'and reports the failure in the launcher\'s own words: '+JSON.stringify(refused));
 assert(!/HTTP\s*\d|\b5\d\d\b|fixture_failure/.test(refused.error+refused.notice),'the sentence carries no status or provider code: '+JSON.stringify(refused));
 await page.screenshot({path:path.join(images,'5-failed-after-approval.png')});
 note('a post-approval failure: no stale code, one launcher sentence');

 assert.deepEqual(errors,[],'no renderer error is raised anywhere in the flow');
 console.log(`\nPOST-APPROVAL WAIT PASS: ${steps.length} steps — real main process, real account service (${fixtureOrigin}), account call held ${HOLD_MS}ms`);
}catch(error){
 failed=error;
}finally{
 await app.close().catch(()=>{});
 proxy.close();
 await fs.rm(home,{recursive:true,force:true});
}
if(failed){
 console.error('\nFAILED after '+steps.length+' step(s): '+(failed.stack||failed.message));
 process.exit(1);
}
