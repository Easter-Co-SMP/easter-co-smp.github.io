// A linked Microsoft account must never be asked to reconnect twice (ticket 3027a681).
//
// Owen's report, four days running: every launch of the launcher showed "Reconnect
// Microsoft / Starts Minecraft as OwenEaster" and he had to sign in to Microsoft again
// before Minecraft started. The account service's own audit line agreed with the screen —
// every mint for account 34 answered `outcome=absent`, so nothing was ever stored.
//
// This journey composes the two real halves: the launcher's own main process, and the real
// account service (/root/easter-co-cloud/tests/launcher_api_fixture.py) behind a proxy that
// records every request body. Only Microsoft is a fixture — and it is a fixture that
// behaves like Microsoft, which is the whole point: a refresh token is single use, and a
// replacement comes back only when the request asked for offline_access
// (tests/desktop/microsoft-fixture.cjs). Every other harness in this suite answers a fresh
// refresh token on every grant, which is exactly why nothing here noticed a launcher that
// kept, vaulted and handed over the token it had just spent.
//
//   cd /root/easter-co-cloud && PYTHONPATH=/root/easter-co-cloud \
//     EASTER_API_FIXTURE_PORT=18796 .venv/bin/python tests/launcher_api_fixture.py &
//   xvfb-run -a node tests/desktop/handover.electron.mjs
//
// Verdicts are read from this file's log, never through a pipe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const fixtureOrigin=process.env.EASTER_FIXTURE_ORIGIN||'http://127.0.0.1:18796';
const vaultKey=randomBytes(32).toString('hex');
const images=process.env.EASTER_HANDOVER_IMAGES||'/tmp/easter-handover';
await fs.mkdir(images,{recursive:true});
const steps=[];
const note=(name,detail)=>{steps.push(name);console.log(`  ok  ${name}${detail?' — '+detail:''}`);};

// A recording proxy in front of the real account service. It adds no endpoint and changes no
// answer: it exists so the journey can assert on the request body that reaches the service,
// which is where the hand-over travels.
const seen=[];
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
  const entry={at:Date.now(),method:request.method,path:request.url,authorization:request.headers.authorization,body:body.toString('utf8'),status:null,answer:''};
  seen.push(entry);
  try{
   const answer=await forward(request,body);
   entry.status=answer.status;entry.answer=answer.body.toString('utf8').slice(0,400);
   response.writeHead(answer.status,answer.headers);response.end(answer.body);
  }catch{
   response.writeHead(502,{'Content-Type':'application/json'});response.end('{"error":"fixture_unreachable"}');
  }
 });
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const apiBase='http://127.0.0.1:'+proxy.address().port;
const calls=(pathname,from=0)=>seen.filter((call,index)=>index>=from&&call.path===pathname);
const mark=()=>seen.length;
// One authenticated request to the real account service, through the same recording proxy,
// for the fixture work a journey does on its own behalf (revoking a stored session).
const call=(pathname,token,body='{}')=>new Promise((resolve,reject)=>{
 const payload=Buffer.from(body);
 const request=http.request({hostname:'127.0.0.1',port:proxy.address().port,path:pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':payload.length,Authorization:'Bearer '+token}},response=>{
  const chunks=[];
  response.on('data',chunk=>chunks.push(chunk));
  response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
 });
 request.on('error',reject);request.write(payload);request.end();
});

const homes=[],apps=[];
// The identity each install signed in with. A later launch of the same install must present
// the same Microsoft identity — a different user hash is a different Microsoft account, and
// the account service refuses to re-link one to another's Easter Company account (409).
const identityOf=new Map();
const launch=async({home,mode,uhs})=>{
 const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/handover-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_VAULT_FIXTURE_KEY:vaultKey,EASTER_API_BASE_URL:apiBase,EASTER_HANDOVER_MODE:mode,EASTER_HANDOVER_UHS:uhs}});
 apps.push(app);
 const page=await app.firstWindow();page.setDefaultTimeout(25000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const approve=async code=>{await page.locator('.desktop-code').filter({hasText:code}).waitFor();await app.evaluate(()=>global.easterHandoverApprove());};
 const signIns=()=>app.evaluate(()=>global.easterHandoverSignIns);
 const close=async()=>{await app.close();assert.deepEqual(errors,[]);};
 return {app,page,hero,status,approve,signIns,close};
};
// The encrypted vaults, opened the way the launcher opens them, so the journey can say what
// this machine still holds of the player's Microsoft session and what it no longer holds.
const vault=async(home,name)=>{
 const bytes=await fs.readFile(path.join(home,name));
 const key=Buffer.from(vaultKey,'hex');
 const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
};
const microsoftState=async home=>JSON.parse(await fs.readFile(path.join(home,'microsoft-state.json'),'utf8'));
// One day later, which is the only shape the feature exists for: the Minecraft access token
// the launcher holds has expired, it holds no refresh token of its own (the hand-over was
// proved), and the account service's stored session is the only thing that can make the next
// launch playable. Time cannot be waited out in a journey, so the vault's own expiry is what
// moves. Nothing else about the entry changes, and the file is written the way the launcher
// writes it: AES-256-GCM with a fresh nonce, tag first.
const ageSavedSession=async home=>{
 const file=path.join(home,'accounts.enc');
 const bytes=await fs.readFile(file);
 const key=Buffer.from(vaultKey,'hex');
 const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 const payload=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
 payload.accounts=(payload.accounts||[]).map(entry=>entry?{...entry,expiresAt:0}:entry);
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 const sealed=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
 await fs.writeFile(file,Buffer.concat([nonce,cipher.getAuthTag(),sealed]));
};
const homepage=async()=>(await fs.mkdtemp(path.join(os.tmpdir(),'easter-handover-'))).valueOf();

// One complete first launch: a Microsoft sign-in that hands the session over, and the
// username and password that make the account able to play.
async function signInAndFinishSetup({home,mode,uhs,username}){
 const run=await launch({home,mode,uhs});
 const started=mark();
 await run.hero('signin').click();
 const dialog=run.page.locator('#desktop-company-signin');
 await dialog.waitFor();
 await run.page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await run.approve('HANDOVER-TEST');
 const usernameStep=run.page.locator('#desktop-company-username');
 try{
  await usernameStep.waitFor({timeout:30000});
 }catch(error){
  const screen=await run.page.evaluate(()=>({
   notice:(document.querySelector('.desktop-page-notice')?.textContent||'').trim(),
   dialogError:(document.querySelector('.desktop-auth-error')?.textContent||'').trim(),
   open:Boolean(document.querySelector('#desktop-signin')?.open),
   account:(document.querySelector('.desktop-account-nav')?.textContent||'').trim()
  }));
  throw Error('the username step never appeared; the screen said '+JSON.stringify(screen)+' ('+error.message.split('\n')[0]+')');
 }
 await usernameStep.getByLabel('Username',{exact:true}).fill(username);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 const setup=run.page.locator('#desktop-company-password');
 await setup.waitFor();
 await setup.getByLabel('New password',{exact:true}).fill('fixture secret passphrase');
 await setup.getByLabel('Confirm password',{exact:true}).fill('fixture secret passphrase');
 await setup.getByRole('button',{name:'Save password',exact:true}).click();
 await run.hero('play').waitFor();
 return {...run,started};
}

let active=null;
try{
 for(const mode of (process.env.EASTER_HANDOVER_MODES||'unproven,proven').split(',')){
  // ---------------------------------------------------------------------------------
  // 1. ONE SIGN-IN, AND THE TOKEN IT HANDS OVER IS ONE MICROSOFT STILL ACCEPTS.
  //    'unproven' is the shape the brief names: the device-code answer is minted for the
  //    client application, so auth.cjs reissues it for XboxLive.signin first. 'proven' is
  //    the other shape Microsoft can answer with, where only the Graph leg spends a token.
  //    Today's launcher hands over a spent token in both.
  // ---------------------------------------------------------------------------------
  const home=await homepage();homes.push(home);
  const uhs=String(Date.now()).slice(-9);
  identityOf.set(home,uhs);
  const username='hand_'+uhs;
  console.log(`[journey] mode ${mode}, home ${home}`);
  const first=await signInAndFinishSetup({home,mode,uhs,username});
  active=first;
  const signedIn=await first.status();
  assert.equal(signedIn.account.username,username);
  assert.equal(signedIn.companyReady,true);
  assert.equal(signedIn.canPlay,true,'the fresh sign-in can play');
  const signInCall=calls('/v2/accounts/microsoft',first.started).pop();
  assert(signInCall,'the launcher signed in to the account service');
  const body=JSON.parse(signInCall.body);
  assert.equal(typeof body.microsoftRefreshToken,'string');
  assert(body.microsoftRefreshToken.length>0,'the sign-in request carries a non-empty microsoftRefreshToken');
  assert.deepEqual(Object.keys(body).filter(key=>/refresh/i.test(key)),['microsoftRefreshToken'],'under one field name, exactly once');
  const microsoft=await microsoftState(home);
  assert(microsoft.live.includes(body.microsoftRefreshToken),'the refresh token the account service was given is one Microsoft would still accept; it was given '+body.microsoftRefreshToken+' and Microsoft holds '+JSON.stringify(microsoft.live));
  // Nothing dead is left behind on this machine either: a proved hand-over drops the
  // launcher's own copy, and an unproved one must still be a copy worth keeping.
  const savedVault=await vault(home,'accounts.enc');
  const kept=(savedVault.accounts||[]).filter(Boolean).find(entry=>entry.refreshToken);
  assert(!kept||microsoft.live.includes(kept.refreshToken),'whatever refresh token this machine still holds is live at Microsoft');
  const spentTokens=microsoft.issued.filter(token=>!microsoft.live.includes(token));
  assert(spentTokens.length>0,'this sign-in did spend at least one refresh token, which is what makes the check below mean something');
  for(const token of spentTokens)assert(!JSON.stringify(savedVault).includes(token),'no spent token text is anywhere in the vault: '+token);
  await first.page.screenshot({path:path.join(images,mode+'-1-signed-in.png'),animations:'disabled'});
  await first.close();active=null;
  note(mode+' sign-in: the hand-over carries a live refresh token',body.microsoftRefreshToken+' still live at Microsoft');

  // ---------------------------------------------------------------------------------
  // 2. THE ACCOUNT SERVICE REALLY HOLDS IT. Asked directly, with the Company session this
  //    install's own vault carries, so the answer is the service's and not the launcher's.
  // ---------------------------------------------------------------------------------
  const company=await vault(home,'company.enc');
  const mint=await new Promise((resolve,reject)=>{
   const payload=JSON.stringify({client:'handover-journey'});
   const call=http.request({hostname:'127.0.0.1',port:proxy.address().port,path:'/v2/game/session',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),Authorization:'Bearer '+company.token}},response=>{
    const chunks=[];
    response.on('data',chunk=>chunks.push(chunk));
    response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
   });
   call.on('error',reject);call.write(payload);call.end();
  });
  assert.equal(mint.status,200,'the account service mints a Minecraft session for this account: '+mint.body.slice(0,200));
  const minted=JSON.parse(mint.body);
  assert.equal(typeof minted.accessToken,'string');
  assert.equal(minted.profile.name,'FixtureCaptain');
  note(mode+' the account service holds the session',JSON.stringify({status:mint.status,profile:minted.profile.name}));

  // ---------------------------------------------------------------------------------
  // 3. THE SECOND LAUNCH OF THE SAME INSTALL. No prompt, no Microsoft sign-in, PLAY NOW.
  //    This is the assertion that fails on the shipped launcher: its stored session was
  //    dead on arrival, so the service answered absent and the hero asked for Microsoft.
  // ---------------------------------------------------------------------------------
  await ageSavedSession(home);
  const secondStart=mark();
  const second=await launch({home,mode,uhs});active=second;
  await second.hero('play').waitFor();
  const secondState=await second.status();
  // `local` is the word a linked account with a matching Microsoft leg keeps, and `server`
  // is the word once the service has answered; the contract allows either. What must be
  // true is that the service was asked and answered, which is `serverHeld`.
  assert.equal(['server','local'].includes(secondState.minecraftSession.state),true,'the session is restored: '+secondState.minecraftSession.state);
  assert.equal(secondState.minecraftSession.serverHeld,true,'and the launcher knows the account service holds it');
  assert.equal(secondState.canPlay,true,'Play is available on the second launch');
  assert.equal(calls('/v2/game/session',secondStart).length>=1,true,'the second launch asks the service and is answered');
  assert.equal(await second.page.locator('[data-desktop-play][data-action="connect-microsoft"]').count(),0,'no Reconnect Microsoft');
  assert.equal(await second.page.locator('[data-desktop-play][data-action="link-microsoft"]').count(),0,'and no Link Microsoft');
  assert.equal(await second.page.locator('#desktop-signin[open]').count(),0,'no Microsoft dialog is open');
  assert.equal(await second.signIns(),0,'and no Microsoft sign-in was started');
  const heroText=(await second.page.locator('[data-desktop-play]').innerText()).replace(/\s+/g,' ').trim();
  assert.match(heroText,/PLAY NOW/,'the hero offers Play: '+heroText);
  assert(!/Microsoft|Xbox|Reconnect/i.test(heroText),'and asks nothing Microsoft: '+heroText);
  assert.equal(calls('/v2/accounts/microsoft',secondStart).length,0,'the second launch sends no sign-in request at all');
  await second.page.screenshot({path:path.join(images,mode+'-2-second-launch.png'),animations:'disabled'});
  await second.close();active=null;
  note(mode+' second launch: PLAY NOW, no reconnect prompt','state='+secondState.minecraftSession.state+', serverHeld='+secondState.minecraftSession.serverHeld);
 }

 // ----------------------------------------------------------------------------------
 // 4. A GENUINELY DEAD SESSION: the service's stored session is gone, so the next launch
 //    can only ask Microsoft. Reconnect is offered once, one sign-in ends it, and nothing
 //    asks a second time.
 // ----------------------------------------------------------------------------------
 const home=homes[0];
 const uhs=identityOf.get(home);
 // "Signed out everywhere", done where it belongs: the account service's own revoke route,
 // with this install's Company session. The launcher is not involved, so the launch below
 // meets a genuinely dead session rather than one it was told about.
 const companyToken=(await vault(home,'company.enc')).token;
 const revoke=await call('/v2/game/session/revoke',companyToken);
 assert.equal(revoke.status,200,'the stored session was revoked by the service: '+revoke.body.slice(0,120));
 assert.equal(JSON.parse(revoke.body).revoked,true,'and it had one to revoke');

 const dead=await launch({home,mode:'unproven',uhs});active=dead;
 // The startup mint is what discovers the death; the hero can only change once it answers.
 await dead.page.waitForFunction(async()=>{const state=await window.easterDesktop.status();return state.minecraftSession&&state.minecraftSession.state!=='checking';},null,{timeout:60000});
 const deadState=await dead.status();
 assert.equal(deadState.minecraftSession.state,'reauth','the service says the stored session is dead: '+JSON.stringify(deadState.minecraftSession));
 assert.equal(deadState.canPlay,false,'Play is not offered for a session that is gone');
 const reconnect=dead.page.locator('[data-desktop-play][data-action="connect-microsoft"]');
 await reconnect.waitFor();
 const reconnectWords=(await reconnect.innerText()).replace(/\s+/g,' ').trim();
 assert.match(reconnectWords,/Reconnect Microsoft/,'the linked account reads Reconnect Microsoft: '+reconnectWords);
 assert(!/Sign in with Microsoft/i.test(reconnectWords),'and never "Sign in with Microsoft": '+reconnectWords);
 assert.equal(await dead.signIns(),0,'nothing has asked Microsoft yet');
 await dead.page.screenshot({path:path.join(images,'4-reconnect-once.png'),animations:'disabled'});
 await reconnect.click();
 await dead.approve('HANDOVER-TEST');
 try{
  await dead.hero('play').waitFor({timeout:45000});
 }catch(error){
  const state=await dead.status();
  const node=dead.page.locator('[data-desktop-play]');
  throw Error('after the reconnect press there is no Play: '+JSON.stringify({minecraftSession:state.minecraftSession,canPlay:state.canPlay,companyReady:state.companyReady,accountWorking:state.accountWorking,signInOpen:Boolean(await dead.page.locator('#desktop-signin[open]').count()),heroAction:await node.count()?await node.getAttribute('data-action'):'(no hero)',mints:calls('/v2/game/session').map(call=>call.status),accounts:calls('/v2/accounts/microsoft').map(call=>call.status)})+' ('+error.message.split('\n')[0]+')');
 }
 assert.equal(await dead.signIns(),1,'the reconnect started exactly one Microsoft sign-in');
 assert.equal(await dead.page.locator('[data-desktop-play][data-action="connect-microsoft"]').count(),0,'and it did not come back');
 const revived=await dead.status();
 assert.equal(revived.canPlay,true,'the account is ready to play again');
 assert.equal(revived.minecraftSession.serverHeld,true,'and the service holds the session it was just given');
 // Never a loop: nothing asks a second time while the launcher sits there.
 await dead.page.waitForTimeout(3000);
 assert.equal(await dead.signIns(),1,'and still exactly one sign-in a few seconds later');
 assert.equal(await dead.page.locator('#desktop-signin[open]').count(),0,'no dialog came back by itself');
 note('a dead session: Reconnect offered once, one sign-in, never a loop');

 await dead.close();active=null;

 console.log(`\nHANDOVER PASS: ${steps.length} steps — real main process, real account service (${fixtureOrigin}), Microsoft fixture with single-use refresh tokens in both shapes`);
}catch(error){
 console.error('\nFAILED after '+steps.length+' step(s): '+(error.stack||error.message));
 process.exitCode=1;
}finally{
 for(const app of apps)await app.close().catch(()=>{});
 active=null;
 proxy.close();
 for(const home of homes)await fs.rm(home,{recursive:true,force:true});
}
