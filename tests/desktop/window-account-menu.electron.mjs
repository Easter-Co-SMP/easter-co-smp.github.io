// THE ACCOUNT MENU THE WINDOW ACTUALLY DRAWS, IN THE PACKAGED-CODE WINDOW.
//
// Launcher 1.0.52 shipped with two account menus in this repository: site/account-control.mjs drew
// the site's (name pair, four rows, Settings), and site/desktop.js drew the WINDOW's own (name,
// username, `My Profile` / `Linked Accounts` / `Logout`). The bundle gate proved site/ was current
// and said nothing about which menu the window draws, so Owen installed 1.0.52 and found the old
// one (2026-10-30: "doesn't have the new settings menu"). A browser suite could not have caught it
// either: this menu only exists inside the Electron window.
//
// So this journey opens the REAL window and reads what it draws: the identity pair, the four rows
// in the control's order and words, `Settings` opening the shared panel, and one save through the
// account service - answered here by a loopback stub, because the point is the wire from the panel
// through preload and main to the client, not the cloud.
//
// Run it alone, as every Electron journey runs:
//     xvfb-run -a node tests/desktop/window-account-menu.electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

// The account the window signs in as. Two different names on purpose: a fixture whose display name
// and username read the same would prove nothing about which line is which.
const ACCOUNT={id:7,username:'captaintestbeard',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:'cc75443d8979fe5cdbdf2de55b822ec8b63bc55348c2e451b46b19f4746885ca'};
const SESSION='fixture-company-private-session';
// The language catalogue the picker draws: the service's own shape, Automatic beside it.
const LANGUAGES={automatic:'auto',languages:[{code:'de_de',native:'Deutsch (Deutschland)',english:'de_de'},{code:'en_us',native:'English (United States)',english:'English (United States)'},{code:'ja_jp',native:'日本語 (日本)',english:'ja_jp'}]};
const ROWS=[['My Profile','myProfile'],['Linked Accounts','linkedAccounts'],['Settings','settings'],['Sign out','signOut']];

const calls=[];
// The account service, as a loopback stub: the document, its revision, and a compare-and-set write
// that answers 409 for a revision that has moved - the shape api/settings_routes.py serves.
const settings={version:1,language:'auto',theme:'system',chat:{enter:'submit',shiftEnter:'newline',ctrlEnter:'interrupt'},editor:{vim:false}};
let revision=5,refusals=0;
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  const raw=Buffer.concat(chunks).toString();
  const body=raw?JSON.parse(raw):null;
  const url=new URL(request.url,'http://127.0.0.1');
  calls.push({path:url.pathname,method:request.method,authorization:request.headers.authorization,body});
  const json=(payload,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  if(url.pathname==='/v2/accounts/microsoft')return json({created:false,account:ACCOUNT,session:{token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  if(url.pathname==='/v2/accounts/me')return json({account:ACCOUNT});
  if(url.pathname==='/v2/accounts/wake')return json({});
  if(url.pathname==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  if(url.pathname==='/v2/accounts/settings/languages')return json(LANGUAGES);
  if(url.pathname==='/v2/accounts/settings'&&request.method==='GET')return json({settings:{...settings,chat:{...settings.chat}},revision,updatedAt:'2026-10-30T12:00:00Z'});
  if(url.pathname==='/v2/accounts/settings'&&request.method==='PUT'){
   const held=body?.revision??null;
   if(held!==null&&held!==revision){refusals+=1;return json({error:'revision_conflict',settings,revision},409);}
   Object.assign(settings,{version:body.settings.version,language:body.settings.language,theme:body.settings.theme,chat:{...body.settings.chat},editor:{...body.settings.editor}});
   revision+=1;
   return json({settings,revision,updatedAt:'2026-10-30T12:00:05Z'});
  }
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const home=await fs.mkdtemp('/tmp/window-account-menu-');
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:'+stub.address().port}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 // The settings panel hangs a best-effort `beforeunload` on the page while a draft is dirty
 // (site/user-settings.mjs, as Diana's spec asks). Closing the app with one up would show a dialog
 // and mask whatever this journey was really reporting, so it is dismissed and the assertion
 // underneath is allowed to speak.
 page.on('dialog',dialog=>void dialog.dismiss().catch(()=>{}));
 await page.keyboard.press('Escape');
 // The window's own first move, unchanged from the other account journeys: ask for the download,
 // sign in, approve the stubbed Microsoft page.
 await page.locator('[data-desktop-play][data-action=download]').click();
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();

 // ---- the pill the window draws, and the menu behind it -----------------------------------
 const pill=page.locator('.desktop-account-nav');
 assert.equal(await pill.count(),1,'the window has exactly one account control');
 // `.desktop-account-nav` and `.web-account-nav` are the same button: the class is the window's,
 // the control is the shared one, and the pill's geometry is the site's own rule.
 assert.equal(await pill.evaluate(node=>node.classList.contains('web-account-nav')),true,'and it is the shared control\'s button');
 assert.equal((await pill.locator('.web-account-name').textContent()).trim(),'Captain Testbeard','the pill names the player, not the handle');
 // The pill keeps the site's own geometry: the control brings the face and site/web.css draws it,
 // and the window's header is where that class is turned on.
 const pillFace=await pill.locator('.web-account-face').boundingBox();
 assert.equal(Math.round(pillFace.width),32,'the face slot is the control\'s 32px square');
 assert.equal(await pill.locator('.web-account-face').count(),1,'the pill carries the control\'s own face slot');
 assert.equal(await pill.evaluate(node=>node.closest('.web-mode')!==null),true,'and the site-side pill rules are the ones drawing it');
 // What the pill says it opens, and what it is called. The control's own words for a signed-in
 // account are "Account options" and `menu`; this window names the player in its accessible name
 // and says `menu` here, `dialog` when signed out (where its click opens the sign-in chooser).
 assert.equal(await pill.getAttribute('aria-haspopup'),'menu','a signed-in pill says it opens the menu');
 assert.equal(await pill.getAttribute('aria-label'),'Account: Captain Testbeard','and names whose account it is, in the window\'s own words');
 await pill.click();
 const menu=page.locator('#web-account-menu');
 await menu.waitFor({state:'visible'});
 assert.equal(await menu.locator('.web-account-identity-name').textContent(),'Captain Testbeard','the menu leads with the display name');
 assert.equal(await menu.locator('.web-account-identity-username').textContent(),'captaintestbeard','then the bare username');
 assert.deepEqual(await menu.locator('[data-profile-action]').evaluateAll(nodes=>nodes.map(node=>node.textContent)),ROWS.map(([label])=>label),'the four rows, in the control\'s order and words');
 assert.deepEqual(await menu.locator('[data-profile-action]').evaluateAll(nodes=>nodes.map(node=>node.dataset.profileAction)),ROWS.map(([,key])=>key),'read by the keys the window gives them');
 const menuText=await menu.innerText();
 assert(!/Logout/.test(menuText),'the word Logout is gone from the menu: '+menuText.replace(/\s+/g,' '));
 assert(!/Logout/.test(await page.locator('body').innerText()),'and from everything the window prints');
 assert(!menuText.includes('@'),'no address is printed in the menu');
 // The name pair is the menu's own two lines, styled by the shared stylesheet the control brings.
 const pairBox=await menu.locator('.web-account-identity').boundingBox();
 assert(pairBox&&pairBox.height>0,'the identity block is painted, not an unstyled line: '+JSON.stringify(pairBox));
 assert.equal(await menu.locator('.web-account-identity-name').evaluate(node=>getComputedStyle(node).fontWeight),'650','with the shared rule on it');

 // ---- Settings opens the SAME panel --------------------------------------------------------
 await menu.getByRole('button',{name:'Settings',exact:true}).click();
 const panel=page.locator('#easter-user-settings');
 await panel.locator('#es-chat-ctrlEnter').selectOption('queue');
 await panel.getByRole('button',{name:'Save Changes'}).click();
 await page.waitForFunction(()=>document.getElementById('easter-user-settings')?.open===false);
 const writes=calls.filter(call=>call.path==='/v2/accounts/settings'&&call.method==='PUT');
 assert.equal(writes.length,1,'exactly one write reached the account service');
 assert.deepEqual(writes[0].body,{settings:{version:1,language:'auto',theme:'system',chat:{enter:'submit',shiftEnter:'newline',ctrlEnter:'queue'},editor:{vim:false}},revision:5},'the whole document and the revision the read was answered with: '+JSON.stringify(writes[0].body));
 assert.equal(writes[0].authorization,'Bearer '+SESSION,'carrying the session, which never entered the renderer');
 assert.equal(settings.chat.ctrlEnter,'queue','the account service stored the change');
 assert.equal(revision,6,'and answered with the next revision');
 assert.equal(refusals,0,'no write was refused');
 // Reopening reads it back, so the round trip includes the read.
 await pill.click();
 await menu.getByRole('button',{name:'Settings',exact:true}).click();
 await panel.waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#es-chat-ctrlEnter')?.value==='queue');
 assert.equal(await panel.locator('.es-actions').isHidden(),true,'and the panel reopens clean on the stored document');

 // ---- the renderer still holds no token ----------------------------------------------------
 const surface=JSON.stringify(await page.evaluate(()=>window.easterDesktop.status()))+await page.locator('body').innerText();
 assert(!surface.includes(SESSION),'no session token reaches the renderer');
 assert(!surface.includes('fixture-company-private'),'in any form');

 // ---- signing out still leaves a window that offers sign-in --------------------------------
 await page.keyboard.press('Escape');
 await pill.click();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 assert.equal((await pill.locator('.web-account-name').textContent()).trim(),'Sign in','a signed-out window offers sign-in instead of a menu');
 // The site's own sentence for its pill is "Sign in or create an Easter Company account"; the
 // window has its own, and the control's default must not overwrite it.
 assert.equal(await pill.getAttribute('aria-label'),'Sign in','and its accessible name is the window\'s "Sign in"');
 assert.equal(await pill.getAttribute('aria-haspopup'),'dialog','and a signed-out pill says it opens the sign-in chooser');
 assert.equal(calls.some(call=>call.path==='/v2/accounts/logout'&&call.authorization==='Bearer '+SESSION),true,'and the session was revoked');
 console.log('Window account menu PASS: the packaged window draws the shared control - name pair, My Profile / Linked Accounts / Settings / Sign out, no Logout anywhere - Settings opens the User Settings panel, one save round-trips through preload, main and the account service with no token in the renderer, and signing out returns the pill to Sign in.');
}finally{await app.close();await new Promise(resolve=>stub.close(resolve));await fs.rm(home,{recursive:true,force:true});}
