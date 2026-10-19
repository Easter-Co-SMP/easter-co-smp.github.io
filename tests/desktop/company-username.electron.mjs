// The username-first account flow, driven through the real renderer and the real main
// process against a loopback server that speaks the frozen account contract. Every
// request body the launcher sends is captured and compared, so what is proved here is
// the shape on the wire, not a paraphrase of it:
//   POST /v2/accounts/password/login       {identifier, password, client}
//   POST /v2/accounts/username/available   {username}
//   POST /v2/accounts/password             {username, password, replace, client}
// Run: xvfb-run -a node tests/desktop/company-username.electron.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const MICROSOFT_ID='1234567890abcdef1234567890abcdef';
const SUBJECT=createHash('sha256').update(MICROSOFT_ID).digest('hex');
// The Microsoft account's email exists on the server side and must never reach the client
// except through the profile's owner-only verified-email read.
const EMAIL='player@example.test';
const SECOND_EMAIL='crew@example.test';
// A provider-verified address that is already another Easter Company account's login email:
// the list carries it, and selecting it is refused.
const LOST_EMAIL='lost@example.test';
const SESSION='fixture-company-private-session';
const VERSION=JSON.parse(await fs.readFile(path.resolve('package.json'),'utf8')).version;
const SECRET='fixture secret passphrase';
const calls=[];
// Accounts the server owns. A brand new Microsoft signup has no username yet.
const account={id:7,username:null,minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:true,microsoftLinked:true,microsoftSubject:SUBJECT};
// The two refusals, in the vocabulary the deployed probe actually uses
// (api/identity_routes.py sends reason 'taken' or 'policy'), so the stub cannot agree
// with a client that only knows the contract's error-code spelling.
const PROBE_TAKEN='taken_captain',PROBE_RESERVED='easter',PROBE_FREE='captain_test',RACE_LOST='racer';
const document=()=>({...account,email:EMAIL});
// The verified addresses the account service holds for this account, and which of them is
// the login email. `noEmails` is an account whose providers report nothing; `lostEmail` is
// an address still recorded here that another account already signs in with.
let loginEmail=EMAIL,noEmails=false,lostEmail=false;
const verified=()=>noEmails?[]:[EMAIL,SECOND_EMAIL,...(lostEmail?[LOST_EMAIL]:[])];
const emailPayload=()=>{
 const list=verified();
 return {emails:list.map((address,index)=>({email:address,provider:'microsoft',verifiedAt:'2026-01-0'+(index+1)+'T00:00:00Z',login:address===loginEmail})),loginEmail:list.includes(loginEmail)?loginEmail:null};
};
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:request.url,method:request.method,authorization:request.headers.authorization,body});
  const json=(payload,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  const error=(status,code)=>json({error:code,detail:'server detail that must never surface'},status);
  const signed=created=>json({created,account:document(),session:{token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  if(request.url==='/v2/accounts/microsoft')return signed(true);
  if(request.url==='/v2/accounts/username/available'){
   if(body.username===PROBE_TAKEN)return json({available:false,reason:'taken',email:EMAIL});
   if(body.username===PROBE_RESERVED)return json({available:false,reason:'policy',email:EMAIL});
   return json({available:true,reason:null,email:EMAIL});
  }
  if(request.url==='/v2/accounts/password'){
   const session={token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()};
   // A password change carries no username; the first password claims one.
   if(body.replace===true)return account.username?json({created:false,account:document(),session}):error(400,'invalid_request');
   if(account.username)return error(400,'invalid_request');
   // The probe cannot see an account claimed a moment ago: the combined call can.
   if(body.username===RACE_LOST)return error(409,'username_taken');
   account.username=body.username;account.passwordRequired=false;account.email=EMAIL;
   return json({created:true,account:document(),session});
  }
  if(request.url==='/v2/accounts/password/login'){
   if(body.identifier===account.username&&body.password===SECRET)return signed(false);
   if(body.identifier===EMAIL&&body.password===SECRET)return signed(false);
   return error(401,'invalid_credentials');
  }
  // The verified-email routes. Owner-only in the fixture exactly as in the frozen contract:
  // the session is the only handle, and the answer carries the shaped list plus the login
  // address. The fixture adds an unrelated field to the payload to prove it is dropped.
  if(request.url==='/v2/accounts/emails'&&request.method==='GET')return json({...emailPayload(),account:{id:account.id,email:EMAIL},token:SESSION});
  if(request.url==='/v2/accounts/emails/login'&&request.method==='POST'){
   if(body.email===null){loginEmail=null;return json(emailPayload());}
   if(!verified().includes(body.email))return error(400,'email_not_yours');
   // Verified for this account, but another account already signs in with it.
   if(body.email===LOST_EMAIL)return error(400,'email_not_yours');
   loginEmail=body.email;return json(emailPayload());
  }
  if(request.url==='/v2/accounts/me')return json({account:document()});
  if(request.url==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'company-username-e2e-'));
const launch=()=>electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:'+stub.address().port}});
let app=await launch();
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.keyboard.press('Escape');await page.setViewportSize({width:800,height:600});
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 // 1. The signed-out Home action starts Microsoft linking, and no Company ID is offered.
 await page.locator('[data-desktop-play][data-action=download]').click();
 const hero=page.locator('[data-desktop-play][data-action=signin]');
 await hero.waitFor();
 const heroText=await hero.textContent();
 assert.match(heroText,/Sign in with Microsoft/,'the signed-out Home action starts the Microsoft sign-in: '+heroText);
 // One verb for the Microsoft action, and it is never the chooser form's own bare "Sign in":
 // the hero names where the account comes from rather than offering a second way in.
 assert(!/^Sign in\b(?! with Microsoft)/.test(heroText.trim()),'the signed-out Home action is not the bare Sign in action: '+heroText);
 assert(!/Easter Company account/.test(heroText),'and carries no Easter Company account note');
 // The pair is the one doc/launcher-states.md records for this state (*The signed-out hero's own
 // sentence*), so a later re-wording of either half fails here instead of being discovered late.
 assert.equal((await hero.locator('small').textContent()).trim(),'Microsoft account required','the signed-out Home action says an account is required, in the words the contract records: '+heroText);
 await hero.click();
 const chooser=page.locator('#desktop-company-signin');await chooser.waitFor();
 assert.equal(await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).count(),0,'the old Microsoft button wording is gone');
 assert.equal((await chooser.locator('.company-provider-note').textContent()).trim(),'Please sign up using an existing online account provider, and then create an Easter Company account username & password.');
 assert.equal(await chooser.getByLabel('Username or Email',{exact:true}).count(),1,'the direct sign-in field is Username or Email');
 assert.equal(await chooser.getByLabel('Username or Email',{exact:true}).getAttribute('placeholder'),null,'the field carries no EC-123 placeholder');
 const chooserHTML=await chooser.innerHTML();
 for(const gone of ['Company ID','EC-123','company-divider','Or use your'])assert(!chooserHTML.includes(gone),'the sign-in dialog carries no '+gone);
 assert(!/EC-\d/.test(await chooser.textContent()),'no Company ID is shown to the player');
 await page.screenshot({path:'/tmp/company-username-signin.png',animations:'disabled'});
 // The same three widths the launcher's own UI review uses, so the new copy cannot
 // overflow the dialog on a small window.
 const fits=async(dialog,name)=>{
  for(const [width,height] of [[1360,920],[800,600],[390,568],[320,568]]){
   await page.setViewportSize({width,height});
   const bounds=await dialog.boundingBox();
   assert(bounds.x>=0&&bounds.x+bounds.width<=width+1,name+' fits '+width+'px');
   assert(bounds.y>=0&&bounds.y+bounds.height<=height+1,name+' fits vertically at '+width+'px');
   assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,name+' has no horizontal overflow at '+width+'px');
   await page.screenshot({path:'/tmp/company-username-'+name+'-'+width+'.png',animations:'disabled'});
  }
  await page.setViewportSize({width:800,height:600});
 };
 await fits(chooser,'signin');
 // 2. Microsoft sign-in creates an account with no username, so setup starts at step 1.
 await chooser.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();await app.evaluate(()=>global.easterTestApprove());
 const usernameStep=page.locator('#desktop-company-username'),passwordStep=page.locator('#desktop-company-password');
 await usernameStep.waitFor();
 assert.equal(await passwordStep.isVisible(),false,'the password step is not offered before the username');
 assert.equal((await usernameStep.locator('.company-step').textContent()).trim(),'Step 1 of 2');
 assert.equal(await usernameStep.getByLabel('Username',{exact:true}).count(),1);
 assert.equal(await usernameStep.locator('input[type=password]').count(),0,'step 1 asks for no password');
 let state=await status();assert.equal(state.account.username,null);assert.equal(state.account.passwordRequired,true);assert.equal(state.canPlay,false);
 await page.screenshot({path:'/tmp/company-username-step1.png',animations:'disabled'});
 await fits(usernameStep,'step1');
 // 3. A taken username is a plain sentence on step 1, and the player stays there. The
 // refusals are the only answers the probe can give, and none of them may advance: a
 // name that is not claimed must never reach the password step on a maybe.
 const refusals=calls.filter(call=>call.path==='/v2/accounts/password');
 assert.equal(refusals.length,0,'nothing is written before the username is answered');
 const refuse=async(name,message)=>{
  await usernameStep.getByLabel('Username',{exact:true}).fill(name);
  await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
  await usernameStep.locator('.company-error').filter({hasText:message}).waitFor();
  assert.equal((await usernameStep.locator('.company-error').textContent()).trim(),message);
  assert.equal(await passwordStep.isVisible(),false,'a refused username does not advance to the password');
  assert.equal(await usernameStep.isVisible(),true);
  assert.equal(await usernameStep.getByLabel('Username',{exact:true}).inputValue(),name,'the typed name is kept');
  assert.equal(calls.filter(call=>call.path==='/v2/accounts/password').length,0,'a refusal writes nothing');
 };
 await refuse(PROBE_TAKEN,'That username is already taken. Try another.');
 // A reserved word passes every rule the client can see and is refused by the server as a
 // policy answer, which must not be reported as a name someone else holds.
 await refuse(PROBE_RESERVED,'Use 3 to 20 characters: lowercase letters, numbers, underscores or dashes.');
 // 4. A username the probe allows is taken to step 2, which names it.
 await usernameStep.getByLabel('Username',{exact:true}).fill(RACE_LOST);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 await passwordStep.waitFor();
 assert.equal(await usernameStep.isVisible(),false,'step 1 closes when step 2 opens');
 assert.equal((await passwordStep.locator('.company-step').textContent()).trim(),'Step 2 of 2');
 assert.equal((await passwordStep.locator('.company-username').textContent()).trim(),'Your username: '+RACE_LOST);
 assert.equal(await passwordStep.getByLabel('Username',{exact:true}).count(),0,'the password step never asks for the username again');
 assert.equal(await passwordStep.getByText(/Company ID|EC-123/).count(),0,'the password step shows no Company ID');
 await page.screenshot({path:'/tmp/company-username-step2.png',animations:'disabled'});
 await fits(passwordStep,'step2');
 const savePassword=async secret=>{
  await passwordStep.getByLabel('New password',{exact:true}).fill(secret);
  await passwordStep.getByLabel('Confirm password',{exact:true}).fill(secret);
  await passwordStep.getByRole('button',{name:'Save password',exact:true}).click();
 };
 // 5. The race the probe could not see walks back to step 1 with the name kept.
 await savePassword(SECRET);
 await usernameStep.locator('.company-error').filter({hasText:'already taken'}).waitFor();
 assert.equal(await usernameStep.isVisible(),true,'a taken username returns the player to step 1');
 assert.equal(await usernameStep.getByLabel('Username',{exact:true}).inputValue(),RACE_LOST,'and keeps what they typed');
 assert.equal((await passwordStep.locator('.company-error').textContent()).trim(),'','no stale step-2 error is left behind');
 // 6. The real claim: username, then password, saved in one call.
 await usernameStep.getByLabel('Username',{exact:true}).fill(PROBE_FREE);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 await passwordStep.waitFor();
 assert.equal((await passwordStep.locator('.company-username').textContent()).trim(),'Your username: '+PROBE_FREE);
 await savePassword(SECRET);
 await passwordStep.waitFor({state:'hidden'});
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 state=await status();
 assert.equal(state.account.username,PROBE_FREE,'the account view carries the claimed username');
 assert.equal(state.account.passwordRequired,false);
 assert.equal(state.companyReady,true);
 // 7. The exact bodies, in order, as the fixture backend received them.
 const probeBodies=calls.filter(call=>call.path==='/v2/accounts/username/available').map(call=>call.body);
 assert.deepEqual(probeBodies,[{username:PROBE_TAKEN},{username:PROBE_RESERVED},{username:RACE_LOST},{username:PROBE_FREE}]);
 assert(calls.filter(call=>call.path==='/v2/accounts/username/available').every(call=>call.method==='POST'&&call.authorization===undefined),'the probe is unauthenticated and carries no session');
 const passwordCalls=calls.filter(call=>call.path==='/v2/accounts/password');
 assert.equal(passwordCalls.length,2,'the lost race and the successful claim are the only account writes');
 assert.deepEqual(passwordCalls[0].body,{username:RACE_LOST,password:SECRET,replace:false,client:'launcher/'+VERSION});
 assert.deepEqual(passwordCalls[1].body,{username:PROBE_FREE,password:SECRET,replace:false,client:'launcher/'+VERSION});
 assert(passwordCalls.every(call=>call.authorization==='Bearer '+SESSION));
 assert(!JSON.stringify(calls).includes('companyId'),'no request carries a Company ID');
 // 8. The username is displayed; the Company ID and the email are not, anywhere.
 await page.locator('.desktop-account-nav').click();
 const menu=await page.locator('.desktop-profile-menu').textContent();
 assert(menu.includes(PROBE_FREE),'the profile menu names the username: '+menu);
 assert(!menu.includes('EC-'),'the profile menu shows no Company ID');
 // The profile's own line names the address that signs this account in, and only that.
 const emailLine=page.locator('.desktop-profile-heading.desktop-email');
 // The line lives in the profile popover, which is closed while the email section is open,
 // so it is read by its content rather than by visibility.
 const lineIs=async text=>{
  await emailLine.filter({hasText:text}).waitFor({state:'attached'});
  assert.equal((await emailLine.textContent()).trim(),text);
 };
 await lineIs('Login email: '+EMAIL);
 await page.screenshot({path:'/tmp/company-username-profile.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 // The state surface carries no address at all: the account list, the account switch and
 // the skin cache keep using the account id, so none of them changed.
 const stateSurface=JSON.stringify(await status());
 for(const secret of [EMAIL,SECOND_EMAIL,'example.test',SESSION,'microsoftSubject'])assert(!stateSurface.includes(secret),'the launcher state carries no '+secret);
 // On screen, an address appears in the profile section and nowhere else.
 const outsideProfile=await page.evaluate(()=>{const clone=document.body.cloneNode(true);for(const node of clone.querySelectorAll('.desktop-profile-menu,#desktop-company-emails'))node.remove();return clone.textContent;});
 assert(!outsideProfile.includes('@example.test'),'no email is displayed outside the profile section');
 const surface=JSON.stringify(await status())+await page.locator('body').textContent();
 for(const secret of [SESSION,'microsoftSubject'])assert(!surface.includes(secret),'the renderer surface carries no '+secret);
 // The opaque account handle stays in state because the account menu switches on it, but
 // nothing on screen may show a Company ID to the player.
 assert(!(await page.locator('body').textContent()).includes('EC-'),'no Company ID is displayed anywhere on the launcher');
 // Any address on the wire belongs to the verified-email routes and nowhere else. The
 // identifier the player types at the password step is their own input, and it is the only
 // other place an address-shaped string is ever posted.
 const shippedAddresses=calls.filter(call=>!call.path.startsWith('/v2/accounts/emails'));

// 8c. The verified emails. The profile lists what the account service reports and lets the
// player choose which address signs them in, one at a time. Nothing about Steam or Discord
// is built here: the rows are whatever providers the service names.
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 const emailsDialog=page.locator('#desktop-company-emails');
 await emailsDialog.waitFor();
 const addressRows=emailsDialog.locator('input[name=email]');
 await addressRows.first().waitFor();
 assert.equal(await addressRows.count(),2,'both verified addresses are listed');
 assert.deepEqual(await emailsDialog.locator('.company-email-address').allTextContents(),[EMAIL,SECOND_EMAIL]);
 assert.equal(await addressRows.nth(0).isChecked(),true,'the address the service signs in with is the marked one');
 assert.equal(await addressRows.nth(1).isChecked(),false);
 assert.deepEqual(await emailsDialog.locator('.company-email-meta').allTextContents(),['Microsoft · signs you in','Microsoft · recorded, not a login key'],'the copy says which address is a login key and which is only recorded');
 assert.match(await emailsDialog.locator('.company-intro').textContent(),/Only the selected address is a login key/);
 assert.equal(await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).isDisabled(),true,'there is nothing to save before the choice changes');
 assert.equal(await emailsDialog.locator('.company-emails-unset').isVisible(),false);
 assert.equal(await emailsDialog.locator('.company-emails-empty').isVisible(),false,'no empty-state sentence is shown beside a real list');
 await fits(emailsDialog,'emails');
 await page.screenshot({path:'/tmp/company-emails-list.png',animations:'disabled'});
 // The second address, saved: one selection, chosen by the player.
 await addressRows.nth(1).check();
 await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).click();
 await emailsDialog.locator('.company-status').filter({hasText:'Your login email is saved.'}).waitFor();
 assert.equal(loginEmail,SECOND_EMAIL,'the account service now holds the chosen address');
 assert.equal(await addressRows.nth(1).isChecked(),true);
 assert.equal(await addressRows.nth(0).isChecked(),false);
 assert.deepEqual(await emailsDialog.locator('.company-email-meta').allTextContents(),['Microsoft · recorded, not a login key','Microsoft · signs you in']);
 await lineIs('Login email: '+SECOND_EMAIL);
 await page.screenshot({path:'/tmp/company-emails-saved.png',animations:'disabled'});
 // Closed and reopened: the section re-reads the service's own record, so the marked
 // address is the choice that was saved rather than anything this launcher remembered.
 await page.keyboard.press('Escape');
 await emailsDialog.waitFor({state:'hidden'});
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 await addressRows.first().waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('#desktop-company-emails input[name=email]')[1]?.checked===true);
 assert.equal(await addressRows.nth(1).isChecked(),true,'the reopened section reads the saved choice back');
 // Clearing the selection, which is the state an account signs in with Microsoft or its
 // username from.
 await emailsDialog.getByRole('button',{name:'Clear login email',exact:true}).click();
 await emailsDialog.locator('.company-status').filter({hasText:'cleared'}).waitFor();
 assert.equal(loginEmail,null,'the selection is cleared on the account service');
 assert.equal(await addressRows.nth(0).isChecked(),false);
 assert.equal(await addressRows.nth(1).isChecked(),false);
 assert.equal(await emailsDialog.locator('.company-emails-unset').isVisible(),true,'with nothing selected the section says which sign-in works');
 assert.match(await emailsDialog.locator('.company-emails-unset').textContent(),/Sign in with Microsoft or with your username\./);
 assert.equal(await emailsDialog.getByRole('button',{name:'Clear login email',exact:true}).isVisible(),false,'there is nothing left to clear');
 await lineIs('No login email is selected. Sign in with Microsoft or with your username.');
 await page.screenshot({path:'/tmp/company-emails-cleared.png',animations:'disabled'});
 // Choose the second address again, so the restart below has a non-default choice to keep.
 await addressRows.nth(1).check();
 await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).click();
 await emailsDialog.locator('.company-status').filter({hasText:'Your login email is saved.'}).waitFor();
 assert.equal(loginEmail,SECOND_EMAIL);
 // An account whose providers report no verified address says so in one sentence, and
 // shows no list, no selection and no action that could invent one.
 noEmails=true;
 await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 await emailsDialog.locator('.company-emails-empty').waitFor();
 assert.equal(await emailsDialog.locator('input[name=email]').count(),0,'an account with no verified email shows no list');
 assert.equal((await emailsDialog.locator('.company-emails-empty').textContent()).trim(),'No verified email is recorded for this account. Sign in with Microsoft or with your username.');
 assert.equal(await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).isVisible(),false);
 assert.equal(await emailsDialog.getByRole('button',{name:'Clear login email',exact:true}).isVisible(),false);
 await lineIs('No verified email is recorded for this account. Sign in with Microsoft or with your username.');
 await page.screenshot({path:'/tmp/company-emails-none.png',animations:'disabled'});
 noEmails=false;
 // A verified address another account already signs in with is refused as unavailable:
 // one sentence, and the selection the service holds stays exactly as it was.
 lostEmail=true;
 await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 await addressRows.nth(2).waitFor();
 assert.equal(await addressRows.count(),3);
 await addressRows.nth(2).check();
 await emailsDialog.getByRole('button',{name:'Save selection',exact:true}).click();
 await emailsDialog.locator('.company-error').filter({hasText:'cannot be your login email'}).waitFor();
 assert.equal((await emailsDialog.locator('.company-error').textContent()).trim(),'That address cannot be your login email. It is not verified for this account, or another Easter Company account already uses it to sign in.');
 assert.equal(await addressRows.nth(1).isChecked(),true,'the refused address leaves the previous selection in place and still marked');
 assert.equal(loginEmail,SECOND_EMAIL,'and the account service still holds it');
 assert.equal((await emailsDialog.locator('.company-status').textContent()).trim(),'','a refused selection claims nothing was saved');
 lostEmail=false;
 await page.screenshot({path:'/tmp/company-emails-refused.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 // The exact bodies the verified-email routes received, in order: the chosen address, an
 // explicit null to clear, the chosen address again and the refused one. Each carries the
 // Company session and none names an account.
 const emailWrites=calls.filter(call=>call.path==='/v2/accounts/emails/login');
 assert.deepEqual(emailWrites.map(call=>call.body),[{email:SECOND_EMAIL},{email:null},{email:SECOND_EMAIL},{email:LOST_EMAIL}]);
 assert(emailWrites.every(call=>call.method==='POST'&&call.authorization==='Bearer '+SESSION));
 assert(emailWrites.every(call=>!('accountId' in call.body)&&!('companyId' in call.body)),'no account handle is posted');
 assert(calls.filter(call=>call.path==='/v2/accounts/emails').every(call=>call.method==='GET'&&call.authorization==='Bearer '+SESSION),'the list is only ever read with the Company session');
 // Every read is authenticated and every read follows a write, which is why the profile
 // never holds a copy of its own.
 const reads=calls.filter(call=>call.path==='/v2/accounts/emails');
 assert.equal(reads.length>=5,true,'the list is re-read rather than remembered');
 assert.deepEqual(shippedAddresses.filter(call=>JSON.stringify(call.body).includes('@example.test')).map(call=>call.path),[]
  ,'no request outside the verified-email routes carries an address');
 await page.screenshot({path:'/tmp/company-username-ready.png',animations:'disabled'});
 // 8b. A password change is the password step on its own: no username is asked for again,
 // and the request that changes the password carries none.
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Reset password',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();await app.evaluate(()=>global.easterTestApprove());
 const reset=passwordStep;
 await reset.getByRole('heading',{name:'Reset your Easter Company password',exact:true}).waitFor();
 assert.equal(await reset.getByLabel('Username',{exact:true}).count(),0,'a password change never asks for the username');
 assert.equal(await reset.locator('.company-username').isVisible(),false,'and does not name one either');
 assert.equal(await reset.locator('.company-step').isVisible(),false,'it is not step two of the setup flow');
 const replacement='replacement fixture passphrase';
 await reset.getByLabel('New password',{exact:true}).fill(replacement);
 await reset.getByLabel('Confirm password',{exact:true}).fill(replacement);
 await reset.getByRole('button',{name:'Save password',exact:true}).click();
 await reset.waitFor({state:'hidden'});
 assert.equal((await status()).account.username,PROBE_FREE);
 const resets=calls.filter(call=>call.path==='/v2/accounts/password'&&call.body.replace===true);
 assert.equal(resets.length,1,'the reset posted once');
 assert.deepEqual(resets[0].body,{password:replacement,replace:true,client:'launcher/'+VERSION});
 await page.waitForFunction(()=>[...document.querySelectorAll('input[type=password]')].every(input=>input.value===''),null,{timeout:5000});
 // 9. Direct sign-in posts what the player typed as the identifier.
 await page.evaluate(()=>window.easterDesktop.signOut());
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await chooser.waitFor();
 await chooser.getByLabel('Username or Email',{exact:true}).fill(EMAIL);
 await chooser.getByLabel('Password',{exact:true}).fill('wrong password passphrase');
 await chooser.getByRole('button',{name:'Sign in',exact:true}).click();
 await chooser.locator('.company-error').filter({hasText:'is incorrect'}).waitFor();
 assert.equal((await chooser.locator('.company-error').textContent()).trim(),'The username or email, or the password, is incorrect.');
 assert.equal((await status()).account,null,'a refused sign-in leaves no account');
 await chooser.getByLabel('Password',{exact:true}).fill(SECRET);
 await chooser.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.locator('[data-desktop-play][data-action=connect-microsoft]').waitFor();
 state=await status();assert.equal(state.account.username,PROBE_FREE,'direct sign-in restores the same account');
 const logins=calls.filter(call=>call.path==='/v2/accounts/password/login');
 assert.deepEqual(logins.map(call=>call.body),[
  {identifier:EMAIL,password:'wrong password passphrase',client:'launcher/'+VERSION},
  {identifier:EMAIL,password:SECRET,client:'launcher/'+VERSION}
 ]);
 assert(logins.every(call=>call.authorization===undefined));
 assert(!JSON.stringify(calls).includes('"companyId"'));
 assert.deepEqual(errors,[]);
 // 10. A restart. The launcher is closed and started again against the same account
 // service, and the choice is still the player's: it is the service's record, read back
 // by the same owner-only route, because the launcher keeps no copy of an address at all.
 await app.close();
 app=await launch();
 const page2=await app.firstWindow();page2.setDefaultTimeout(20000);
 const errors2=[];page2.on('pageerror',error=>errors2.push(error.message));
 await page2.keyboard.press('Escape');await page2.setViewportSize({width:800,height:600});
 await page2.locator('[data-desktop-play]').waitFor();
 // A new process knows nothing about the previous one's installed client, so the first
 // action is the download again; then the account is reached through the sign-in it offers.
 const actionOf=()=>page2.locator('[data-desktop-play]').evaluate(node=>node.dataset.action);
 if(await actionOf()==='download')await page2.locator('[data-desktop-play][data-action=download]').click();
 await page2.waitForFunction(()=>['signin','connect-microsoft','play'].includes(document.querySelector('[data-desktop-play]')?.dataset.action));
 if(await actionOf()==='signin'){
  await page2.locator('[data-desktop-play][data-action=signin]').click();
  const restartedChooser=page2.locator('#desktop-company-signin');
  await restartedChooser.waitFor();
  await restartedChooser.getByLabel('Username or Email',{exact:true}).fill(PROBE_FREE);
  await restartedChooser.getByLabel('Password',{exact:true}).fill(SECRET);
  await restartedChooser.getByRole('button',{name:'Sign in',exact:true}).click();
  await page2.waitForFunction(()=>['connect-microsoft','play'].includes(document.querySelector('[data-desktop-play]')?.dataset.action));
 }
 const restarted=await page2.evaluate(()=>window.easterDesktop.status());
 assert.equal(restarted.account.username,PROBE_FREE,'the restarted launcher is on the same Easter Company account');
 assert(!JSON.stringify(restarted).includes('@example.test'),'and its state still carries no address');
 await page2.locator('.desktop-account-nav').click();
 await page2.locator('.desktop-profile-heading.desktop-email').filter({hasText:'Login email: '+SECOND_EMAIL}).waitFor();
 await page2.getByRole('button',{name:'Verified emails',exact:true}).click();
 const restartedDialog=page2.locator('#desktop-company-emails');
 await restartedDialog.locator('input[name=email]').first().waitFor();
 await page2.waitForFunction(()=>document.querySelectorAll('#desktop-company-emails input[name=email]')[1]?.checked===true);
 assert.equal(await restartedDialog.locator('input[name=email]').nth(1).isChecked(),true,'the saved choice survives the restart');
 assert.equal(await restartedDialog.locator('input[name=email]').nth(0).isChecked(),false);
 assert.equal(loginEmail,SECOND_EMAIL);
 await page2.screenshot({path:'/tmp/company-emails-restarted.png',animations:'disabled'});
 await page2.keyboard.press('Escape');
 assert.deepEqual(errors2,[]);
 console.log('Company username flow PASS: Sign in with Microsoft on signed-out Home and in the chooser, Username or Email identifier login, username chosen before the password with the probe\'s taken and policy refusals each keeping the player on step 1 and writing nothing, verified emails listed and chosen through the real main process with the save, the re-read, the clear, the no-email sentence and the refused address, the choice surviving a restart, exact request bodies, username displayed with no Company ID and no address in the state.');
}finally{await app.close();await new Promise(resolve=>stub.close(resolve));await fs.rm(home,{recursive:true,force:true});}