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
// The Microsoft account's email exists on the server side and must never reach the client.
const EMAIL='player@example.test';
const SESSION='fixture-company-private-session';
const VERSION=JSON.parse(await fs.readFile(path.resolve('package.json'),'utf8')).version;
const SECRET='fixture secret passphrase';
const calls=[];
// Accounts the server owns. A brand new Microsoft signup has no username yet.
const account={id:7,username:null,minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:true,microsoftLinked:true,microsoftSubject:SUBJECT};
const PROBE_TAKEN='taken_captain',PROBE_FREE='captain_test',RACE_LOST='racer';
const document=()=>({...account,email:EMAIL});
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:request.url,method:request.method,authorization:request.headers.authorization,body});
  const json=(payload,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  const error=(status,code)=>json({error:code,detail:'server detail that must never surface'},status);
  const signed=created=>json({created,account:document(),session:{token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  if(request.url==='/v2/accounts/microsoft')return signed(true);
  if(request.url==='/v2/accounts/username/available'){
   if(body.username===PROBE_TAKEN)return json({available:false,reason:'username_taken',email:EMAIL});
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
  if(request.url==='/v2/accounts/me')return json({account:document()});
  if(request.url==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const home=await fs.mkdtemp(path.join(os.tmpdir(),'company-username-e2e-'));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:'+stub.address().port}});
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
 assert.match(heroText,/Link Microsoft Account/,'the signed-out Home action links the Microsoft account: '+heroText);
 assert(!/Sign in/.test(heroText),'the signed-out Home action no longer reads Sign in');
 assert(!/Easter Company account/.test(heroText),'and carries no Easter Company account note');
 await hero.click();
 const chooser=page.locator('#desktop-company-signin');await chooser.waitFor();
 assert.equal(await chooser.getByRole('button',{name:'Login with Microsoft Account',exact:true}).count(),1);
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
 await chooser.getByRole('button',{name:'Login with Microsoft Account',exact:true}).click();
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
 // 3. A taken username is a plain sentence on step 1, and the player stays there.
 await usernameStep.getByLabel('Username',{exact:true}).fill(PROBE_TAKEN);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 await usernameStep.locator('.company-error').filter({hasText:'already taken'}).waitFor();
 assert.equal((await usernameStep.locator('.company-error').textContent()).trim(),'That username is already taken. Try another.');
 assert.equal(await passwordStep.isVisible(),false,'a taken username does not advance to the password');
 assert.equal(await usernameStep.isVisible(),true);
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
 assert.deepEqual(probeBodies,[{username:PROBE_TAKEN},{username:RACE_LOST},{username:PROBE_FREE}]);
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
 assert(!menu.includes(EMAIL),'the profile menu shows no email');
 await page.screenshot({path:'/tmp/company-username-profile.png',animations:'disabled'});
 await page.keyboard.press('Escape');
 const surface=JSON.stringify(await status())+await page.locator('body').textContent();
 for(const secret of [EMAIL,'example.test',SESSION,'microsoftSubject'])assert(!surface.includes(secret),'the renderer surface carries no '+secret);
 // The opaque account handle stays in state because the account menu switches on it, but
 // nothing on screen may show a Company ID to the player.
 assert(!(await page.locator('body').textContent()).includes('EC-'),'no Company ID is displayed anywhere on the launcher');
 assert(!JSON.stringify(calls).includes(EMAIL),'no request the launcher sent carries the email');
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
 console.log('Company username flow PASS: Link Microsoft Account on signed-out Home, Login with Microsoft Account copy, Username or Email identifier login, username chosen before the password with taken-name messages, exact request bodies, username displayed with no Company ID and no email.');
}finally{await app.close();await new Promise(resolve=>stub.close(resolve));await fs.rm(home,{recursive:true,force:true});}