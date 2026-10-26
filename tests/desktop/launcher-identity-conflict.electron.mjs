// The identity conflict, in the real launcher: real preload, real isolated world, real main
// process, and an account service on loopback that speaks the frozen account contract.
//
// Why this file exists: the browser suite drives a stub bridge, which hands the renderer a
// thrown Error that still carries `.code` — a shape the real preload cannot produce, because
// an Error crossing the contextBridge arrives as name + message only. That is how a silent
// account switch once shipped green: `continueMicrosoft` threw, the code was lost, the
// identity-conflict stop could not fire, and the fall-through sign-in replaced the player's
// Easter Company account with the other one. Measured on 5b9c260 (review): captain1 ->
// captain2 with no sentence, no stop and no warning.
//
// What is asserted here:
//   * the refusal code survives the boundary by design — continue-microsoft answers with the
//     {ok, value|error, code} result the account actions already use;
//   * after a conflict the chooser comes back carrying the account service's own sentence
//     plus what the player needs (nothing changed, and where accounts are switched), no
//     Microsoft sign-in dialog opens, no second interactive sign-in is asked for, and the signed-in
//     account id is unchanged;
//   * the page notice never paints the failure on that path — not even for one frame;
//   * every other failure of the saved session still falls through to the interactive
//     sign-in, so the shortcut stays a shortcut rather than a dead end.
//
// Run: xvfb-run -a node tests/desktop/launcher-identity-conflict.electron.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const MICROSOFT_ID='1234567890abcdef1234567890abcdef';
const SUBJECT=createHash('sha256').update(MICROSOFT_ID).digest('hex');
const EMAIL='conflict@example.test';
const SESSION='fixture-company-private-session';
const EXPIRES=new Date(Date.now()+86400000).toISOString();
const USERNAME='conflict_captain';
const SECRET='conflict fixture passphrase';
// The two sentences the player must read, and where they come from. The first is the account
// service's own wording (desktop/accounts.cjs MESSAGES.identity_conflict); the second is what
// that sentence leaves unsaid: nothing on the account changed, and switching accounts is
// something the profile can do. Neither names an account, a Company ID or an address.
const SERVICE_SENTENCE='That provider belongs to a different Easter Company account, or this account already has a different link. Sign out to use another account.';
const NOTHING_CHANGED='Nothing on your Easter Company account has changed.';
const CLOSE_FIRST='Close this window first. Sign out from your profile before signing in to a different account.';
// Three lines, not one paragraph: the sentence, what did not change, and the way out.
const DIALOG_SENTENCE=[SERVICE_SENTENCE,NOTHING_CHANGED,CLOSE_FIRST];
const calls=[];
// The account service, as this journey needs it. One Easter Company account exists; the
// Microsoft identity it is linked to is this launcher's saved session. `mode` is what the
// service answers about that Microsoft identity, flipped between clicks:
//   'linked'        — the ordinary answer: the same account comes back;
//   'conflict-id'   — the service names a DIFFERENT account for this Microsoft identity, which
//                     is the id comparison main.cjs makes before it replaces any identity;
//   'conflict-409'  — the deployed service's own refusal for the same case, a 409 carrying
//                     error 'identity_conflict';
//   'provider-down' — an unrelated failure, so the saved-session shortcut still falls through.
let mode='linked';
const account={id:7,username:null,minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:true,microsoftLinked:true,microsoftSubject:SUBJECT};
// The account this launcher is signed in to. In 'conflict-id' mode the service answers with a
// different, already-complete Easter Company account for the same Microsoft identity, which is
// the case that must stop: on 5b9c260 the fall-through sign-in enrolled it silently.
const documentAccount=()=>mode==='conflict-id'
 ?{...account,id:account.id+1,username:'other_captain',passwordRequired:false,email:EMAIL}
 :{...account,email:EMAIL};
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:request.url,method:request.method,authorization:request.headers.authorization,body});
  const json=(payload,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  const error=(status,code)=>json({error:code,detail:'server detail that must never surface'},status);
  const signed=created=>json({created,account:documentAccount(),session:{token:SESSION,expiresAt:EXPIRES}});
  if(request.url==='/v2/accounts/microsoft'){
   // The deployed service refuses with its own code when the Microsoft identity it validated
   // belongs to a different Company account than the session this request carried. The
   // launcher's copy of the wording is what the player reads; the body never surfaces.
   if(mode==='conflict-409'&&request.headers.authorization)return error(409,'identity_conflict');
   if(mode==='provider-down'&&request.headers.authorization)return error(503,'identity_provider_unavailable');
   return signed(true);
  }
  if(request.url==='/v2/accounts/username/available')return json({available:true,reason:null,email:EMAIL});
  if(request.url==='/v2/accounts/password'){
   // The username is claimed together with the first password, exactly as the frozen
   // contract's combined call does it.
   if(body.username)account.username=body.username;
   account.passwordRequired=false;
   return json({created:true,account:documentAccount(),session:{token:SESSION,expiresAt:EXPIRES}});
  }
  if(request.url==='/v2/accounts/emails'&&request.method==='GET')return json({emails:[{email:EMAIL,provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:true}],loginEmail:EMAIL});
  if(request.url==='/v2/accounts/me')return json({account:documentAccount()});
  if(request.url==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'launcher-identity-conflict-'));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/identity-conflict-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:'+stub.address().port}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.keyboard.press('Escape');await page.setViewportSize({width:800,height:600});
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const signIns=()=>app.evaluate(()=>global.identityConflictSignIns);
 const microsoftCalls=()=>calls.filter(call=>call.path==='/v2/accounts/microsoft');
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 const heroAction=()=>page.locator('[data-desktop-play]').evaluate(node=>node.dataset.action);
 const chooser=page.locator('#desktop-company-signin');
 const signInDialog=page.locator('#desktop-signin').waitFor({state:'visible'});
 // Every state the renderer is handed, and every time a sentence reaches a visible notice:
 // a failure painted for one frame and then cleared is still recorded here, which is the
 // only way to prove the flash is gone rather than merely short.
 const watch=async()=>{
  await page.evaluate(()=>{
   window.__conflictStates=[];window.__conflictPaints=[];
   if(window.__conflictWatcher)return;
   window.easterDesktop.onState(state=>window.__conflictStates.push({error:state.error??null,message:state.message??null}));
   const record=()=>{
    for(const selector of ['.desktop-page-notice','.desktop-auth-error']){
     const node=document.querySelector(selector);
     if(!node||node.hidden||!node.getClientRects().length||!node.textContent.trim())continue;
     const text=node.textContent.replace(/×/g,'').trim();
     if(window.__conflictPaints.some(entry=>entry.text===text&&entry.selector===selector))continue;
     window.__conflictPaints.push({selector,text});
    }
   };
   window.__conflictWatcher=new MutationObserver(record);
   window.__conflictWatcher.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class']});
  });
 };
 const resetWatch=()=>page.evaluate(()=>{window.__conflictStates=[];window.__conflictPaints=[];});
 const broadcast=state=>app.evaluate(({BrowserWindow},next)=>BrowserWindow.getAllWindows()[0].webContents.send('launcher:state',next),state);
 const paints=()=>page.evaluate(()=>window.__conflictPaints);
 const states=()=>page.evaluate(()=>window.__conflictStates);

 // 1. A first run, and one real interactive Microsoft sign-in: this Easter Company account is
 //    the identity every conflict below must leave untouched.
 await hero('download').click();
 await hero('signin').waitFor();
 await hero('signin').click();
 await chooser.waitFor();
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 await app.evaluate(()=>global.easterTestApprove());
 const usernameStep=page.locator('#desktop-company-username'),passwordStep=page.locator('#desktop-company-password');
 await usernameStep.waitFor();
 await usernameStep.getByLabel('Username',{exact:true}).fill(USERNAME);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 await passwordStep.waitFor();
 await passwordStep.getByLabel('New password',{exact:true}).fill(SECRET);
 await passwordStep.getByLabel('Confirm password',{exact:true}).fill(SECRET);
 await passwordStep.getByRole('button',{name:'Save password',exact:true}).click();
 await hero('play').waitFor();
 const signedIn=await status();
 assert.equal(signedIn.account.id,'EC-7','the journey starts signed in to one Easter Company account: '+JSON.stringify(signedIn.account));
 assert.equal(signedIn.account.username,USERNAME);
 assert.equal(signedIn.microsoftConnected,true,'and the saved Microsoft session is the one it is linked to');
 assert.equal(signedIn.canPlay,true);
 const startingAccountId=signedIn.account.id;
 // The one state a real main would publish if its account view were empty while this process
 // still holds an account and a saved Microsoft session: the sign-in action is offered, and
 // the chooser it opens takes the saved-session shortcut. This is the state the review
 // measured on 5b9c260; main's own account is untouched by publishing it, which the assertions
 // below check by reading the account back through the real handler.
 const offeredState={...signedIn,account:null,companyReady:false,canPlay:false,actions:['signin'],phase:'ready',error:null,message:''};
 const offerSignIn=async()=>{await broadcast(offeredState);await hero('signin').waitFor();};
 await watch();

 // 2. The refusal itself, read through the real preload. A thrown Error arrives as name and
 //    message only; this result is what makes the code readable, and it is the measurement
 //    that is impossible to fake with a stub bridge.
 mode='conflict-id';
 const direct=await page.evaluate(()=>window.easterDesktop.continueMicrosoft());
 assert.equal(direct&&direct.ok,false,'continue-microsoft answers with the result envelope: '+JSON.stringify(direct));
 assert.equal(direct.code,'identity_conflict','the refusal code survives the isolated world: '+JSON.stringify(direct));
 assert.equal(direct.error,SERVICE_SENTENCE,'and the sentence is the account service\'s own: '+JSON.stringify(direct.error));
 assert.equal(JSON.stringify(direct).includes(String(startingAccountId)),false,'no account identifier travels in the refusal');

 // 3. The conflict, driven the way a player drives it: Sign in on the hero, then Login with
 //    Microsoft Account. The stop must come back as the chooser carrying the sentence.
 await offerSignIn();
 await resetWatch();
 const microsoftBefore=microsoftCalls().length,signInsBefore=await signIns();
 await hero('signin').click();
 await chooser.waitFor();
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await chooser.locator('.company-error').filter({hasText:SERVICE_SENTENCE}).waitFor();
 const conflictLines=await chooser.locator('.company-error p').allInnerTexts();
 const slotDump=await chooser.locator('.company-error').evaluate(node=>({text:node.textContent,hidden:node.hidden,children:node.children.length,open:node.closest('dialog')?.open}));
 assert.deepEqual(conflictLines,DIALOG_SENTENCE,'the chooser carries the account service\'s sentence, then what did not change, then the way out: '+JSON.stringify(conflictLines)+' slot='+JSON.stringify(slotDump));
 assert.match(conflictLines.join(' '),/Nothing on your Easter Company account has changed\./,'the dialog says the account is untouched');
 assert.match(conflictLines.join(' '),/Close this window[\s\S]*[Ss]ign out/,'and points at the profile\'s account switcher, which is where switching happens, once this dialog is closed');
 assert.equal(await chooser.isVisible(),true,'the chooser is back on screen');
 assert.equal(await signInDialog.isVisible(),false,'no Microsoft sign-in dialog opens for a conflict');
 assert.equal(await page.locator('[data-open-microsoft]').count(),0,'and nothing on screen offers the browser sign-in');
 assert.equal(await page.locator('.desktop-code').count(),0,'and there is no code element left to show at all');
 assert.equal(await signIns(),signInsBefore,'no second interactive sign-in is asked for: the stop is real');
 assert.equal(microsoftCalls().length,microsoftBefore+1,'exactly one enrolment is sent — the shortcut\'s own — and no second one follows it');
 assert.deepEqual(await paints(),[],'the page notice never carries the conflict sentence, not even for one frame');
 const duringConflict=await states();
 assert(duringConflict.every(entry=>entry.error===null),'no failure is announced on the state channel on this path: '+JSON.stringify(duringConflict.filter(entry=>entry.error)));
 // The account the player was signed in to is still the account they are signed in to.
 const afterConflict=await status();
 assert.equal(afterConflict.account.id,startingAccountId,'the signed-in Easter Company account is unchanged: '+afterConflict.account.id+' (was '+startingAccountId+')');
 assert.equal(afterConflict.account.username,USERNAME);
 // This once read state.accounts and asserted it was empty: "no second account appeared in
 // the account list". Provider sign-in (4341b90, launcher 1.0.23) removed that list with its
 // switch-account handler and the menu that listed it, so there is nothing to inspect and no
 // container in which a second account could be reported. The same fact is asserted against
 // the contract that replaced it: the one account is state.account, unchanged above, and no
 // account list is advertised at all.
 assert.equal('accounts' in afterConflict,false,'the state carries no account list, so no second account can appear in one');
 // The dialog is the only thing that changed: the launcher underneath is still usable and
 // still on the same account.
 await page.keyboard.press('Escape');
 await chooser.waitFor({state:'hidden'});
 await hero('play').waitFor();
 assert.equal(await heroAction(),'play','closing the sentence returns the launcher to Play on the same account');
 assert.equal((await status()).canPlay,true);
 // The sentence cannot overflow the chooser at the widths the launcher runs at: the copy is
 // longer than the bare imperative it replaces, so this is checked rather than assumed. The
 // window's own minimum is 800x600 (desktop/main.cjs), so those are the widths that matter;
 // the phone widths are checked for overflow because the shared UI is also the site's.
 await offerSignIn();
 await hero('signin').click();
 await chooser.waitFor();
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await chooser.locator('.company-error').filter({hasText:SERVICE_SENTENCE}).waitFor();
 for(const [width,height] of [[1360,920],[800,600],[390,568],[320,568]]){
  await page.setViewportSize({width,height});
  const bounds=await chooser.boundingBox();
  assert(bounds.x>=0&&bounds.x+bounds.width<=width+1,'the conflict sentence fits '+width+'px horizontally');
  assert(bounds.y>=0&&bounds.y+bounds.height<=height+1,'the conflict sentence fits the viewport at '+width+'px: '+JSON.stringify(bounds));
  assert.equal(await chooser.evaluate(node=>node.scrollWidth<=node.clientWidth),true,'the conflict sentence has no horizontal overflow at '+width+'px');
  const errorLine=chooser.locator('.company-error');
  assert.equal(await errorLine.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'the sentence wraps inside the chooser at '+width+'px');
  if(width>=800){
   // At the window sizes the launcher itself can take, the sentence is on screen where it
   // is read: it must not be pushed below the dialog's own scroll area by the copy added
   // around it. The product makes that true by scrolling the chooser there, and it does so
   // one task after the resize, so this waits for the reveal rather than sampling the tick
   // before it - measuring immediately was a race in the journey, not a product defect
   // (at 800x600 the chooser is 566px tall with 742px of content, and the sentence is
   // inside it only once its scrollTop is 68).
   const visible=await chooser.evaluate(async dialog=>{
    const inside=()=>{
     const node=dialog.querySelector('.company-error'),outer=dialog.getBoundingClientRect(),inner=node.getBoundingClientRect();
     return inner.top>=outer.top&&inner.bottom<=outer.bottom;
    };
    for(let attempt=0;attempt<40&&!inside();attempt+=1)await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,10)));
    return inside();
   });
   assert.equal(visible,true,'the whole sentence is inside the chooser on screen at '+width+'px');
  }
 }
 await page.setViewportSize({width:800,height:600});
 await page.screenshot({path:'/tmp/launcher-identity-conflict.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 await chooser.waitFor({state:'hidden'});

 // 4. The same stop when the account service is the one that refuses, which is the case the
 //    deployed service produces. Nothing about the flow changes: the code is the same, and so
 //    is the sentence the player reads.
 mode='conflict-409';
 await offerSignIn();
 await resetWatch();
 const signInsBefore409=await signIns();
 await hero('signin').click();
 await chooser.waitFor();
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await chooser.locator('.company-error').filter({hasText:SERVICE_SENTENCE}).waitFor();
 assert.deepEqual(await chooser.locator('.company-error p').allInnerTexts(),DIALOG_SENTENCE,'the service\'s own 409 reads the same as the launcher\'s own comparison');
 assert.equal(await signInDialog.isVisible(),false,'the service\'s refusal opens no Microsoft sign-in dialog either');
 assert.equal(await signIns(),signInsBefore409,'and asks for no second sign-in');
 assert.deepEqual(await paints(),[],'and paints nothing on the page notice');
 assert.equal((await status()).account.id,startingAccountId,'the signed-in account is unchanged after the service\'s refusal');
 await page.keyboard.press('Escape');
 await chooser.waitFor({state:'hidden'});

 // 5. The shortcut is still a shortcut. Any other failure of the saved session falls through
 //    to the interactive browser sign-in, exactly as before: the conflict is the
 //    one stop, not a new dead end.
 mode='provider-down';
 await offerSignIn();
 await resetWatch();
 const signInsBeforeFallThrough=await signIns();
 await hero('signin').click();
 await chooser.waitFor();
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 assert.equal(await signIns(),signInsBeforeFallThrough+1,'a saved session that fails for another reason still opens the interactive sign-in');
 // The temporary provider outage recovers before the fresh proof is submitted.
 // Reauthentication must still carry the active Company binding.
 mode='linked';
 await app.evaluate(()=>global.easterTestApprove());
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 await hero('play').waitFor();
 const settled=await status();
 assert.equal(settled.account.id,startingAccountId,'the fall-through signs back in to the same Easter Company account');
 assert.equal(settled.account.username,USERNAME);
 assert.equal(microsoftCalls().at(-1).authorization,'Bearer '+SESSION,'interactive reauthentication retains its Company binding');
 assert.equal(settled.canPlay,true);
 // This failure is not the conflict: it is reported by the call that failed, and starting
 // the interactive sign-in ends it, so nothing is left painted once the game is reachable.
 const noticeVisible=await page.locator('.desktop-page-notice').evaluate(node=>!node.hidden&&Boolean(node.textContent.trim()));
 assert.equal(noticeVisible,false,'the fall-through leaves no failure on the page notice once it is done: '+await page.locator('.desktop-page-notice').textContent());
 assert.equal(await page.locator('.desktop-auth-error').isVisible(),false,'and the sign-in dialog carries none');

 assert.deepEqual(errors,[],'the renderer raised no error');
 console.log('Identity conflict PASS: the real preload carries the identity_conflict code in the continue-microsoft result envelope, the chooser comes back with the account service\'s own sentence ("'+SERVICE_SENTENCE+'") then the account-is-unchanged line and the close-this-window-first way out, no Microsoft sign-in dialog opens, no second sign-in is asked for, the signed-in account stays '+startingAccountId+' (the silent switch the reviewer measured is impossible), the page notice is never painted on that path, and every other saved-session failure still falls through to the interactive sign-in.');
}finally{
 await app.close();
 await new Promise(resolve=>stub.close(resolve));
 await fs.rm(home,{recursive:true,force:true});
}
