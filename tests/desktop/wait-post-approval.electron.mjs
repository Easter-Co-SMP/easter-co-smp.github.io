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

const steps=[];
const note=(name,detail)=>{steps.push(name);console.log(`  ok  ${name}${detail?' — '+detail:''}`);};

// A proxy in front of the fixture that can hold one route open, or refuse it, so the wait
// after approval is long enough to see and the failure after approval can be exercised.
const held={requests:[],released:[],holdMs:HOLD_MS,mode:'hold'};
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
  code:document.querySelector('.desktop-code')?.textContent||'',
  open:Boolean(document.querySelector('#desktop-signin')?.open),
  title:document.querySelector('#desktop-signin h2')?.textContent||'',
  wait:(document.querySelector('.desktop-auth-wait')?.innerText||'').trim(),
  box:(()=>{const dialog=document.querySelector('#desktop-signin');if(!dialog?.open)return null;const box=dialog.getBoundingClientRect();return {width:Math.round(box.width),height:Math.round(box.height)};})()
 }));

 // 1. The code is on screen while Microsoft's page is still waiting for the player.
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'WAIT-CODE'}).waitFor();
 const before=await device();
 assert.equal(before.visible,true,'the device panel is up while approval is pending');
 assert.equal(before.code,'WAIT-CODE-1','the code the player has to enter is shown');
 assert.equal(await page.getByRole('button',{name:'Open the Microsoft page',exact:true}).isVisible(),true,'and the browser action is beside it');
 // The code stays a real selection, which is what makes it copyable while it is needed.
 await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.desktop-code'));getSelection().removeAllRanges();getSelection().addRange(range);});
 assert.equal(await page.evaluate(()=>String(getSelection())),'WAIT-CODE-1','the pending code is selectable');
 await page.screenshot({path:path.join(images,'1-code-pending.png')});
 note('approval pending: the code and the Microsoft page action are on screen');

 // 2. The player finishes on Microsoft's page. The approval is consumed by the real account
 //    call, which the proxy holds open, so what happens next is what Owen did not see.
 const approvedAt=Date.now();
 await app.evaluate(()=>global.easterTestApprove());
 await page.waitForFunction(()=>document.querySelector('.desktop-device')?.getBoundingClientRect().height===0,{timeout:10000});
 const hiddenAt=Date.now();
 const afterApproval=await device();
 assert.equal(afterApproval.visible,false,'the device panel is gone once the approval is consumed');
 assert.equal(await page.getByRole('button',{name:'Open the Microsoft page',exact:true}).isVisible(),false,'"Open the Microsoft page" goes with it');
 assert.equal(afterApproval.code,'WAIT-CODE-1','the code node is kept for a later sign-in rather than rewritten');
 assert.equal(await page.locator('.desktop-code').isVisible(),false,'but the consumed code is not on screen');
 assert.equal(afterApproval.open,true,'the dialog stays for the work that is still running');
 assert.equal(afterApproval.title,'Finishing sign-in…','and says what it is doing now');
 assert.match(afterApproval.wait,/Verifying your Microsoft sign-in|Connecting your Easter Company account|account service is waking|Contacting the account service/,'the stage text replaces the code: '+JSON.stringify(afterApproval.wait));
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
 assert.equal(duringHold.device?.code,'WAIT-CODE-1','main still holds the code it issued');
 assert(['company-signing-in','company-waking','account-working'].includes(duringHold.activity?.stage),'main names the stage the dialog is showing: '+(duringHold.activity?.stage));

 // 4. The held answer lands: the sign-in finishes and the dialog closes by itself.
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).account!==null,null,{timeout:40000});
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin')?.open,null,{timeout:20000});
 const signed=await status();
 assert.equal(signed.device,null,'the state carries no device code once the sign-in is finished');
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
 await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).account===null);
 held.mode='refuse';
 // Signing out is a round trip and status() is not the header: the main process drops the
 // account before the view has painted the signed-out header. Measured here, 25 ms samples on
 // the page clock from the Logout click: account===null at 64 ms while .desktop-account-nav
 // still read "FixtureCaptain" and its click handler was still the account menu's own, so the
 // click opened the profile menu instead of the chooser; the header only read "Sign in" at
 // 676 ms, when the stale menu was closed again. Asking for the sign-in chooser in between
 // waits forever on a closed <dialog>. So this waits for the header itself to read "Sign in" -
 // which is also the assertion that it went back to signing in - and clicks from there.
 const signInNav=page.locator('.desktop-account-nav').filter({hasText:'Sign in'});
 await signInNav.waitFor();
 await signInNav.click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'WAIT-CODE'}).waitFor();
 await app.evaluate(()=>global.easterTestApprove());
 await page.waitForFunction(()=>document.querySelector('.desktop-device')?.getBoundingClientRect().height===0,{timeout:10000});
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin')?.open,null,{timeout:30000});
 const refused=await page.evaluate(()=>({
  error:(document.querySelector('.desktop-auth-error')?.textContent||'').trim()||(document.querySelector('.desktop-page-notice')?.firstChild?.textContent||'').trim(),
  codeVisible:Boolean(document.querySelector('.desktop-code')?.getClientRects().length),
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
