import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const fixtureOrigin=process.env.EASTER_FIXTURE_ORIGIN||'http://127.0.0.1:18796';
const home=await fs.mkdtemp('/tmp/company-identity-electron-');
await fs.writeFile(path.join(home,'settings.json'),JSON.stringify({memoryMB:4096,server:'127.0.0.1:25565',exitOnLaunch:false}));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/company-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_API_BASE_URL:fixtureOrigin,EASTER_IDENTITY_FIXTURE_SEED:String(Date.now())}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(18000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.keyboard.press('Escape');await page.setViewportSize({width:800,height:600});
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const approve=async()=>{await page.locator('.desktop-code').filter({hasText:'COMPANY-TEST'}).waitFor();await app.evaluate(()=>global.companyApprove());};
 await hero('signin').click();await page.locator('#desktop-company-signin').waitFor();await page.screenshot({path:'/tmp/company-signin.png',animations:'disabled'});
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();await approve();
 const usernameStep=page.locator('#desktop-company-username'),setup=page.locator('#desktop-company-password');
 await usernameStep.waitFor();let state=await status();assert.equal(state.account.username,null);assert(state.account.passwordRequired);assert.equal(state.canPlay,false);
 assert.equal(await setup.isVisible(),false,'the password step is not offered before the username');
 // The fixture keeps one database for the life of the process, so this journey must not
 // claim a name an earlier run of itself already holds: the second run would be refused by
 // the availability probe - correctly - and stall on step 1. One token per run keeps the
 // gate repeatable while every rule (3-20 chars of a-z 0-9 _ -) still applies.
 const runToken=Date.now().toString(36).slice(-6);
 const username='fixture_'+runToken,nonowner='nonowner_'+runToken;
 assert.match(username,/^[a-z0-9_-]{3,20}$/);assert.match(nonowner,/^[a-z0-9_-]{3,20}$/);
 await usernameStep.getByLabel('Username',{exact:true}).fill(username);
 await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();
 await setup.waitFor();
 await page.evaluate(()=>window.easterDesktop.play());assert.equal(await app.evaluate(()=>global.companyLaunches),0);
 await page.screenshot({path:'/tmp/company-password-setup.png',animations:'disabled'});
 await page.keyboard.press('Escape');await hero('setup-password').waitFor();assert.equal((await status()).canPlay,false);await hero('setup-password').click();
 await setup.waitFor();
 assert.equal((await setup.locator('.company-username').textContent()).trim(),'Your username: '+username);
 await setup.getByLabel('New password',{exact:true}).fill('fixture secret passphrase');await setup.getByLabel('Confirm password',{exact:true}).fill('different fixture passphrase');await setup.getByRole('button',{name:'Save password',exact:true}).click();
 await setup.locator('.company-error').filter({hasText:'do not match'}).waitFor();await setup.getByLabel('Confirm password',{exact:true}).fill('fixture secret passphrase');await setup.getByRole('button',{name:'Save password',exact:true}).click();
 // The new account is the launcher's one signed-in account. Until provider sign-in
 // (4341b90, launcher 1.0.23) this line asserted state.accounts.length === 1: the saved
 // Company account list that Switch Account read. That list, its switch-account IPC
 // handler and the menu that listed it were removed together — signing in while signed in
 // is now refused with "Sign out before signing in to a different account" — and the state
 // stopped advertising an accounts array at all. So what is asserted is the contract that
 // replaced it: state.account is the account the service just created, and no account list
 // is offered to a UI that could not act on a second entry.
 await hero('play').waitFor();state=await status();assert.equal(state.account.username,username);assert.equal(state.companyReady,true);assert.equal(state.microsoftConnected,true);
 assert.match(state.account.id,/^EC-\d+$/,'the state names the account the account service just created: '+state.account.id);
 assert.equal('accounts' in state,false,'the state carries no account list; the one signed-in account is state.account');
 await page.locator('.desktop-account-nav').click();const menu=await page.locator('.desktop-profile-menu').textContent();assert(menu.includes(username),'the account view names the username');assert(!menu.includes('EC-'),'and shows no Company ID');
 // The verified email the account service read from Microsoft, and the choice of which
 // address signs this account in. Everything here is the real handler's answer: the list,
 // the marked address and the two writes that clear and restore it.
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 const emailsPanel=page.locator('#desktop-company-emails');
 await emailsPanel.locator('input[name=email]').first().waitFor();
 const verifiedAddress=await emailsPanel.locator('input[name=email]').first().inputValue();
 assert.match(verifiedAddress,/^fixture-[a-f0-9]{16}@example\.com$/,'the account service reports the address it verified with Microsoft: '+verifiedAddress);
 assert.equal(await emailsPanel.locator('input[name=email]').count(),1,'one Microsoft address is verified until a second provider is linked');
 assert.equal(await emailsPanel.locator('input[name=email]').first().isChecked(),true,'and it is the login email');
 assert.equal((await emailsPanel.locator('.company-email-meta').first().textContent()).trim(),'Microsoft · signs you in');
 assert.equal(await emailsPanel.locator('.company-emails-empty').isVisible(),false,'no empty-state sentence beside a real address');
 await page.screenshot({path:'/tmp/company-verified-emails.png',animations:'disabled'});
 // Clearing the selection, then choosing the same address again.
 await emailsPanel.getByRole('button',{name:'Clear login email',exact:true}).click();
 await emailsPanel.locator('.company-status').filter({hasText:'cleared'}).waitFor();
 assert.equal(await emailsPanel.locator('input[name=email]').first().isChecked(),false);
 assert.equal(await emailsPanel.locator('.company-emails-unset').isVisible(),true,'an account with no selection is told which sign-in works');
 await emailsPanel.locator('input[name=email]').first().check();
 await emailsPanel.getByRole('button',{name:'Save selection',exact:true}).click();
 await emailsPanel.locator('.company-status').filter({hasText:'Your login email is saved.'}).waitFor();
 assert.equal(await emailsPanel.locator('input[name=email]').first().isChecked(),true);
 // Closed and reopened: the section asks the service again rather than remembering, and the
 // address it marked is the one the previous write left behind.
 await page.keyboard.press('Escape');await emailsPanel.waitFor({state:'hidden'});
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Verified emails',exact:true}).click();
 await emailsPanel.locator('input[name=email]').first().waitFor();
 await page.waitForFunction(()=>document.querySelector('#desktop-company-emails input[name=email]')?.checked===true);
 assert.equal(await emailsPanel.locator('input[name=email]').first().isChecked(),true,'the saved choice is read back from the account service');
 assert.equal(await page.locator('.desktop-profile-heading.desktop-email').textContent(),'Login email: '+verifiedAddress);
 await page.keyboard.press('Escape');await emailsPanel.waitFor({state:'hidden'});
 // No address appears in the launcher state: the account list, the switch and the skin keep
 // using the account id.
 assert(!JSON.stringify(await status()).includes('@example.com'),'the launcher state carries no email');
 await page.getByRole('link',{name:'Wiki',exact:true}).click();await page.locator('.wiki-card').first().waitFor();assert.equal((await status()).account.username,username);await page.getByRole('link',{name:'Home',exact:true}).click();await page.keyboard.press('Escape');
 await page.evaluate(()=>window.easterDesktop.signOut());await hero('signin').waitFor();
 async function passwordLogin(secret){await hero('signin').click();const dialog=page.locator('#desktop-company-signin');await dialog.getByLabel('Username or Email',{exact:true}).fill(username);await dialog.getByLabel('Password',{exact:true}).fill(secret);await dialog.getByRole('button',{name:'Sign in',exact:true}).click();}
 await passwordLogin('wrong fixture passphrase');await page.locator('#desktop-company-signin .company-error').filter({hasText:'incorrect'}).waitFor();assert.equal((await status()).account,null);
 await page.locator('#desktop-company-signin').getByLabel('Password',{exact:true}).fill('fixture secret passphrase');await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in',exact:true}).click();
 // The account was created by signing in with Microsoft earlier in this journey, and the account
 // service now stores that session (doc/launcher-states.md, "The Minecraft session the account
 // service holds"). So this password sign-in — the same account on another machine — is ready to
 // play with no Microsoft prompt of its own, and the account is applied either way: that is what
 // this step exists to catch.
 await hero('play').waitFor();
 assert.equal((await status()).account.username,username,'the password sign-in applies the account');
 assert.equal((await status()).microsoftAccount,null);
 assert.equal((await status()).minecraftSession.state,'server','and plays from the session the account service stores');
 assert.equal(await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),0,'with no Microsoft sign-in of its own');
 assert.equal((await hero('play').innerText()).includes('FixtureCaptain'),true,'and it names the Minecraft identity it will start');
 // Signing Minecraft out everywhere is what an account with nothing stored looks like, and it is
 // the honest hero this launcher had before the account service held anything: the same sentence
 // main used, with no claim about why the stored session is gone.
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 const profileDialog=page.locator('#company-profile');await profileDialog.waitFor();
 await profileDialog.getByRole('button',{name:'Sign out of Minecraft everywhere',exact:true}).click();
 await profileDialog.locator('.company-status').filter({hasText:'Signed Minecraft out everywhere.'}).waitFor();
 await page.keyboard.press('Escape');await profileDialog.waitFor({state:'hidden'});
 await hero('connect-microsoft').waitFor();
 const withoutSession=await hero('connect-microsoft').innerText();
 assert(withoutSession.replace(/\s+/g,' ').includes('Sign in with Microsoft Starts Minecraft as'),'a linked account with no stored session asks for the same sign-in main always asked for: '+withoutSession);
 assert.equal((await status()).canPlay,false,'and Play stays off until it is signed in again');
 await app.evaluate(()=>global.companyUser='2');await hero('connect-microsoft').click();await approve();await page.locator('.desktop-page-notice').waitFor();assert.equal((await status()).account.username,username);assert.equal((await status()).microsoftConnected,false,'wrong Microsoft account cannot replace Company identity');
 await page.getByRole('button',{name:'Dismiss message'}).click();await app.evaluate(()=>global.companyUser='1');await hero('connect-microsoft').click();await approve();await hero('play').waitFor();assert.equal((await status()).account.username,username);
 // Password recovery reauthenticates through a provider linked to this account. Until
 // provider sign-in (4341b90) the Reset password entry started the Microsoft sign-in
 // itself, which is what this journey used to wait for here; the product now opens the
 // provider chooser first, saying which providers this account has linked, and only the
 // linked ones are offered. That is the contract asserted below: only Microsoft is on
 // offer for an account whose only provider is Microsoft, and choosing it reauthenticates
 // and lands on "Reset your Easter Company password" without ever asking for the username.
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Reset password',exact:true}).click();
 const recovery=page.locator('#desktop-company-signin');await recovery.waitFor();
 assert.equal((await recovery.locator('.company-recovery-note').textContent()).trim(),'Choose a provider already linked to your account, then set a new Easter Company password.');
 assert.equal(await recovery.getByRole('button',{name:'Sign in with Microsoft',exact:true}).isVisible(),true,'the provider this account is linked to is offered');
 assert.equal(await recovery.locator('.company-provider[data-provider=google]').isVisible(),false,'and a provider it has not linked is not');
 await recovery.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();await approve();await setup.getByRole('heading',{name:'Reset your Easter Company password',exact:true}).waitFor();
 assert.equal(await setup.getByLabel('Username',{exact:true}).count(),0,'a password change never asks for the username');
 await setup.getByLabel('New password',{exact:true}).fill('replacement fixture passphrase');await setup.getByLabel('Confirm password',{exact:true}).fill('replacement fixture passphrase');await setup.getByRole('button',{name:'Save password',exact:true}).click();await hero('play').waitFor();
 assert.equal(await page.locator('input[type=password]').evaluateAll(inputs=>inputs.every(input=>input.value==='')),true);
 const surface=JSON.stringify(await status());for(const secret of ['fixture-xbox:','fixture-private','fixture secret passphrase','replacement fixture passphrase','microsoftSubject'])assert(!surface.includes(secret));
 await page.evaluate(()=>window.easterDesktop.signOut());await hero('signin').waitFor();
 await app.evaluate(()=>{global.companyUser='3';global.companyMode='missing';});
 await hero('signin').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();await approve();await usernameStep.waitFor();
 assert.equal((await status()).profile,null);assert((await status()).account.passwordRequired);
 await usernameStep.getByLabel('Username',{exact:true}).fill(nonowner);await usernameStep.getByRole('button',{name:'Continue',exact:true}).click();await setup.waitFor();
 await setup.getByLabel('New password',{exact:true}).fill('nonowner fixture passphrase');await setup.getByLabel('Confirm password',{exact:true}).fill('nonowner fixture passphrase');await setup.getByRole('button',{name:'Save password',exact:true}).click();await hero('buy').waitFor();
 assert.equal((await status()).companyReady,true);assert.equal((await status()).canPlay,false);await page.screenshot({path:'/tmp/company-nonowner.png',animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log('Company identity Electron PASS: real API and PostgreSQL signup with the username chosen before the password, username sign-in, wrong-provider rejection, matching Microsoft reconnect, password reset that never asks for the username, Wiki continuity, Play gate and no credential exposure.');
}catch(error){const page=await app.firstWindow();console.log(await page.evaluate(async()=>{const s=await window.easterDesktop.status();return {phase:s.phase,account:s.account,ready:s.companyReady,connected:s.microsoftConnected,error:s.error,dialogs:[...document.querySelectorAll('dialog[open]')].map(x=>x.id)};}));throw error;}
finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
