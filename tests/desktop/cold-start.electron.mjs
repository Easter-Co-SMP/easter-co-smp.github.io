// A cold account service through the real main process (ticket 922eb7e2, doc/launcher-states.md
// "A cold account service, and what the hero says while it wakes"). Owen's launch on 1.0.33 went
// "Checking your Minecraft session" then "Try again / The account service is busy right now", and
// he could not get in: one bounced call was treated as a verdict. This journey drives the same
// three failures a cold Lambda behind an Aurora cluster at minimum capacity 0 produces — a
// dropped connection, API Gateway's own timeout and a declared `database_unavailable` — and
// proves the launcher now recovers behind the checking sentence, in one launch, without the
// player restarting anything:
//
//   A. the mint bounces three times and then answers: the hero keeps saying it is CHECKING for
//      the whole window, then offers Play — no "busy" verdict is ever shown.
//   B. the service answers a refusal (429, then a declared configuration fault): the hero gives
//      the existing honest "Try again" sentence, Play stays off, and exactly one mint was asked
//      for, because a refusal is an answer and not a transient failure. Pressing the hero's own
//      Try again recovers — the sign-in flow is never restarted.
//   C. the player gives up while a mint is still open: signing out ends the request, and the
//      answer that would have arrived afterwards paints nothing on the launcher that is left.
//   D. a silent server-status read answers after the player has signed out: it is discarded,
//      because it was proved with a session that is no longer anybody's.
//
// The account service is a real loopback HTTP stub; the Microsoft legs and the game process are
// the harness's fixtures. Nothing here reaches the live API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const UHS='fixture-uhs-0123456789abcdef0123456789abcdef';
const ACCOUNT={id:7,username:'captainfixture',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'FixtureCaptain',displayName:'Captain Fixture',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:createHash('sha256').update('xbox-uhs:'+UHS).digest('hex')};
const BUSY_SENTENCE='The account service is busy right now';
// The stub's own switches. `mint` is what the service answers next; `mintDelay` makes it slow on
// purpose; `mintQueue` is a sequence of answers, one per mint, so a cold start can be replayed
// exactly as it happened — first a bounce, then another, then the real answer.
const service={mintQueue:[],mint:'ok',mintDelay:0,statusDelay:0,calls:[]};
const mintedBody=()=>({accessToken:'fixture-minted-minecraft-token',expiresAt:new Date(Date.now()+86400000).toISOString(),profile:{uuid:'12345678-90ab-cdef-1234-567890abcdef',name:'FixtureCaptain'}});
const sessionBody=()=>({created:false,account:ACCOUNT,session:{token:'fixture-company-session-token',expiresAt:new Date(Date.now()+86400000).toISOString()}});
const nextMint=()=>service.mintQueue.length?service.mintQueue.shift():service.mint;
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
  const body=Buffer.concat(chunks).toString('utf8');
  service.calls.push({method:request.method,path:request.url,body});
  const json=(status,payload,headers={})=>{response.writeHead(status,{'Content-Type':'application/json',...headers});response.end(JSON.stringify(payload));};
  const route=request.method+' '+request.url;
  if(route==='POST /v2/accounts/microsoft')return json(200,sessionBody());
  if(route==='POST /v2/accounts/password/login')return json(200,sessionBody());
  if(route==='POST /v2/accounts/session/refresh')return json(200,sessionBody());
  if(route==='GET /v2/accounts/me')return json(200,{account:ACCOUNT});
  if(route==='GET /v2/accounts/providers')return json(200,{providers:['microsoft']});
  if(route==='GET /v2/accounts/emails')return json(200,{emails:[],loginEmail:null});
  if(route==='POST /v2/accounts/logout'){response.writeHead(204);response.end();return;}
  if(route==='POST /v2/game/session'){
   const answer=nextMint();
   // A cold network drops the connection before anything answers.
   if(answer==='drop'){request.socket.destroy();return;}
   if(service.mintDelay)await new Promise(resolve=>setTimeout(resolve,service.mintDelay));
   // API Gateway answers for the service it could not reach: HTML, not the frozen shape.
   if(answer==='gateway-timeout'){response.writeHead(504,{'Content-Type':'text/html'});response.end('<html><body>504 Gateway Time-out</body></html>');return;}
   // Aurora is still resuming: the one failure the service declares safe to ask again.
   if(answer==='database-unavailable')return json(503,{error:'database_unavailable'});
   // A refusal: an answer, not a failure.
   if(answer==='rate-limited')return json(429,{error:'rate_limited'},{'Retry-After':'600'});
   if(answer==='reauth')return json(401,{error:'reauth_required'});
   // The service says its own key is missing: a configuration fault that cannot resolve itself.
   if(answer==='not-configured')return json(503,{error:'session_key_unconfigured'});
   return json(200,mintedBody());
  }
  if(route==='POST /v2/game/session/revoke')return json(200,{revoked:true});
  if(route==='GET /v2/game/status'){
   // A read that answers late, so the journey can sign out while it is still open.
   if(service.statusDelay)await new Promise(resolve=>setTimeout(resolve,service.statusDelay));
   return json(200,{state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-19T00:00:00Z',players:2,detail:''});
  }
  if(route==='POST /v2/game/wake')return json(200,{state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-19T00:00:00Z',players:2,detail:''});
  response.writeHead(404,{'Content-Type':'text/html'});response.end('Not Found');
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const api='http://127.0.0.1:'+stub.address().port;
const vaultKey=randomBytes(32).toString('hex');
const homes=[];
const launch=async()=>{
 const home=await fs.mkdtemp('/tmp/cold-start-electron-');homes.push(home);
 const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/server-session-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_VAULT_FIXTURE_KEY:vaultKey,EASTER_API_BASE_URL:api}});
 const page=await app.firstWindow();page.setDefaultTimeout(45000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 process.stdout.write('[journey] '+home+' ready\n');
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const heroText=async()=>(await page.locator('.hero-copy').innerText()).replace(/\s+/g,' ');
 const passwordSignIn=async()=>{
  await hero('signin').click();
  const dialog=page.locator('#desktop-company-signin');
  await dialog.getByLabel('Username or Email',{exact:true}).fill(ACCOUNT.username);
  await dialog.getByLabel('Password',{exact:true}).fill('fixture secret passphrase');
  await dialog.getByRole('button',{name:'Sign in',exact:true}).click();
 };
 // The Microsoft flow's own device code, approved from here: this is the sign-in that also
 // fires the silent server-status read, so it is the one scenario D needs.
 const approve=async()=>{await page.locator('.desktop-code').filter({hasText:'SESSION-TEST'}).waitFor();await app.evaluate(()=>global.easterTestApprove());};
 const close=async()=>{await app.close();assert.deepEqual(errors,[]);};
 return {app,page,hero,status,heroText,passwordSignIn,approve,close,home};
};
const mintCalls=()=>service.calls.filter(call=>call.path==='/v2/game/session');
try{
 // ---- A: the cold start, recovered behind the checking sentence ----------------------
 process.stdout.write('[journey] scenario  A: a cold mint recovers\n');
 // The sequence Owen hit, in order: the connection is dropped, the gateway times out, the
 // database is still resuming — and then the service answers.
 service.mintQueue=['drop','gateway-timeout','database-unavailable','ok'];
 service.mintDelay=0;
 const a=await launch();
 await a.passwordSignIn();
 // The hero says what it is doing for the whole retry window. This is the sentence Owen must
 // read instead of the busy verdict while the launcher is still asking.
 await a.page.waitForFunction(async()=>{const state=await window.easterDesktop.status();return state.minecraftSession?.state==='checking';});
 const during=await a.status();
 const duringText=await a.heroText();
 assert.equal(during.minecraftSession.state,'checking','the hero says it is checking, not that the service is busy');
 assert(duringText.includes('Checking your Minecraft session'),'the checking sentence is what the player reads: '+duringText);
 assert(!duringText.includes(BUSY_SENTENCE),'and it does not accuse the service while it is still trying: '+duringText);
 assert(!/Microsoft/i.test(duringText),'nor ask for a Microsoft sign-in over a service problem: '+duringText);
 assert.equal(during.canPlay,false,'Play is not offered on a session that has not arrived');
 await a.page.screenshot({path:'/tmp/cold-start-checking.png',animations:'disabled'});
 // Two more attempts land after this one; the hero must still be checking at the end of them.
 await a.page.waitForTimeout(5000);
 const midway=await a.status();
 const midwayText=await a.heroText();
 assert(midway.minecraftSession?.state==='checking'||midway.minecraftSession?.state==='server','the retry window stays on the checking state until an answer arrives: '+JSON.stringify(midway.minecraftSession));
 assert(!midwayText.includes(BUSY_SENTENCE),'the busy verdict is never shown while the retries are running: '+midwayText);
 // And then the service answers, in the same press, with no sign-in restarted.
 await a.hero('play').waitFor();
 const recovered=await a.status();
 assert.equal(recovered.canPlay,true,'the cold service recovered and Play is offered');
 assert.deepEqual({...recovered.minecraftSession,checkedAt:null},{state:'server',serverHeld:true,checkedAt:null});
 assert.equal(recovered.profile?.name,'FixtureCaptain','with the profile the service minted');
 assert.equal(mintCalls().filter(call=>call.path==='/v2/game/session').length,4,'three bounces and one answer: a refusal-free cold start is asked again until it answers');
 await a.page.screenshot({path:'/tmp/cold-start-recovered.png',animations:'disabled'});
 await a.close();

 // ---- B: a refusal is an answer, and the hero says so ---------------------------------
 process.stdout.write('[journey] scenario  B: a refusal is an answer\n');
 // 429 is the service limiting the launcher: it heard the request. Asking again would spend
 // the same answer, so the hero gives the sentence and the press stops — and pressing Try again
 // recovers without restarting the sign-in.
 service.mintQueue=[];service.mint='rate-limited';service.mintDelay=0;
 const before429=mintCalls().length;
 const b=await launch();
 await b.passwordSignIn();
 await b.hero('retry-minecraft').waitFor();
 const refused=await b.status();
 const refusedText=await b.heroText();
 assert.equal(refused.minecraftSession.state,'busy','a refusal is the post-budget verdict');
 assert(refusedText.includes(BUSY_SENTENCE),'the existing honest sentence: '+refusedText);
 assert(refusedText.includes('Try again'),'and the retry that press earns: '+refusedText);
 assert(!/Microsoft/i.test(refusedText),'a rate limit is never read as a dead session: '+refusedText);
 assert.equal(refused.canPlay,false,'Play stays off for this press');
 assert.equal(await b.page.locator('[data-desktop-play][data-action="play"]').count(),0);
 assert.equal(mintCalls().length-before429,1,'a 429 is asked for exactly once: it is an answer, not a transient failure');
 await b.page.screenshot({path:'/tmp/cold-start-verdict.png',animations:'disabled'});
 // The player presses the hero's own Try again once the service is free again.
 service.mint='ok';
 await b.hero('retry-minecraft').click();
 await b.hero('play').waitFor();
 assert.equal((await b.status()).canPlay,true,'Try again recovers without restarting the sign-in flow');
 assert.equal(mintCalls().length-before429,2);
 // A declared configuration fault is not a cold start either: waiting cannot configure it.
 service.mint='not-configured';
 await b.page.evaluate(()=>window.easterDesktop.signOut());
 await b.hero('signin').waitFor();
 const beforeFault=mintCalls().length;
 await b.passwordSignIn();
 await b.hero('retry-minecraft').waitFor();
 assert.equal(mintCalls().length-beforeFault,1,'a service that says its own key is missing is asked once, not for three minutes');
 assert((await b.heroText()).includes(BUSY_SENTENCE));
 await b.close();

 // ---- C: giving up while the service is still being asked ----------------------------
 process.stdout.write('[journey] scenario  C: signing out ends the wait\n');
 service.mintQueue=[];service.mint='ok';service.mintDelay=4000;
 const c=await launch();
 await c.passwordSignIn();
 await c.page.waitForFunction(async()=>{const state=await window.easterDesktop.status();return state.minecraftSession?.state==='checking';});
 assert.equal((await c.status()).account?.username,ACCOUNT.username,'the account is signed in while the mint is open');
 // The player gives up: signing out is allowed while a mint is still in flight, and it ends it.
 await c.page.evaluate(()=>window.easterDesktop.signOut());
 await c.hero('signin').waitFor();
 const signedOut=await c.status();
 assert.equal(signedOut.account,null,'signing out is not blocked by a mint in flight');
 assert.equal(signedOut.minecraftSession,null,'and it leaves no session claim behind');
 assert.equal(signedOut.profile,null,'nor a Minecraft profile');
 // The answer this mint would have produced arrives after the player has gone. It must paint
 // nothing: the launcher has no account for it to belong to.
 await c.page.waitForTimeout(6000);
 const afterwards=await c.status();
 assert.equal(afterwards.account,null,'the late answer created no account');
 assert.equal(afterwards.minecraftSession,null,'and no session state');
 assert.equal(afterwards.profile,null,'and no profile');
 assert.notEqual(afterwards.minecraftSession?.state,'server');
 const afterwardsText=await c.heroText();
 assert(!afterwardsText.includes(BUSY_SENTENCE),'a discarded answer is not reported as a service problem: '+afterwardsText);
 // The wait is genuinely over: the launcher still works, and the flow needs no restart.
 service.mintDelay=0;
 await c.passwordSignIn();
 await c.hero('play').waitFor();
 assert.equal((await c.status()).canPlay,true,'the launcher is not wedged by the mint that was given up');
 await c.close();
 // ---- D: a status read that lands after the account has gone ------------------------
 // The mint is not the only call with a window now: the silent server-status read is retried
 // too, so it can also answer after the player has signed out. Its answer was proved with a
 // session that is no longer anybody's, and it must not paint the previous account's server on
 // the launcher that is left behind.
 process.stdout.write('[journey] scenario  D: a late status read is discarded\n');
 service.mint='ok';service.mintDelay=0;service.statusDelay=8000;
 const statusCallsBefore=service.calls.filter(call=>call.path==='/v2/game/status').length;
 const d=await launch();
 // The Microsoft sign-in is the one flow that also asks the game server for its status.
 const signingIn=d.page.evaluate(()=>window.easterDesktop.signIn());
 await d.approve();
 await signingIn;
 await d.hero('play').waitFor();
 const open=await d.status();
 assert.equal(open.account?.username,ACCOUNT.username,'the account signed in');
 assert.equal(open.game.checkedAt,null,'and its status read is still open at this point');
 await d.page.evaluate(()=>window.easterDesktop.signOut());
 await d.hero('signin').waitFor();
 // The read answers now, into a launcher that has no account for it to belong to.
 await d.page.waitForTimeout(10000);
 const landed=await d.status();
 assert.equal(service.calls.filter(call=>call.path==='/v2/game/status').length,statusCallsBefore+1,'the status read happened exactly once');
 assert.equal(landed.account,null,'the account is still signed out');
 assert.equal(landed.game.checkedAt,null,'the late status answer is discarded: it does not even claim to have checked');
 assert.notEqual(landed.game.state,'running','and the previous account\'s server is not painted on the launcher');
 assert(!(await d.page.locator('body').innerText()).includes('Server Online'),'the hero says nothing it cannot prove');
 await d.close();
 console.log('COLD START PASS: a dropped connection, a gateway timeout and a declared database_unavailable recover behind "Checking your Minecraft session…" in one press; a 429 and a declared configuration fault give the existing "Try again" sentence with one request each and recover on the hero\'s own Try again; signing out ends an open mint and discards the answer that lands afterwards; and a status read that answers after the player has signed out is discarded rather than painted.');
}finally{
 await new Promise(resolve=>stub.close(resolve));
 for(const home of homes)await fs.rm(home,{recursive:true,force:true});
}
