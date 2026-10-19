// The server-held Microsoft session, through the real main process (ticket 8a5b3dc1,
// doc/launcher-states.md "The Minecraft session the account service holds"). Four launches,
// each with its own per-user directory:
//
//   A. a Company username-and-password sign-in whose account stores a session server-side:
//      Play is available, the hero asks for no Microsoft sign-in at all, and pressing Play
//      starts the client with the token the service minted.
//   B. a Microsoft sign-in in the launcher hands its refresh token over once, the service is
//      asked to prove it, and the encrypted vault no longer carries the token — after which
//      the same account signing in with its password on "another machine" is ready to play.
//   C. the service answering reauth_required inside a Play press: one sentence, one
//      interactive sign-in, and then the launch — never a loop.
//   D. "Sign out of Minecraft everywhere" in the profile dialog, saying only what it saw.
//
// The account service is a real loopback HTTP stub; the Microsoft legs and the game process are
// the harness's fixtures. Nothing here reaches the live API, which has no session route yet.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const UHS='fixture-uhs-0123456789abcdef0123456789abcdef';
const ACCOUNT={id:7,username:'captainfixture',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'FixtureCaptain',displayName:'Captain Fixture',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:createHash('sha256').update('xbox-uhs:'+UHS).digest('hex')};
const REAUTH_SENTENCE='Microsoft needs you to sign in again before Minecraft starts.';
const REVOKED_SENTENCE='Signed Minecraft out everywhere. The next game on any computer needs a Microsoft sign-in.';
// The stub's own switches. `mint` and `revoke` are what the service answers; the journey flips
// them the way a live service changes its mind.
// `mintDelay` makes the mint slow on purpose: the sign-in must not wait for it, and the journey
// proves that below (a slow account service may never hold a password sign-in open).
const service={mint:'ok',revoke:'ok',mintDelay:0,calls:[]};
const mintedBody=()=>({accessToken:'fixture-minted-minecraft-token',expiresAt:new Date(Date.now()+86400000).toISOString(),profile:{uuid:'12345678-90ab-cdef-1234-567890abcdef',name:'FixtureCaptain'}});
const sessionBody=()=>({created:false,account:ACCOUNT,session:{token:'fixture-company-session-token',expiresAt:new Date(Date.now()+86400000).toISOString()}});
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
  const body=Buffer.concat(chunks).toString('utf8');
  service.calls.push({method:request.method,path:request.url,authorization:request.headers.authorization,body});
  const json=(status,payload)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  const route=request.method+' '+request.url;
  if(route==='POST /v2/accounts/microsoft')return json(200,sessionBody());
  if(route==='POST /v2/accounts/password/login')return json(200,sessionBody());
  if(route==='POST /v2/accounts/session/refresh')return json(200,sessionBody());
  if(route==='GET /v2/accounts/me')return json(200,{account:ACCOUNT});
  if(route==='GET /v2/accounts/providers')return json(200,{providers:['microsoft']});
  if(route==='GET /v2/accounts/emails')return json(200,{emails:[],loginEmail:null});
  if(route==='POST /v2/accounts/logout'){response.writeHead(204);response.end();return;}
  if(route==='POST /v2/game/session'){
   if(service.mintDelay)await new Promise(resolve=>setTimeout(resolve,service.mintDelay));
   if(service.mint==='reauth')return json(401,{error:'reauth_required'});
   if(service.mint==='absent')return json(404,{error:'not_found'});
   return json(200,mintedBody());
  }
  if(route==='POST /v2/game/session/revoke'){
   if(service.revoke==='absent')return json(404,{error:'not_found'});
   return json(200,{revoked:service.revoke!=='nothing'});
  }
  if(route==='GET /v2/game/status'||route==='POST /v2/game/wake')return json(200,{state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-19T00:00:00Z',players:0,detail:''});
  response.writeHead(404,{'Content-Type':'text/html'});response.end('Not Found');
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const api='http://127.0.0.1:'+stub.address().port;
const vaultKey=randomBytes(32).toString('hex');
const homes=[];
const launch=async()=>{
 const home=await fs.mkdtemp('/tmp/server-session-electron-');homes.push(home);
 const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/server-session-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_VAULT_FIXTURE_KEY:vaultKey,EASTER_API_BASE_URL:api}});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // The window navigates to the app's own origin after it is created, so the preload's bridge is
 // only readable once that document is in place. Every journey waits for this before touching it.
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 process.stdout.write('[journey] '+home+' ready\n');
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const approve=async()=>{await page.locator('.desktop-code').filter({hasText:'SESSION-TEST'}).waitFor();await app.evaluate(()=>global.easterTestApprove());};
 const passwordSignIn=async()=>{
  await hero('signin').click();
  const dialog=page.locator('#desktop-company-signin');
  await dialog.getByLabel('Username or Email',{exact:true}).fill(ACCOUNT.username);
  await dialog.getByLabel('Password',{exact:true}).fill('fixture secret passphrase');
  await dialog.getByRole('button',{name:'Sign in',exact:true}).click();
 };
 const close=async()=>{await app.close();assert.deepEqual(errors,[]);};
 // The vault written for this machine, decrypted the way the launcher decrypts it.
 const vault=async()=>{
  const bytes=await fs.readFile(path.join(home,'accounts.enc'));
  const key=Buffer.from(vaultKey,'hex');
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
 };
 return {app,page,hero,status,approve,passwordSignIn,close,home,vault,errors};
};
const sessionCalls=()=>service.calls.filter(call=>call.path==='/v2/game/session');
try{
 // ---- A: a password sign-in whose account stores its Microsoft session ---------------
 process.stdout.write('[journey] scenario  A\n');
 service.mint='ok';
 // The account service is slow for this sign-in on purpose: the password sign-in must settle
 // and apply the account while the mint is still running, because a slow service may never hold
 // a sign-in open or leave its busy state behind on the hero.
 service.mintDelay=2500;
 const a=await launch();
 await a.passwordSignIn();
 await a.page.waitForFunction(async()=>{const state=await window.easterDesktop.status();return Boolean(state.account&&state.account.username);},undefined,{timeout:15000});
 const duringMint=await a.status();
 assert.equal(duringMint.accountWorking,false,'the sign-in settles while the mint is still in flight');
 assert.equal(duringMint.minecraftSession.state,'checking','and the hero says it is asking the account service');
 await a.hero('play').waitFor();
 service.mintDelay=0;
 const signedIn=await a.status();
 assert.equal(signedIn.account.username,ACCOUNT.username);
 assert.equal(signedIn.companyReady,true);
 assert.equal(signedIn.canPlay,true,'Play is available for a password sign-in');
 assert.deepEqual({...signedIn.minecraftSession,checkedAt:null},{state:'server',serverHeld:true,checkedAt:null});
 assert.equal(signedIn.profile?.name,'FixtureCaptain','the hero names the player the service minted a session for');
 assert.equal(signedIn.microsoftConnected,false,'no Microsoft leg of this machine is involved at all');
 const mint=sessionsCallsFirst();
 assert.equal(mint.authorization,'Bearer fixture-company-session-token','the mint is authenticated by the Company session and nothing else');
 // The body carries the launcher's own name and nothing that could name an account; the
 // version is whatever this build is, so the assertion is about the shape, not the number.
 assert.match(mint.body,/^\{"client":"launcher\/\d+\.\d+\.\d+"\}$/);
 // The hero offers Play and asks for no Microsoft sign-in anywhere on the screen.
 assert.equal(await a.page.locator('[data-desktop-play][data-action="connect-microsoft"]').count(),0,'the hero offers no Microsoft sign-in');
 assert.equal(await a.page.locator('[data-desktop-play][data-action="link-microsoft"]').count(),0);
 assert.equal(await a.page.locator('#desktop-signin[open]').count(),0,'and no Microsoft dialog is open');
 const heroCopy=await a.page.locator('.hero-copy').innerText();
 assert(!/Microsoft|Xbox/i.test(heroCopy),'the hero asks for nothing Microsoft: '+heroCopy.replace(/\s+/g,' '));
 await a.page.screenshot({path:'/tmp/server-session-password-hero.png',animations:'disabled'});
 // Pressing Play starts the client with the token the service minted.
 await a.hero('play').click();
 await a.page.locator('[data-desktop-play][data-action="running"]').waitFor();
 const launched=await a.app.evaluate(()=>global.easterSessionLaunch);
 assert.equal(launched.accessToken,'fixture-minted-minecraft-token');
 assert.equal(launched.gameProfile.id,'1234567890abcdef1234567890abcdef');
 assert.equal(launched.gameProfile.name,'FixtureCaptain');
 assert(launched.extraMCArgs.includes('--quickPlayMultiplayer'),'and joins the one server it always joins');
 await a.close();

 // ---- B: the hand-over, proved, and the vault that no longer carries the token --------
 process.stdout.write('[journey] scenario  B\n');
 service.mint='ok';
 const b=await launch();
 await b.passwordSignIn();
 await b.hero('play').waitFor();
 // The Microsoft sign-in that hands the session over. A linked account signing in again keeps
 // the same Easter Company account, which is what a player does on a machine they are already
 // signed in on.
 // The sign-in call settles only when the whole flow does, so it is started and then approved
 // from here — awaiting it first would wait for its own approval.
 const linkSignIn=b.page.evaluate(()=>window.easterDesktop.signIn({link:true}));
 await b.approve();
 await linkSignIn;
 await b.page.locator('[data-desktop-play][data-action="play"]').waitFor();
 const handed=await b.status();
 assert.equal(handed.minecraftSession.state,'local','this machine now holds a Microsoft session of its own');
 assert.equal(handed.minecraftSession.serverHeld,true,'and the service proved it holds one too');
 const handOver=service.calls.filter(call=>call.path==='/v2/accounts/microsoft').pop();
 const handOverBody=JSON.parse(handOver.body);
 assert.equal(handOverBody.microsoftRefreshToken,'fixture-private-refresh-'+UHS,'the refresh token is handed over on the sign-in request');
 assert.equal(Object.keys(handOverBody).filter(key=>/refresh/i.test(key)).length,1,'under one field name, exactly once');
 // The encrypted vault: the token is gone, and what is left is the player's own profile.
 const stored=await b.vault();
 const entry=(stored.accounts||[]).find(item=>item);
 assert(entry,'the Microsoft session is still saved');
 assert(!('refreshToken' in entry),'the vault carries no Microsoft refresh token after a confirmed hand-over');
 assert.equal(entry.serverHeld,true);
 assert.equal(entry.profile.name,'FixtureCaptain');
 assert(!JSON.stringify(stored).includes('fixture-private-refresh'),'and no token text anywhere in the vault payload');
 // The second machine: the same Easter Company account, signing in with its password, is ready
 // to play with no Microsoft prompt of its own.
 await b.page.evaluate(()=>window.easterDesktop.signOut());
 await b.hero('signin').waitFor();
 await b.passwordSignIn();
 await b.hero('play').waitFor();
 const secondMachine=await b.status();
 assert.equal(secondMachine.canPlay,true);
 assert.equal(secondMachine.minecraftSession.state,'server');
 assert.equal(secondMachine.minecraftSession.serverHeld,true);
 assert.equal(await b.page.getByRole('button',{name:'Sign in to Minecraft',exact:true}).count(),0,'and it is asked for no Microsoft sign-in');
 await b.close();

 // ---- C: reauth_required inside a Play press ------------------------------------------
 process.stdout.write('[journey] scenario  C\n');
 service.mint='ok';
 const c=await launch();
 await c.passwordSignIn();
 await c.hero('play').waitFor();
 assert.equal((await c.status()).canPlay,true);
 // The stored session dies between the launcher asking and the player pressing Play.
 service.mint='reauth';
 const before=await c.app.evaluate(()=>global.easterSessionSignIns);
 await c.hero('play').click();
 // One sentence, then the interactive sign-in — and not a loop. The sentence is the dialog's own
 // instruction, in main's words: the player reads why they are being asked while the code is in
 // front of them.
 await c.page.locator('.desktop-code').filter({hasText:'SESSION-TEST'}).waitFor();
 const instruction=(await c.page.locator('.desktop-device-instruction').textContent()).trim();
 assert(instruction.startsWith(REAUTH_SENTENCE),'the sign-in says why: '+instruction);
 assert(instruction.endsWith('Enter this code on Microsoft’s sign-in page.'),'and then what to do: '+instruction);
 assert.equal(await c.app.evaluate(()=>global.easterSessionSignIns),before+1,'the interactive flow is started once');
 // The service holds a live session again by the time the player has signed in.
 service.mint='ok';
 await c.app.evaluate(()=>global.easterTestApprove());
 await c.page.locator('[data-desktop-play][data-action="running"]').waitFor();
 assert.equal(await c.app.evaluate(()=>global.easterSessionSignIns),before+1,'and never twice for one press');
 const surface=await c.page.locator('body').innerText();
 for(const forbidden of ['reauth_required','invalid_grant','401','fixture-private'])assert(!surface.includes(forbidden),forbidden);
 assert(!surface.includes(REAUTH_SENTENCE),'the sentence belonged to the press that failed, not to the game now running');
 await c.close();

 // ---- D: signing Minecraft out everywhere --------------------------------------------
 process.stdout.write('[journey] scenario  D\n');
 service.mint='ok';service.revoke='ok';
 const d=await launch();
 await d.passwordSignIn();
 await d.hero('play').waitFor();
 await d.page.locator('.desktop-account-nav').click();
 await d.page.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 const profile=d.page.locator('#company-profile');
 await profile.waitFor();
 const revoke=profile.getByRole('button',{name:'Sign out of Minecraft everywhere',exact:true});
 await revoke.waitFor();
 const deletesBefore=service.calls.filter(call=>call.path==='/v2/game/session/revoke').length;
 await revoke.click();
 await profile.locator('.company-status').filter({hasText:REVOKED_SENTENCE}).waitFor();
 const deletes=service.calls.filter(call=>call.path==='/v2/game/session/revoke');
 assert.equal(deletes.length,deletesBefore+1,'the revoke is one authenticated POST, not a DELETE');
 assert.equal(deletes.at(-1).method,'POST');
 assert.equal(deletes.at(-1).authorization,'Bearer fixture-company-session-token');
 const revoked=await d.status();
 assert.equal(revoked.minecraftSession.state,'reauth','the next Play needs the interactive flow');
 assert.equal(revoked.minecraftSession.serverHeld,false,'and the launcher no longer claims a stored session');
 assert.equal(revoked.canPlay,false,'Play is not left enabled for a session that was just ended');
 await revoke.waitFor({state:'hidden'});
 // A service with no revoke route is said as it is: nothing was revoked, and nothing is claimed.
 service.revoke='absent';service.mint='ok';
 await profile.locator('.dialog-close').click();
 await d.page.evaluate(()=>window.easterDesktop.signOut());
 await d.hero('signin').waitFor();
 await d.passwordSignIn();
 await d.hero('play').waitFor();
 await d.page.locator('.desktop-account-nav').click();
 await d.page.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 await profile.waitFor();
 await profile.getByRole('button',{name:'Sign out of Minecraft everywhere',exact:true}).click();
 await profile.locator('.company-status').filter({hasText:'The launcher cannot sign Minecraft out on other computers yet.'}).waitFor();
 await d.close();
 console.log('Server-held Microsoft session PASS: password sign-in plays with no Microsoft prompt, the hand-over is proved before the vault drops the refresh token, reauth_required falls back once and launches, and signing out everywhere says only what the service answered.');
}finally{
 await new Promise(resolve=>stub.close(resolve));
 for(const home of homes)await fs.rm(home,{recursive:true,force:true});
}
// The first mint the launcher asked for, which is the one the password sign-in triggered.
function sessionsCallsFirst(){return sessionCalls()[0];}
