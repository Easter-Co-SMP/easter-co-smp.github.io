// Company account transport/vault verification. Full password journey is in company.electron.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const ACCOUNT={id:7,username:'captaintestbeard',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:'cc75443d8979fe5cdbdf2de55b822ec8b63bc55348c2e451b46b19f4746885ca'};
const SESSION='fixture-company-private-session',calls=[];
const stub=http.createServer((request,response)=>{
 const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({path:request.url,authorization:request.headers.authorization,body});
  const json=payload=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
  if(request.url==='/v2/accounts/microsoft')return json({created:false,account:ACCOUNT,session:{token:SESSION,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  if(request.url==='/v2/accounts/me')return json({account:ACCOUNT});
  if(request.url==='/v2/accounts/logout'){response.writeHead(204);response.end();return;}
  response.writeHead(404);response.end();
 });
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const home=await fs.mkdtemp('/tmp/company-vault-e2e-');
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:'+stub.address().port}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.keyboard.press('Escape');
 await page.locator('[data-desktop-play][data-action=download]').click();await page.locator('[data-desktop-play][data-action=signin]').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});await app.evaluate(()=>global.easterTestApprove());await page.locator('[data-desktop-play][data-action=play]').waitFor();
 const state=await page.evaluate(()=>window.easterDesktop.status());
 // The exact public shape of the account the renderer receives, and nothing else: no token,
 // no Microsoft subject, no email. Provider sign-in (4341b90) added the three fields at the
 // end of this object — the linked providers, which one signs the player in, and the picture
 // data URI — and the account was deep-equal to the shorter object only until then. The
 // linked-provider details now add minecraftName and providerDetails (null when no
 // provider-owned details were returned). The allowlist stays exact.
 //
 // `skin` is the fifth of those fields (e5563ba, "Carry the account's whole skin texture
 // to the page, on the picture's terms"): the player's own texture, admitted by
 // desktop/accounts.cjs:254 on the picture's rules — a PNG data URI and nothing else.
 // That commit moved tests/desktop/accounts.test.cjs:175 and this allow-list together,
 // and missed only this journey, which is where 1.0.50's release cut stopped: the whole
 // difference was `+ skin: null`. Keep the two objects identical — a field added to
 // accounts.cjs's publicAccount gets added here in the same commit.
 assert.deepEqual(state.account,{id:'EC-7',username:'captaintestbeard',name:'Captain Testbeard',minecraftName:'TestCaptain',roles:['crew'],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],primaryProvider:'microsoft',providerDetails:null,picture:null,skin:null});
 assert(state.canPlay&&state.microsoftConnected);
 const request=calls.find(call=>call.path==='/v2/accounts/microsoft');
 assert.equal(request.body.xboxUserToken,'fixture-xbox:1234567890abcdef1234567890abcdef');assert.equal(request.authorization,undefined);assert(!('minecraftAccessToken' in request.body));
 const surface=JSON.stringify(state)+(await page.locator('body').textContent());assert(!surface.includes(SESSION));assert(!surface.includes('fixture-private'));assert(!surface.includes('microsoftSubject'));
 const backend=await app.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()?safeStorage.getSelectedStorageBackend():'unavailable');
 const vault=path.join(home,'company.enc');
 if(['basic_text','unavailable'].includes(backend)){await assert.rejects(fs.stat(vault));assert.equal(state.remembered,false);}
 else{const bytes=await fs.readFile(vault);assert(!bytes.toString().includes(SESSION));assert.equal((await fs.stat(vault)).mode&0o777,0o600);}
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 const loggedOut=await page.evaluate(()=>window.easterDesktop.status());assert.equal(loggedOut.account,null);assert.equal(loggedOut.profile,null);assert(!loggedOut.canPlay);
 assert(calls.some(call=>call.path==='/v2/accounts/logout'&&call.authorization==='Bearer '+SESSION));
 console.log('Company account transport/vault PASS: verified proof path, Company primary state, no credentials in renderer, secure-storage behavior and primary logout/revocation.');
}finally{await app.close();await new Promise(resolve=>stub.close(resolve));await fs.rm(home,{recursive:true,force:true});}
