// MICROSOFT LINKING ON A WEB SURFACE, PRESSED IN THE REAL DIALOG.
//
// Owen, 2026-11-01, pasting the Linked Accounts dialog: "we need to re-enable microsoft account
// linking across all surfaces." The row said "Connect Microsoft in the launcher." on every web
// surface and went nowhere. This suite presses it.
//
// WHAT IS REAL HERE: site/ as it is served (python3 -m http.server), the account control and the
// Linked Accounts dialog out of site/, the whole browser seam (site/web-account.mjs,
// site/account/microsoft-signin.mjs, site/account/account.mjs, site/web.js), and the ACCOUNT
// SERVICE ITSELF - tests/launcher_api_fixture.py from /root/easter-co-cloud, which is the real
// handler, the real IdentityStore and the real rules over an in-memory DynamoDB. The only thing
// stubbed is Microsoft: the navigation to login.microsoftonline.com is answered locally and sent
// straight back to /account/ with a code, because a real sign-in is a person typing a password.
//
// BOTH DIRECTIONS, because one of them alone is a security regression waiting to happen:
//
//   1. LINKED - the proof belongs to nobody yet, so the service applies it to the account the
//      session names. The Microsoft row comes back linked with the gamertag and the Minecraft
//      name, on the SAME Company account: `created` is false and no second account appears.
//   2. REFUSED - the proof belongs to ANOTHER Company account. The exchange answers 409
//      identity_conflict with the existing sentence, the row keeps offering Connect, and the
//      player is still signed in to their own account.
//
// The Google, Steam and Discord rows are compared across both presses, because this ticket must
// not change them.
//
//   python3 -m http.server 18129 --directory site &
//   EASTER_API_FIXTURE_PORT=18791 EASTER_PROVIDER_FIXTURE=1 PYTHONPATH=/root/easter-co-cloud \
//     /root/easter-co-cloud/.venv/bin/python /root/easter-co-cloud/tests/launcher_api_fixture.py &
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18129 EASTER_API_FIXTURE=http://127.0.0.1:18791 \
//     node tests/account-linking-browser.mjs
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {API_ORIGIN} from '../site/account-client.mjs';
import {REDIRECT_URI} from '../site/account/microsoft-signin.mjs';

const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18129';
const fixture=process.env.EASTER_API_FIXTURE||'http://127.0.0.1:18791';
const notes=[];
const note=text=>{notes.push(text);console.log('  ok  '+text);};

// TWO MICROSOFT IDENTITIES, ONE PER RUN. The fixture derives the Xbox subject and the Minecraft
// uuid from the authorization code's own label, so a code reused by an earlier run is an identity
// that already belongs to that run's account - and this suite would then be testing the refusal
// in both presses. Every code below is stamped for the run.
// TWO stamps, because the fixture reads the code's LAST segment as the Xbox identity: one stamp
// shared by both codes would make the second Microsoft account the same identity as the first.
const stamp=Math.random().toString(36).slice(2,8);
const otherStamp=Math.random().toString(36).slice(2,8);
// Both codes END in `second<label>`, which /root/easter-co-cloud's tests/launcher_api_fixture.py
// reads as a DIFFERENT synthetic Xbox identity - the only way one process can offer two Microsoft
// people. The labels differ, so the refusal and the link are not the same person.
const OTHER_CODE='fixture-auth-code-second'+otherStamp;
const LINK_CODE='fixture-auth-code-second'+stamp;

// ---- the account service, over HTTP, exactly as a page calls it ----------------------------
const call=async (path,body,token)=>{
 const headers={Accept:'application/json'};
 if(body!==undefined)headers['Content-Type']='application/json';
 if(token)headers.Authorization='Bearer '+token;
 const response=await fetch(fixture+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();
 let data=null;try{data=JSON.parse(text);}catch{}
 return {status:response.status,body:data,text};
};
// A Company account created by the Google broker: no Microsoft link and no Minecraft identity,
// which is the state a player is in when they attach the Xbox account they play with.
const googleAccount=async label=>{
 const verifier='linking-suite-verifier-'+label+'-'+stamp+'-'+'x'.repeat(24);
 const started=await call('/v2/accounts/providers/start',{provider:'google',verifier});
 assert.equal(started.status,200,'the broker starts');
 await call('/v2/accounts/providers/google/callback?state='+encodeURIComponent(started.body.flow)+'&code=fixture-code-'+label+'-'+stamp);
 const finished=await call('/v2/accounts/providers/finish',{flow:started.body.flow,verifier});
 assert.equal(finished.status,200,'the broker finishes');
 const token=finished.body.session.token;
 // THE FIRST-TIME SETUP, which every account goes through before the menu opens at all: the
 // account control's pill opens the setup dialog rather than the menu while a password is
 // required (site/account-control.mjs, `current.account.passwordRequired`). A live session may
 // set its own password (the account service's own rule), so this is the same thing the player
 // does on the first visit, done where a fixture can do it.
 const password=await call('/v2/accounts/password',{password:'fixture-link-'+label+'-passphrase',username:'lk'+Math.random().toString(36).slice(2,9)},token);
 assert.equal(password.status,200,'the fixture account finishes its first-time setup: '+password.text);
 // Setting a password ISSUES A NEW SESSION and ends the old one (the account service's own rule
 // for a credential change), so the session this suite seeds is the one that answer minted.
 return {account:password.body.account,token:password.body.session.token};
};
// A SECOND Microsoft identity, signed in with no bearer so it opens its own Company account -
// the account the refusal below belongs to.
const otherMicrosoftAccount=async()=>{
 const started=await call('/v2/oauth/microsoft/start',{redirectUri:REDIRECT_URI});
 const exchanged=await call('/v2/oauth/microsoft/exchange',{code:OTHER_CODE,state:started.body.state,client:'website/1'});
 assert.equal(exchanged.status,200,'the second Microsoft identity signs in on its own');
 return {account:exchanged.body.account,token:exchanged.body.session.token};
};

const A=await googleAccount('link-alpha');
const B=await otherMicrosoftAccount();
assert.notEqual(A.account.id,B.account.id,'two Company accounts exist, and only one is signed in here');
note('two Company accounts: A by Google ('+A.account.companyId+'), B by another Microsoft identity ('+B.account.companyId+')');

// ---- the browser ---------------------------------------------------------------------------
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const errors=[];
// Every account-service call this page makes, in order, with what it carried and what it
// answered: the row's flow is evidenced by requests, not by the row's own claims.
const api=[];
// What the stubbed Microsoft hands back when the page is sent there. Set per press.
let microsoftCode=LINK_CODE;
const authorizeUrls=[];
try{
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 if(process.env.EASTER_LINK_DEBUG==='1'){
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())console.log('NAV',frame.url());});
  page.on('requestfailed',request=>console.log('FAILED',request.url().slice(0,80),request.failure()?.errorText));
 }
 // The page's own storage, as a returning visitor has it: the tab keeps the whole
 // companySession document (site/web-account.mjs, SESSION_KEY) with a NUMERIC expiresAt - the
 // vault's own shape, which site/account-client.mjs `storedSession` checks with
 // Number.isFinite - which is what lets the control paint the account on its first frame.
 await page.addInitScript(({token,account,expiresAt})=>{
  if(sessionStorage.getItem('easter-company-web-session-v1'))return;
  sessionStorage.setItem('easter-company-web-session-v1',JSON.stringify({token,expiresAt,account}));
 },{token:A.token,account:A.account,expiresAt:Date.now()+30*60000});
 // THE ACCOUNT SERVICE, forwarded unchanged: method, path, body and Authorization in; the real
 // answer out. Nothing about the product's own client code is replaced.
 await page.route(API_ORIGIN+'/**',async route=>{
  const request=route.request();
  const path=request.url().slice(API_ORIGIN.length);
  const headers=request.headers();
  const method=request.method();
  const answer=await fetch(fixture+path,{method,headers,body:method==='GET'?undefined:request.postData()});
  const body=await answer.text();
  api.push({method,path,status:answer.status,authorization:headers.authorization||null,body});
  await route.fulfill({status:answer.status,contentType:answer.headers.get('content-type')||'application/json',body});
 });
 // MICROSOFT. The authorize navigation is answered locally and sent straight back to the
 // registered callback path on THIS origin, which is what the authority does after a player signs
 // in. The code it hands back is the one this press is testing.
 await page.route('https://login.microsoftonline.com/**',async route=>{
  const url=route.request().url();
  authorizeUrls.push(url);
  const state=new URL(url).searchParams.get('state')||'';
  const back=origin+'/account/?code='+encodeURIComponent(microsoftCode)+'&state='+state;
  await route.fulfill({status:200,contentType:'text/html',
   body:'<!doctype html><meta charset="utf-8"><title>Microsoft</title><script>location.replace('+JSON.stringify(back)+');</script>'});
 });
 await page.goto(origin);
 const navName=()=>page.evaluate(()=>(document.querySelector('.web-account-nav .web-account-name')?.textContent||'').trim());
 await page.waitForFunction(()=>document.querySelector('.web-account-nav .web-account-name')?.textContent?.trim());
 const A_NAME=await navName();
 assert.equal(A_NAME,'Fixture google','account A paints from its own stored session, under the name the service publishes');
 note('site root: the nav paints account A ('+A.account.companyId+') from its own stored session');

 const openLinked=async()=>{
  await page.locator('.web-account-nav').click();
  await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
  await page.locator('#company-linked-accounts').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelectorAll('#company-linked-accounts .company-provider-link').length===4);
 };
 const rows=()=>page.evaluate(()=>[...document.querySelectorAll('#company-linked-accounts .company-provider-link')].map(row=>row.innerText.replace(/\s*\n\s*/g,' | ').trim()));
 const rowFor=async name=>(await rows()).find(text=>text.startsWith(name));
 // One exchange, waited for: the answer arrives on another document, so the evidence is the
 // request the page posted rather than anything this tab still holds.
 const waitForExchange=async since=>{
  for(let attempt=0;attempt<200;attempt++){
   const found=api.slice(since).filter(entry=>entry.path==='/v2/oauth/microsoft/exchange').at(-1);
   if(found)return found;
   await new Promise(done=>setTimeout(done,100));
  }
  throw new Error('no exchange was posted');
 };
 const close=async()=>{await page.locator('#company-linked-accounts .dialog-close').click();await page.locator('#company-linked-accounts').waitFor({state:'detached'});};
 const pressConnect=async name=>{
  const button=page.getByRole('button',{name:'Connect '+name,exact:true});
  assert.equal(await button.count(),1,'the row offers Connect '+name);
  await button.click();
 };

 // ---- the rows before any press -----------------------------------------------------------
 await openLinked();
 const before=await rows();
 assert.match(before[0],/^Microsoft \/ Xbox \| Connect$/,'the Microsoft row offers Connect, and says nothing about the launcher');
 assert.match(before[1],/^Google · linked \| Gmail: /,'the Google link the account was made with is described');
 note('Linked Accounts before any press: '+JSON.stringify(before));
 const untouched=before.filter(text=>!text.startsWith('Microsoft')).join('\n');
 await close();

 // ---- PRESS 1: a proof belonging to another Company account is refused ---------------------
 microsoftCode=OTHER_CODE;
 const apiBeforeRefusal=api.length;
 await openLinked();
 await pressConnect('Microsoft / Xbox');
 await page.waitForURL(/\/account\/\?code=/,{timeout:20000});
 await page.locator('#account-error').waitFor({state:'visible',timeout:20000}).catch(async error=>{
  console.log('DEBUG url',page.url());
  console.log('DEBUG text',JSON.stringify(await page.locator('body').innerText()));
  console.log('DEBUG oauth',JSON.stringify(api.filter(entry=>entry.path.includes('oauth'))));
  console.log('DEBUG authorize',authorizeUrls.slice(-2));
  throw error;
 });
 const refusal=await page.locator('#account-error').innerText();
 const exchange=api.slice(apiBeforeRefusal).filter(entry=>entry.path==='/v2/oauth/microsoft/exchange').at(-1);
 if(!exchange){
  console.log('DEBUG alert',JSON.stringify(refusal));
  console.log('DEBUG calls',JSON.stringify(api.slice(apiBeforeRefusal)));
  console.log('DEBUG url',page.url());
  throw new Error('no exchange was posted');
 }
 const start=api.slice(apiBeforeRefusal).filter(entry=>entry.path==='/v2/oauth/microsoft/start').at(-1);
 assert.equal(start.status,200,'the flow started: POST /v2/oauth/microsoft/start answered 200');
 assert.match(authorizeUrls.at(-1),/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/authorize\?/,'the browser was sent to Microsoft\'s own page');
 assert.equal(exchange.status,409,'a proof belonging to another Company account is refused');
 assert.match(exchange.authorization,/^Bearer /,'the exchange carried the signed-in session');
 const refusalBody=JSON.parse(exchange.body);
 assert.equal(refusalBody.error,'identity_conflict');
 assert.equal(refusalBody.reason,'account_subject_taken');
 assert.equal(refusal,refusalBody.message,'the page prints the service\'s own sentence, unchanged');
 assert.equal(refusal,'This Microsoft account is already linked to a different Company account, or this Company account already has a Microsoft link.');
 note('press 1 (another account\'s Microsoft identity): authorize URL '+authorizeUrls.at(-1).slice(0,96)+'…');
 note('press 1: POST /v2/oauth/microsoft/start -> 200; POST /v2/oauth/microsoft/exchange -> 409 identity_conflict (account_subject_taken)');
 note('press 1: the page shows "'+refusal+'"');
 // The refusal cost this player nothing: same account, still signed in, Microsoft row still
 // offering Connect.
 await page.goto(origin);
 await page.waitForFunction(()=>document.querySelector('.web-account-nav .web-account-name')?.textContent?.trim());
 assert.equal(await navName(),A_NAME,'a refused link leaves the player signed in to their own account');
 await openLinked();
 assert.match(await rowFor('Microsoft / Xbox'),/^Microsoft \/ Xbox \| Connect$/,'a refused link leaves the Microsoft row as it was');
 assert.equal((await rows()).filter(text=>!text.startsWith('Microsoft')).join('\n'),untouched,'and every other row is exactly as it was');
 await close();
 note('press 1: back on the site, the account is unchanged and the Microsoft row still offers Connect');

 // ---- PRESS 2: a proof nobody owns is applied to the signed-in account ---------------------
 microsoftCode=LINK_CODE;
 const apiBeforeLink=api.length;
 await openLinked();
 await pressConnect('Microsoft / Xbox');
 const linkExchange=await waitForExchange(apiBeforeLink);
 // A link that succeeded ends where a sign-in ends: the account page hands the player back to
 // the site root with the account in the nav (site/account/account.mjs, signedIn()).
 await page.waitForURL(url=>url.origin===origin&&(url.pathname==='/'||url.pathname==='/index.html'),{timeout:20000});
 await page.waitForFunction(()=>document.querySelector('.web-account-nav .web-account-name')?.textContent?.trim());
 assert.equal(linkExchange.status,200,'a proof that belongs to nobody is applied to the signed-in account: '+linkExchange.body);
 assert.match(linkExchange.authorization,/^Bearer /,'and the exchange still carries the session that says which account');
 const linkBody=JSON.parse(linkExchange.body);
 assert.equal(linkBody.created,false,'linking does not open a second Company account');
 assert.equal(linkBody.account.id,A.account.id,'it is the same Company account');
 assert.equal(linkBody.account.companyId,A.account.companyId);
 note('press 2 (a fresh Microsoft identity): exchange -> 200, created=false, account '+linkBody.account.companyId+' is unchanged');
 await openLinked();
 const after=await rows();
 assert.match(after[0],/^Microsoft \/ Xbox · linked \| Xbox Gamer Tag: FixtureXboxGamertag \| Minecraft Username: FixtureCaptain$/,'the Microsoft row now reports what it holds');
 assert.equal(after.filter(text=>!text.startsWith('Microsoft')).join('\n'),untouched,'Google, Steam and Discord are untouched by the link');
 assert.equal(await page.getByRole('button',{name:/^Connect Microsoft/}).count(),0,'a linked Microsoft row offers no Connect, exactly as before');
 note('Linked Accounts after the link: '+JSON.stringify(after));
 // The dialog's own words about links staying with the account are not this ticket's to change.
 const dialogCopy=await page.locator('#company-linked-accounts').innerText();
 assert.match(dialogCopy,/Links stay with this Easter Company account and cannot be removed\./,'the dialog\'s own sentence is untouched');
 await close();

 assert.deepEqual(errors,[],'the page threw nothing: '+errors.join(' | '));
 console.log('\n'+notes.join('\n'));
}finally{
 await context.close();await browser.close();
}
