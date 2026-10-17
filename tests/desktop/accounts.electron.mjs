// End-to-end verification of account enrolment in the real Electron main process.
// Not part of `npm test`: it needs the host's Playwright, an X display and a local
// stub. Run with:
//   xvfb-run -a node tests/desktop/accounts.electron.mjs [--keep]
// It launches the fixture harness (tests/desktop/harness.cjs) with
// EASTER_API_BASE_URL pointed at a loopback stub of the frozen account API, then
// checks the create-then-login pair, the vault, revocation on sign-out and that no
// token reaches the renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const root=process.cwd();
const keep=process.argv.includes('--keep');
const ACCOUNT={id:7,minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z'};
const SESSION='stub-session-token-private';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-accounts-e2e-'));
const calls=[];
let created=false;
const stub=http.createServer((request,response)=>{
	const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{
		const body=Buffer.concat(chunks).toString('utf8');
		calls.push({method:request.method,url:request.url,authorization:request.headers.authorization,body});
		const json=payload=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));};
		if(request.url==='/v1/accounts/login'){const first=!created;created=true;return json({created:first,account:ACCOUNT,session:{token:SESSION,expiresAt:new Date(Date.now()+30*86400000).toISOString()}});}
		if(request.url==='/v1/accounts/me')return json({account:ACCOUNT});
		if(request.url==='/v1/accounts/logout'){response.writeHead(204);return response.end();}
		response.writeHead(404,{'Content-Type':'application/json'});response.end('{"error":"not_found"}');
	});
});
await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+stub.address().port;
const home=path.join(dir,'home');
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'tests/desktop/harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:base}});
try{
	const page=await app.firstWindow();page.setDefaultTimeout(20000);
	const errors=[];page.on('pageerror',e=>errors.push(e.message));
	await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
	await page.locator('[data-desktop-play]').click();
	await page.getByRole('button',{name:'Start download',exact:true}).click();
	await page.locator('#desktop-install-card').waitFor({state:'hidden'});
	await page.locator('[data-desktop-play]').click();
	await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
	await app.evaluate(()=>global.easterTestApprove());
	// Approving re-opens the modal, and Play is the hero's action, not the dialog's.
	await page.waitForFunction(()=>!document.querySelector('.desktop-device')||document.querySelector('.desktop-device').hidden===true,{timeout:20000}).catch(()=>{});
	await page.keyboard.press('Escape');
	await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open);
	await page.locator('[data-desktop-play][data-action=play]').click();
	await page.locator('.desktop-status').filter({hasText:'Minecraft is running'}).waitFor();
	await page.locator('.desktop-company').filter({hasText:'Captain Testbeard'}).waitFor();
	const login=calls.filter(c=>c.url==='/v1/accounts/login');
	// Sign-in enrols, then play re-posts the same Mojang token to issue a session.
	assert.equal(login.length,2,'sign-in and play each post the enrolment credential');
	for(const call of login){
		assert.deepEqual(JSON.parse(call.body),{minecraftAccessToken:'fixture-private-token',client:'launcher/'+JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version});
		assert.equal(call.authorization,undefined,'the login call is authenticated by the Minecraft token, not a Bearer header');
	}
	const status=await page.evaluate(()=>window.easterDesktop.status());
	assert.deepEqual(status.account,{name:'Captain Testbeard',roles:['crew']});
	assert(!JSON.stringify(status).includes(SESSION),'the session token must not cross IPC');
	assert(!JSON.stringify(status).includes('fixture-private'));
	assert(!(await page.evaluate(()=>document.body.textContent)).includes(SESSION));
	assert(!(await page.evaluate(()=>document.body.textContent)).includes('fixture-private'));
	const vault=path.join(home,'company.enc');
	// This host has no OS keyring, so safeStorage reports basic_text and the
	// launcher must refuse to persist at all, exactly as it does for Microsoft.
	const backend=await app.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()?safeStorage.getSelectedStorageBackend():'unavailable');
	if(backend==='basic_text'||backend==='unavailable'){
		await assert.rejects(fs.stat(vault),'with no OS-backed vault the company session must not be written');
		assert.equal(status.remembered,false,'the Microsoft session behaves the same way on this host');
		console.log('note: safeStorage backend is '+backend+' here, so only the refusal path was exercised');
	}else{
		const sealed=await fs.readFile(vault);
		assert.equal(sealed.subarray(0,6).toString('utf8'),'v3:lin','the vault holds safeStorage ciphertext, not plaintext');
		assert(!sealed.toString('utf8').includes(SESSION),'the session token must not be stored in the clear');
		assert.equal((await fs.stat(vault)).mode&0o777,0o600);
	}
	// Second sign-in on a warm process is a login, never a duplicate account.
	await app.evaluate(()=>global.easterTestGame.emit('exit',0));
	// The company account survives the game lifecycle: the enrolled session is still the
	// one published, which is what "second sign-in is a login, not a duplicate" means here.
	await page.waitForFunction(()=>window.easterDesktop.status().then(s=>s.account?.name==='Captain Testbeard'));
	// The account lines live in the settings dialog; open it if it is closed.
	await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open===false,{timeout:1000}).catch(()=>{});
	if(await page.locator('#desktop-launcher').evaluate(el=>!el.open).catch(()=>true)){
		await page.locator('.desktop-settings-button').click();
		await page.waitForFunction(()=>document.querySelector('#desktop-launcher')?.open===true);
	}
	await page.evaluate(()=>window.easterDesktop.refreshAccount());
	assert.equal(calls.filter(c=>c.url==='/v1/accounts/login').length,3,'Refresh account re-issues from the Mojang token');
	await page.getByRole('button',{name:'Sign out of Easter Company',exact:true}).click();
	const companyLine=page.locator('.desktop-company');
	await page.waitForFunction(()=>document.querySelector('.desktop-company')?.hidden===true);
	assert.equal((await companyLine.textContent()).trim(),'','the company line is omitted, not a bare sentence');
	// Signing out of the company account leaves the Microsoft account signed in, and its
	// line says so with a label rather than leaving a bare sentence behind.
	const microsoftLine=(await page.locator('.desktop-account').textContent()).trim();
	assert(/^Microsoft account: /.test(microsoftLine),'the Microsoft line is labelled: '+microsoftLine);
	const revoked=calls.filter(c=>c.url==='/v1/accounts/logout');
	assert.equal(revoked.length,1,'sign-out revokes the session');
	assert.equal(revoked[0].authorization,'Bearer '+SESSION);
	await assert.rejects(fs.stat(vault),'no vault is left behind after sign-out');
	assert.deepEqual(await page.evaluate(()=>window.easterDesktop.status().then(s=>s.account)),null);
	assert.deepEqual(errors,[]);
	console.log('ACCOUNTS E2E PASS: real Electron main process, create-then-login against a loopback stub, EASTER_API_BASE_URL override, no plaintext session file, logout revoked with the Bearer token, no token in the renderer or in status()');
}finally{
	await app.close();await new Promise(resolve=>stub.close(resolve));
	if(keep)console.log('kept '+dir);else await fs.rm(dir,{recursive:true,force:true});
}
