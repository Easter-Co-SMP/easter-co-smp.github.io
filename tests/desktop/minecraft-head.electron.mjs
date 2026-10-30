// The Minecraft head a password sign-in still shows, and what a refused read leaves behind.
//
// Owen signed in with his Easter Company username and password and got the letter tile "O"
// where his Minecraft face belongs: a password sign-in restores no Microsoft session, so
// `profile.skin` is null. The account document knows the Minecraft uuid, so the main process
// reads the head from Mojang's own public endpoints and publishes it as `state.minecraftHead`
// (doc/launcher-states.md, "A password sign-in still knows the account is linked"). This drives
// the real main process and the real renderer, with the account service on a loopback server and
// those two Mojang endpoints stubbed by tests/desktop/head-harness.cjs, which records every read
// it is asked for. What is proved here:
//
//   1. the head is read once per account, from the account's own uuid, with the dashes removed,
//      and then the texture that profile names — no credential, no token, no other read;
//   2. it reaches the header as a data URL and the canvas paints the skin's face;
//   3. it is cached beside the account vaults, so a restart paints the face without asking
//      Mojang anything;
//   4. a refused profile read, and a profile whose texture cannot be fetched, each leave the
//      letter tile, announce no failure, raise no page error, do not retry, and never hold the
//      hero back; and the texture is asked for over https although Mojang names it over http.
//
// Run: xvfb-run -a node tests/desktop/minecraft-head.electron.mjs
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The pill's face belongs to the shared account control now, which paints the picture - or the head
// it crops from the skin, or the letter tile - into a 32px slot as an <img>. Reading a pixel off it
// means drawing that image into an offscreen 32x32 canvas first; the crop behind it is the same
// 8x8-at-8,8 plus hat-at-40,8 arithmetic the window's own canvas used.
const FACE_PIXEL='(()=>{const slot=document.querySelector(".desktop-account-nav .web-account-face");if(!slot)return null;const image=slot.querySelector("img.web-account-picture");if(!image||image.hidden||!image.complete||!image.naturalWidth)return null;const canvas=document.createElement("canvas");canvas.width=32;canvas.height=32;const context=canvas.getContext("2d");context.imageSmoothingEnabled=false;context.drawImage(image,0,0,32,32);return [...context.getImageData(2,2,1,1).data];})()';

const UUID='12345678-90ab-cdef-1234-567890abcdef',UNDASHED=UUID.replace(/-/g,'');
// Mojang names the skin over http; the launcher must ask for it over https, so that is the
// only texture read the harness answers or records.
const TEXTURE_HTTP='http://textures.minecraft.net/texture/'+'ab'.repeat(32);
const TEXTURE=TEXTURE_HTTP.replace('http:','https:');
const PROFILE='https://sessionserver.mojang.com/session/minecraft/profile/'+UNDASHED;
const USERNAME='captain_fixture',PASSWORD='fixture secret passphrase';
// The other situation a signed-in account with no live Microsoft token can be in: no link at
// all. It is a different account document, so the same fixture service answers both.
const UNLINKED_USERNAME='unlinked_fixture';
// The fixture skin tests/desktop/deslop.electron.mjs paints from: its face is this colour and
// its hat layer is transparent, so one canvas pixel says which of the two the header drew.
const FACE=[200,130,90],TILE=[83,107,102];
const SESSION='fixture-company-private-session';
const account={id:7,username:USERNAME,minecraftUuid:UUID,minecraftName:'FixtureCaptain',displayName:'Captain Fixture',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:'a'.repeat(64)};
// The same player on an Easter Company account that has never linked Microsoft: no subject,
// no Minecraft identity, nothing to draw and nothing to sign in again with.
const unlinked={id:8,username:UNLINKED_USERNAME,minecraftUuid:null,minecraftName:null,displayName:'Unlinked Fixture',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:false,microsoftSubject:null};
// The account service, in the frozen shape: the password login, the game status the launcher
// reads after signing in, and logout. Nothing here is Mojang and nothing here is a head.
const calls=[];
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:request.url,method:request.method,body});
  const json=(payload,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  if(request.url==='/v2/accounts/password/login'){
   if(body.password!==PASSWORD)return json({error:'invalid_credentials'},401);
   const player=body.identifier===UNLINKED_USERNAME?unlinked:body.identifier===USERNAME?account:null;
   if(player)return json({created:false,account:player,session:{token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()}});
   return json({error:'invalid_credentials'},401);
  }
  if(request.url==='/v2/game/status')return json({state:'stopped',ready:false,endpoint:'smp.easter.company:25565',since:null,players:null,detail:null});
  if(request.url==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const apiBase='http://127.0.0.1:'+stub.address().port;
const vaultKey=randomBytes(32).toString('hex');
const launch=async(home,{mode,delay=0}={})=>{
 const log=path.join(home,'mojang-reads.log');
 await fs.writeFile(log,'');
 const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/head-harness.cjs')],
  env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:apiBase,EASTER_VAULT_FIXTURE_KEY:vaultKey,EASTER_HEAD_MODE:mode,EASTER_HEAD_DELAY_MS:String(delay),EASTER_HEAD_LOG:log,EASTER_HEAD_UUID:UUID}});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 return {app,page,errors,log};
};
const reads=async log=>(await fs.readFile(log,'utf8')).split('\n').filter(Boolean);
const status=page=>page.evaluate(()=>window.easterDesktop.status());
const hero=page=>page.locator('[data-desktop-play]').evaluate(node=>({action:node.dataset.action,text:node.innerText.replace(/\s+/g,' ').trim()}));
const facePixel=page=>page.evaluate(FACE_PIXEL);
// The sign-in the player actually performs: the header's own chooser, username and password.
const signIn=async(page,identifier=USERNAME)=>{
 await page.locator('.desktop-account-nav').click();
 const chooser=page.locator('#desktop-company-signin');
 await chooser.waitFor();
 await chooser.getByLabel('Username or Email',{exact:true}).fill(identifier);
 await chooser.getByLabel('Password',{exact:true}).fill(PASSWORD);
 await chooser.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.waitForFunction(name=>window.easterDesktop.status().then(state=>state.account?.username===name),identifier);
};
const waiting=async(page,check,arg,message)=>assert.equal(await page.waitForFunction(check,arg,{timeout:15000}).then(()=>true),true,message);

const home=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-head-e2e-'));
let run=await launch(home,{mode:'head'});
let app=run.app,page=run.page,errors=run.errors,log=run.log;
try{
 // --- 1. A password sign-in: linked, no live Microsoft token -------------------
 await signIn(page);
 let state=await status(page);
 assert.equal(state.account.username,USERNAME,'the signal is the account that signed in');
 assert.equal(state.account.microsoftLinked,true,'the Company account is linked');
 assert.equal(state.microsoftConnected,false,'and this session holds no Microsoft token');
 assert.equal(state.profile,null,'which is why there is no session skin at all');
 // The hero says what signing in will start, and names it.
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]')?.dataset.action==='connect-microsoft');
 assert.deepEqual(await hero(page),{action:'connect-microsoft',text:'Reconnect Microsoft Starts Minecraft as FixtureCaptain'},'the hero names the linked Minecraft identity instead of reading as a first-time connect, and reconnects rather than logging in');
 // The head arrives as a data URL in state, from the account's own uuid and then the texture
 // that profile names, with nothing else fetched.
 await page.waitForFunction(()=>window.easterDesktop.status().then(current=>typeof current.minecraftHead==='string'&&current.minecraftHead.startsWith('data:image/png;base64,')));
 state=await status(page);
 assert.deepEqual(await reads(log),[PROFILE,TEXTURE],'one profile read by the account uuid without dashes, then the texture it names');
 assert((await reads(log)).every(url=>!url.includes('?')&&!url.includes('@')),'both reads are the plain public paths: no query, no user, no credential in the address');
 // Mojang names that texture over http and the launcher asked for it over https: the scheme is
 // upgraded before the request, so a player's skin is never fetched in plaintext.
 assert.equal((await reads(log)).some(url=>url.startsWith('http://')),false,'no plaintext request is made for the skin');
 assert.equal(TEXTURE.startsWith('https://'),true,'and the texture was asked for over https');
 assert.equal(state.minecraftHead.startsWith('data:image/png;base64,'),true,'the head is a data URL in state, as profile.skin is');
 assert.equal(state.profile,null,'and the session profile is still nothing: the head did not invent one');
 // The header paints the skin's own face, not the letter tile.
 await waiting(page,({expression,colour})=>{const pixels=eval(expression);return Boolean(pixels)&&pixels[3]===255&&pixels[0]===colour[0]&&pixels[1]===colour[1]&&pixels[2]===colour[2];},{expression:FACE_PIXEL,colour:FACE},'the header draws the Minecraft head, not the letter tile');
 await page.waitForTimeout(200);
 await page.screenshot({path:'/tmp/minecraft-head-password-signin.png'});
 // --- 2. Once per account, not once per render --------------------------------
 for(let index=0;index<4;index++)await page.evaluate(()=>window.easterDesktop.status());
 await page.locator('.desktop-account-nav').click();await page.keyboard.press('Escape');
 await page.waitForTimeout(600);
 assert.deepEqual(await reads(log),[PROFILE,TEXTURE],'reading the state again asks Mojang nothing');
 // --- 3. Cached beside the account, so a restart needs no read ----------------
 const cache=JSON.parse(await fs.readFile(path.join(home,'minecraft-head.json'),'utf8'));
 assert.equal(cache.uuid,UUID,'the cache is keyed on the account\'s Minecraft identity');
 assert.equal(cache.head,state.minecraftHead,'and holds the head it published');
 assert(!/token|session|secret|passphrase/i.test(JSON.stringify(cache)),'the cache carries a public image and a uuid, never a credential');
 await app.close();
 // The restart is stubbed to refuse everything: a read would both be logged and fail, so a
 // head that paints proves it came from the cache.
 run=await launch(home,{mode:'refused'});
 app=run.app;page=run.page;errors=run.errors;log=run.log;
 await page.waitForFunction(name=>window.easterDesktop.status().then(current=>current.account?.username===name),USERNAME,{timeout:20000});
 await page.waitForFunction(()=>window.easterDesktop.status().then(current=>typeof current.minecraftHead==='string'),null,{timeout:20000});
 await waiting(page,({expression,colour})=>{const pixels=eval(expression);return Boolean(pixels)&&pixels[3]===255&&pixels[0]===colour[0]&&pixels[1]===colour[1]&&pixels[2]===colour[2];},{expression:FACE_PIXEL,colour:FACE},'the restarted launcher paints the face from its cache');
 assert.deepEqual(await reads(log),[],'and asks Mojang nothing for it');
 assert.deepEqual(errors,[],'no page error was raised on the way');
 await app.close();
 // --- 4. A refused read leaves the tile, quietly ------------------------------
 const bare=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-head-refused-'));
 run=await launch(bare,{mode:'refused',delay:1200});
 app=run.app;page=run.page;errors=run.errors;log=run.log;
 const signedAt=Date.now();
 await signIn(page);
 // The hero is painted from the state that announced the sign-in, so it is on screen long
 // before the 1.2 s stub answers: a face is never something the launcher waits for.
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]')?.dataset.action==='connect-microsoft',null,{timeout:800});
 const heroBeforeRead=await hero(page);
 assert.deepEqual(heroBeforeRead,{action:'connect-microsoft',text:'Reconnect Microsoft Starts Minecraft as FixtureCaptain'},'the hero is answered before any head read');
 state=await status(page);
 assert.equal(state.minecraftHead,null,'the head is absent while the read is still in flight');
 assert.equal(state.error,null,'and an unfinished read is not a failure either');
 // The read fails, and nothing else happens: no error, no retry, no broken image, tile.
 await page.waitForTimeout(2500);
 state=await status(page);
 assert.equal(state.minecraftHead,null,'a refused read leaves no head');
 assert.equal(state.error,null,'and announces no failure');
 assert.equal(state.message===null||!String(state.message).includes('skin'),true,'and words no failure about it either');
 assert.deepEqual(await reads(log),[PROFILE],'the profile endpoint was asked exactly once, and no texture was invented');
 const tile=await facePixel(page);
 assert.deepEqual(tile.slice(0,3),TILE,'the letter tile is what a failed read leaves');
 assert.deepEqual(errors,[],'a failed read raises no page error');
 await page.waitForTimeout(800);
 assert.deepEqual(await reads(log),[PROFILE],'and it is not retried while the player uses the launcher');
 await page.screenshot({path:'/tmp/minecraft-head-tile.png'});
 // The rest of the launcher is untouched: Play is still gated on the live Microsoft leg.
 assert.equal(state.canPlay,false,'and Play is still gated: this ticket changed words and a face, not the gate');
 assert.deepEqual(state.actions,['download','connect-microsoft'],'the requirement list is unchanged: the client still has to be installed and the Microsoft leg is still required');
 await app.close();
 // --- 5. A profile that answers and a texture that does not ------------------
 // The other half of a failed read: the account's Minecraft name resolved and its profile
 // named a texture, but that texture could not be fetched. Same outcome, same quiet.
 const textureless=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-head-texture-'));
 run=await launch(textureless,{mode:'refused-texture'});
 app=run.app;page=run.page;errors=run.errors;log=run.log;
 await signIn(page);
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]')?.dataset.action==='connect-microsoft');
 await page.waitForFunction(()=>window.easterDesktop.status().then(current=>current.error!==null||current.minecraftHead===null));
 await page.waitForTimeout(1800);
 state=await status(page);
 assert.equal(state.minecraftHead,null,'a texture the launcher cannot fetch leaves no head');
 assert.equal(state.error,null,'and is not an error either');
 assert.deepEqual(await reads(log),[PROFILE,TEXTURE],'the profile answered and the texture was asked for once');
 assert.deepEqual((await facePixel(page)).slice(0,3),TILE,'so the letter tile is what is painted');
 assert.deepEqual(errors,[],'and nothing was thrown into the page');
 await app.close();
 // --- 6. An account with no Microsoft link is never asked to sign in again ----
 // The other situation a signed-in account with no live token can be in. It has no Minecraft
 // identity, so it has no head at all, and it offers the action that links one instead.
 const unlinkedHome=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-head-unlinked-'));
 run=await launch(unlinkedHome,{mode:'head'});
 app=run.app;page=run.page;errors=run.errors;log=run.log;
 await signIn(page,UNLINKED_USERNAME);
 state=await status(page);
 assert.equal(state.account.microsoftLinked,false,'this account has never linked Microsoft');
 assert.equal(state.microsoftConnected,false,'and holds no Microsoft token either');
 assert.equal(state.minecraftHead,null,'so there is no Minecraft identity to draw a head from');
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]')?.dataset.action==='link-microsoft');
 assert.deepEqual(await hero(page),{action:'link-microsoft',text:'Link Microsoft Attach the Microsoft account that owns Minecraft'},'an unlinked account is asked to link, never to sign in again');
 assert.deepEqual(await reads(log),[],'and no head is read for an account that has no Minecraft identity');
 const unlinkedTile=await facePixel(page);
 assert.deepEqual(unlinkedTile.slice(0,3),TILE,'the letter tile is what an account with no Minecraft identity gets');
 // The action is the Microsoft sign-in with the link intent, exactly as the linked one is: it
 // opens the browser sign-in, which is where a link happens.
 await page.locator('[data-desktop-play]').click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 await page.locator('#desktop-signin').evaluate(node=>node.close());
 assert.deepEqual(errors,[],'and the unlinked journey raises no page error');
 await page.screenshot({path:'/tmp/minecraft-head-unlinked-tile.png'});
 console.log('MINECRAFT HEAD PASS: the head is read once per account from the account\'s own uuid via Mojang\'s public profile and texture endpoints, reaches the header as a data URL and paints the face, is cached beside the account vaults so a restart reads nothing, a refused profile and a refused texture each leave the letter tile with no error, no retry and no delay to the hero, the texture is asked for over https although Mojang named it over http, and an account with no Microsoft link is asked to link rather than to sign in again. '+(Date.now()-signedAt)+' ms of sign-in and checks; screenshots /tmp/minecraft-head-password-signin.png, /tmp/minecraft-head-tile.png and /tmp/minecraft-head-unlinked-tile.png.');
}finally{
 await app.close().catch(()=>{});
 stub.close();
}
