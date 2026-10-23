// The last known Minecraft-session answer, through the real main process (ticket 19e51885,
// doc/launcher-states.md "The last known answer, shown while it is confirmed").
//
// Owen, at first launch: "When I first open the launcher I see 'Checking your minecraft
// session...' but I think we should do client side caching for this - until the check passes,
// we assume based on the cache." The shape he asked for: render the last known answer at once,
// confirm it in the background, and correct it honestly if the answer disagrees — and never
// become a launcher that shows Play because a file said so.
//
//   A. a first launch signs in and writes the file: its whitelist and its shape are read off
//      the disk, and no credential this launcher holds is anywhere in it.
//   B. a second launch of the same install HOLDS THE MINT ON A PROMISE (never a stopwatch) and
//      renders the cached PLAY NOW with the note under it while `canPlay` is still false; the
//      mint is then released with a contradicting `reauth_required` and the hero is Reconnect
//      Microsoft the moment that answer lands, with the note gone.
//   C. the age of the answer is its own moment: two hours old reads "Last checked 2 hours ago".
//   D. a file written longer ago than the bound is ignored, deleted, and leaves today's
//      "Checking your Minecraft session…" screen.
//   E. a corrupt file is deleted and ignored — never a crash, never a blocked startup.
//   F. a file written for another account is ignored and deleted.
//
// The account service is a real loopback HTTP stub; the Microsoft legs and the game process are
// the harness's fixtures (tests/desktop/server-session-harness.cjs). Nothing reaches the live API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import sessionCache from '../../desktop/session-cache.cjs';
const UHS='fixture-uhs-0123456789abcdef0123456789abcdef';
const ACCOUNT={id:7,username:'captainfixture',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'FixtureCaptain',displayName:'Captain Fixture',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:createHash('sha256').update('xbox-uhs:'+UHS).digest('hex')};
// The one new sentence this feature adds, and the two pieces of it the journey can assert.
const NOTE_TENSE=' · confirming now';
const WAITING='Checking your Minecraft session…';
// The stub's own switches. `hold` keeps the mint's response open on a promise the journey
// releases by hand, which is the only clock this journey uses.
const service={hold:false,answer:'ok',pending:null,mints:[],calls:[]};
const mintedBody=()=>({accessToken:'fixture-minted-minecraft-token',expiresAt:new Date(Date.now()+86400000).toISOString(),profile:{uuid:'12345678-90ab-cdef-1234-567890abcdef',name:'FixtureCaptain'}});
const sessionBody=()=>({created:false,account:ACCOUNT,session:{token:'fixture-company-session-token',expiresAt:new Date(Date.now()+86400000).toISOString()}});
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',async()=>{
  const body=Buffer.concat(chunks).toString('utf8');
  service.calls.push({method:request.method,path:request.url,body});
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
   service.mints.push({at:new Date().toISOString()});
   if(service.hold)await new Promise(resolve=>{service.pending=resolve;});
   if(service.answer==='reauth')return json(401,{error:'reauth_required'});
   return json(200,mintedBody());
  }
  if(route==='POST /v2/game/session/revoke')return json(200,{revoked:true});
  if(route==='GET /v2/game/status'||route==='POST /v2/game/wake')return json(200,{state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-19T00:00:00Z',players:0,detail:''});
  response.writeHead(404,{'Content-Type':'text/html'});response.end('Not Found');
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const api='http://127.0.0.1:'+stub.address().port;
const vaultKey=randomBytes(32).toString('hex');
const home=await fs.mkdtemp('/tmp/session-cache-electron-');
const cacheFile=path.join(home,'session-cache.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The launcher's own answer is held on a promise: the journey waits for the request to arrive
// and then releases it with the answer it wants to test. No stopwatch decides anything.
const waitForMint=async()=>{
 for(let attempt=0;attempt<600;attempt++){
  if(service.pending)return;
  await sleep(25);
 }
 throw Error('the launcher never asked the account service for a session');
};
const release=async answer=>{
 if(answer)service.answer=answer;
 await waitForMint();
 const pending=service.pending;service.pending=null;
 pending();
};
const launch=async()=>{
 const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/server-session-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_VAULT_FIXTURE_KEY:vaultKey,EASTER_API_BASE_URL:api}});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 // Every broadcast main sends from here on, recorded in the main process itself, so the order
 // of what the window was told is evidence rather than an inference.
 await app.evaluate(({BrowserWindow})=>{
  const win=BrowserWindow.getAllWindows()[0];
  global.__states=[];
  const send=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>{if(channel==='launcher:state')global.__states.push(JSON.parse(JSON.stringify(args[0])));return send(channel,...args);};
 });
 return {app,page,errors};
};
const seen=app=>app.evaluate(()=>global.__states);
const heroOf=page=>page.locator('[data-desktop-play]').evaluate(node=>({action:node.dataset.action,text:node.innerText.replace(/\s+/g,' ').trim()}));
const waitHero=async(page,kind)=>{await page.locator('[data-desktop-play][data-action="'+kind+'"]').waitFor();return heroOf(page);};
const statusOf=page=>page.evaluate(()=>window.easterDesktop.status());
const writeCache=async patch=>{
 const stored=JSON.parse(await fs.readFile(cacheFile,'utf8'));
 await fs.writeFile(cacheFile,JSON.stringify({...stored,...patch},null,2));
};
const cacheExists=async()=>{try{await fs.stat(cacheFile);return true;}catch{return false;}};
try{
 // ---- A: the file a real launch writes ------------------------------------------------
 process.stdout.write('[journey] scenario  A — a sign-in writes the file\n');
 service.hold=false;
 {
  const run=await launch();
  await run.page.locator('[data-desktop-play][data-action="signin"]').click();
  const dialog=run.page.locator('#desktop-company-signin');
  await dialog.getByLabel('Username or Email',{exact:true}).fill(ACCOUNT.username);
  await dialog.getByLabel('Password',{exact:true}).fill('fixture secret passphrase');
  await dialog.getByRole('button',{name:'Sign in',exact:true}).click();
  const hero=await waitHero(run.page,'play');
  assert(!hero.text.includes('confirming'),'a fresh sign-in draws today\'s Play, with no cached note: '+hero.text);
  // The file appears after the answer that it describes, and it is this build's own name for it.
  let stored=null;
  for(let attempt=0;attempt<200&&!stored;attempt++){
   try{stored=JSON.parse(await fs.readFile(cacheFile,'utf8'));}catch{await sleep(25);}
  }
  assert(stored,'the last known answer is written beside the settings as session-cache.json');
  assert.deepEqual(Object.keys(stored),[...sessionCache.FIELDS],'the file holds the whitelist and nothing else: '+Object.keys(stored).join(', '));
  assert.deepEqual(Object.keys(stored.account),[...sessionCache.ACCOUNT_FIELDS],'the account block is its own list');
  assert.deepEqual(Object.keys(stored.minecraftSession),[...sessionCache.SESSION_FIELDS],'and the session block is its own');
  assert.deepEqual(Object.keys(stored.install),[...sessionCache.INSTALL_FIELDS]);
  assert.equal(stored.version,sessionCache.VERSION);
  assert(Number.isFinite(Date.parse(stored.writtenAt)),'it carries the moment it was written');
  assert.deepEqual({state:stored.minecraftSession.state,serverHeld:stored.minecraftSession.serverHeld},{state:'server',serverHeld:true},'and the answer the launcher had just received');
  // The account id is the one `mintMinecraftSession` compares a minted session against — the
  // account's own primary key — and the name is the Java identity the service named.
  assert.equal(String(stored.account.id),String(ACCOUNT.id),'under the account it belongs to');
  assert.equal(stored.account.minecraftName,ACCOUNT.minecraftName,'and the Minecraft identity the account service named');
  // Nothing this launcher holds may be in there. The values are the fixture's own, so finding
  // one would be finding it in the file.
  const text=await fs.readFile(cacheFile,'utf8');
  for(const forbidden of ['fixture-company-session-token','fixture-minted-minecraft-token','fixture-private-refresh','fixture-private-microsoft','fixture-private-minecraft','fixture-xbox','fixture-uhs',UHS,'smp.easter.company','25565',ACCOUNT.microsoftSubject,'fixture private']){
   assert(!text.includes(forbidden),'the file must never contain '+forbidden);
  }
  assert(!/"(refreshToken|accessToken|token|xstsToken|sessionKey|password|server|steamId64|microsoftSubject)"\s*:/.test(text),'and never a key for one either: '+text);
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] A: '+Object.keys(stored).length+' top-level fields, no credential\n');
 }

 // ---- B: cold start, held mint, cached first and corrected ---------------------------
 process.stdout.write('[journey] scenario  B — the cached answer, then the truth\n');
 service.hold=true;service.answer='ok';
 {
  const run=await launch();
  const stored=JSON.parse(await fs.readFile(cacheFile,'utf8'));
  const cached=await statusOf(run.page);
  assert.equal(cached.sessionCached,true,'the launcher says it is drawing a cached answer, so no view has to infer it');
  assert.equal(cached.minecraftSession.state,'server','with the word it last knew');
  assert(Number.isFinite(Date.parse(cached.minecraftSession.cachedAt||'')),'and the moment that answer was written');
  assert.equal(cached.minecraftSession.cachedAt,stored.writtenAt,'the moment the hero draws is the file\'s own, so the answer it draws came from the file and not from the service — which has not answered');
  assert.equal(service.pending!==null,true,'and the account service provably has not answered: its request is still open');
  assert.equal(cached.canPlay,false,'the cache authorises nothing: the Play gate in main has not moved');
  assert.equal(cached.actions.includes('connect-microsoft'),true,'and the live requirement is still what main publishes');
  const hero=await waitHero(run.page,'play');
  const note=hero.text.replace(/^PLAY NOW /,'');
  assert.match(note,/^Last checked (just now|[0-9]+ minutes? ago|1 hour ago|[0-9]+ hours ago) · confirming now$/,'the note says what it last knew and that it is confirming it: '+hero.text);
  // Now the answer lands, and it disagrees: the service says the stored session is dead.
  await release('reauth');
  const corrected=await waitHero(run.page,'connect-microsoft');
  assert.deepEqual({action:corrected.action,text:corrected.text},{action:'connect-microsoft',text:'Reconnect Microsoft Starts Minecraft as FixtureCaptain'},'the hero is Reconnect Microsoft the moment the truth lands, in today\'s own words: '+corrected.text);
  assert(!/confirming|Last checked/.test(corrected.text),'and no part of the cached note survives it');
  const settled=await statusOf(run.page);
  assert.equal(settled.sessionCached,false,'the flag clears');
  assert.equal(Object.hasOwn(settled.minecraftSession,'cachedAt'),false,'and the moment goes with it, so the settled field is character for character today\'s');
  assert.deepEqual({...settled.minecraftSession,checkedAt:null},{state:'reauth',serverHeld:false,checkedAt:null},'the settled session field is exactly the one main publishes today');
  // The broadcasts main really sent, read in the main process: the correction is one of them,
  // and nothing after the truth landed repainted the cached answer.
  const after=await seen(run.app);
  const flipped=after.findIndex(state=>state.sessionCached===false&&state.minecraftSession&&state.minecraftSession.state==='reauth');
  assert(flipped>=0,'the corrected state was broadcast, not only readable through status()');
  assert(after.slice(flipped).every(state=>state.sessionCached===false),'and nothing repainted the cached answer afterwards');
  assert(!after.some(state=>state.sessionCached===true&&state.minecraftSession&&state.minecraftSession.state!=='server'),'no cached broadcast ever wore a live word');
  assert(!after.some(state=>state.sessionCached===true&&state.canPlay===true),'and no cached broadcast ever said Play was allowed');
  // The file still holds the answer it was written with: a contradiction is written only when
  // the launcher has settled an answer of its own in this run, which this launch has.
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] B: PLAY NOW from the cache ('+note+') → Reconnect Microsoft, no cached fact launched anything\n');
 }

 // ---- C: the age is the file's own moment --------------------------------------------
 process.stdout.write('[journey] scenario  C — an answer two hours old\n');
 service.hold=true;service.answer='ok';
 {
  await writeCache({writtenAt:new Date(Date.now()-2*60*60*1000).toISOString(),minecraftSession:{state:'server',serverHeld:true,checkedAt:new Date(Date.now()-2*60*60*1000).toISOString()}});
  const run=await launch();
  const hero=await waitHero(run.page,'play');
  assert.equal(hero.text,'PLAY NOW Last checked 2 hours ago · confirming now','the note names its own age, in the sentence Owen was given: '+hero.text);
  const cached=await statusOf(run.page);
  assert.equal(cached.sessionCached,true);
  assert.equal(cached.canPlay,false,'and it still authorises nothing');
  await release('ok');
  await waitHero(run.page,'play');
  const settled=await statusOf(run.page);
  assert.equal(settled.sessionCached,false,'the confirmed answer clears the flag');
  assert.equal(settled.canPlay,true,'and now main itself says Play');
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] C: "Last checked 2 hours ago · confirming now", then today\'s Play\n');
 }

 // ---- D: past the bound, the cache is not used at all --------------------------------
 process.stdout.write('[journey] scenario  D — older than the bound\n');
 service.hold=true;service.answer='ok';
 {
  await writeCache({writtenAt:new Date(Date.now()-(sessionCache.MAX_AGE_MS+60000)).toISOString()});
  const run=await launch();
  const waiting=await waitHero(run.page,'busy');
  assert(waiting.text.startsWith(WAITING),'a fortnight-old launcher gets today\'s waiting screen, word for word: '+waiting.text);
  const state=await statusOf(run.page);
  assert.equal(state.sessionCached,false,'and no cached answer is claimed');
  assert.equal(await cacheExists(),false,'the file past its bound is deleted, so it cannot be considered twice');
  await release('ok');
  await waitHero(run.page,'play');
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] D: the bound is enforced, the file is deleted, today\'s words\n');
 }

 // ---- E: a corrupt file is deleted and ignored ---------------------------------------
 process.stdout.write('[journey] scenario  E — a corrupt file\n');
 service.hold=true;service.answer='ok';
 {
  await fs.writeFile(cacheFile,'{"version":1, "account": {"id": "EC-7", "displayName": "Captain Fixture", "username": "captainfixture", "minecraftName": "FixtureCaptain", "minecraftUuid": "12345678-90ab-cdef-1234-567890abcdef", "providers": ["microsoft"], "microsoftLinked": tru');
  const run=await launch();
  const waiting=await waitHero(run.page,'busy');
  assert(waiting.text.startsWith(WAITING),'a corrupt file leaves today\'s first screen rather than a guess: '+waiting.text);
  assert.equal((await statusOf(run.page)).sessionCached,false);
  assert.equal(await cacheExists(),false,'and it is deleted rather than left to fail again on the next start');
  assert.deepEqual(run.errors,[],'the launcher raised no page error while reading it');
  await release('ok');
  await waitHero(run.page,'play');
  const rebuilt=JSON.parse(await fs.readFile(cacheFile,'utf8'));
  assert.equal(rebuilt.version,sessionCache.VERSION,'and the answer this run received is written back over it');
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] E: deleted, ignored, no crash, and rewritten from the real answer\n');
 }

 // ---- F: another account's answer is another account's -------------------------------
 process.stdout.write('[journey] scenario  F — a file written for another account\n');
 service.hold=true;service.answer='ok';
 {
  await writeCache({account:{...JSON.parse(await fs.readFile(cacheFile,'utf8')).account,id:'EC-999'}});
  const run=await launch();
  const waiting=await waitHero(run.page,'busy');
  assert(waiting.text.startsWith(WAITING),'a cached account id that is not the live one is never shown: '+waiting.text);
  assert.equal((await statusOf(run.page)).sessionCached,false);
  assert.equal(await cacheExists(),false,'and it is discarded');
  await release('ok');
  await waitHero(run.page,'play');
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] F: discarded and deleted, today\'s words\n');
 }
 // ---- G: signing out takes the answer with it ----------------------------------------
 process.stdout.write('[journey] scenario  G — signing out\n');
 service.hold=false;service.answer='ok';
 {
  const run=await launch();
  await waitHero(run.page,'play');
  // The answer is written (the launcher has just confirmed it), and signing out ends it: the
  // file belongs to the account that has gone and may not be left for whoever signs in next.
  let stored=false;
  for(let attempt=0;attempt<200&&!stored;attempt++){
   try{stored=(await fs.stat(cacheFile)).isFile();}catch{await sleep(25);}
  }
  assert(stored,'the confirmed answer is on disk before the sign-out');
  await run.page.evaluate(()=>window.easterDesktop.signOut());
  await waitHero(run.page,'signin');
  let left=true;
  for(let attempt=0;attempt<200&&left;attempt++){
   left=await cacheExists();
   if(left)await sleep(25);
  }
  assert.equal(left,false,'signing out deletes the last known answer');
  assert.equal((await statusOf(run.page)).sessionCached,false);
  await run.app.close();
  assert.deepEqual(run.errors,[]);
  process.stdout.write('[journey] G: sign-out deletes the file\n');
 }
 console.log('SESSION CACHE PASS: a sign-in writes a whitelisted, versioned, atomically written last-known answer beside the settings with no credential of any kind in it (its keys are the four named lists and no token, refresh token, session key, server address or SteamID64 is in the text); a cold start with that file holds the mint open on a promise, draws the cached PLAY NOW with "Last checked … · confirming now" under it while main\'s canPlay is still false, and is Reconnect Microsoft in today\'s own words the moment a contradicting reauth_required lands, with the flag cleared, cachedAt gone and the settled session field exactly the one it publishes today; the note names the age of its own moment ("Last checked 2 hours ago · confirming now"); a file older than the 24-hour bound, a corrupt file and a file written for another account are each deleted and ignored, leaving today\'s "Checking your Minecraft session…" screen and no error; signing out deletes it; and after the real answer an ignored cache is rewritten from it.');
}finally{
 await new Promise(resolve=>stub.close(resolve));
 await fs.rm(home,{recursive:true,force:true});
}
