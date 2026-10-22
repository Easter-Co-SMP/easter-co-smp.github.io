import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const home=await fs.mkdtemp('/tmp/provider-account-electron-');
const env={...process.env,EASTER_VAULT_FIXTURE_KEY:randomBytes(32).toString('hex'),EASTER_TEST_HOME:home,EASTER_API_BASE_URL:'http://127.0.0.1:18797',EASTER_IDENTITY_FIXTURE_SEED:String(Date.now())};
const launch=()=>electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/provider-harness.cjs')],env});
let app=await launch();
try{
 let page=await app.firstWindow();page.setDefaultTimeout(18000);
 // Every condition on the launcher's own status is polled here. `page.waitForFunction`
 // resolves an async predicate without awaiting it (doc/releasing.md, "The provider journey
 // needs its own fixture"), so the two waits this journey used to make that way asserted
 // nothing at all; the bounded loop below fails loudly instead.
 const waitForStatus=async(predicate,what)=>{
  for(let attempt=0;attempt<60;attempt++){
   const snapshot=await page.evaluate(()=>window.easterDesktop.status());
   if(predicate(snapshot))return snapshot;
   await page.waitForTimeout(250);
  }
  throw Error('Timed out waiting for '+what+'.');
 };
 await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();
 const chooser=page.locator('#desktop-company-signin');
 await chooser.getByRole('button',{name:'Sign in with Discord',exact:true}).click();
 const username=page.locator('#desktop-company-username'),password=page.locator('#desktop-company-password');
 await username.waitFor();
 const name='fixture_'+Date.now().toString(36).slice(-7);
 await username.getByLabel('Username',{exact:true}).fill(name);
 await username.getByRole('button',{name:'Continue',exact:true}).click();
 await password.getByLabel('New password',{exact:true}).fill('provider fixture passphrase');
 await password.getByLabel('Confirm password',{exact:true}).fill('provider fixture passphrase');
 await password.getByRole('button',{name:'Save password',exact:true}).click();
 await password.waitFor({state:'hidden'});
 let state=await page.evaluate(()=>window.easterDesktop.status());
 assert.equal(state.account.username,name);assert.equal(state.companyReady,true);
 assert.equal(state.microsoftConnected,false);assert.equal(state.canPlay,false);assert.deepEqual(state.account.providers,['discord']);
 await page.locator('.desktop-account-nav').click();
 assert.equal(await page.getByRole('button',{name:'Add account',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Switch Account',exact:true}).count(),0);
 // Owen's two surfaces of 2026-10-22: My Profile holds the name and the picture, Linked
 // Accounts holds the provider rows. Neither holds the other's business.
 await page.getByRole('button',{name:'My Profile',exact:true}).click();
 const profile=page.locator('#company-profile');await profile.waitFor();
 assert.equal(await profile.getByRole('button',{name:/^Connect /}).count(),0,'My Profile offers no provider control');
 await profile.getByLabel('Display name',{exact:true}).fill('Independent fixture profile');
 await profile.getByRole('button',{name:'Save name',exact:true}).click();
 await profile.locator('.company-status').filter({hasText:'Saved.'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).account.name,'Independent fixture profile');
 const bitmap=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(new Uint8Array(16*16*4).fill(255),{width:16,height:16}).toPNG().toString('base64'));
 const pictureFile=home+'/fixture-avatar.png';await fs.writeFile(pictureFile,Buffer.from(bitmap,'base64'));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},pictureFile);
 await profile.getByRole('button',{name:'Choose picture',exact:true}).click();
 await waitForStatus(s=>s.account?.picture?.startsWith('data:image/png;base64,'),'the chosen picture to be stored');
 await profile.getByRole('button',{name:'Remove picture',exact:true}).click();
 await waitForStatus(s=>s.account?.picture===null,'the picture to be removed');
 await page.screenshot({path:'/tmp/provider-account-profile.png'});
 await profile.getByRole('button',{name:'Close My Profile',exact:true}).click();
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 const linkedAccounts=page.locator('#company-linked-accounts');await linkedAccounts.waitFor();
 assert.equal(await linkedAccounts.getByLabel('Display name',{exact:true}).count(),0,'Linked Accounts carries nothing about the profile');
 await linkedAccounts.getByRole('button',{name:'Connect Google',exact:true}).click();
 await linkedAccounts.getByText('Google · linked',{exact:true}).waitFor();
 state=await page.evaluate(()=>window.easterDesktop.status());assert.deepEqual(state.account.providers,['discord','google']);
 assert.equal(state.account.primaryProvider,'discord');
 await linkedAccounts.getByRole('button',{name:'Close Linked Accounts',exact:true}).click();
 // Restart the actual process with the synthetic encrypted vault and restore the session.
 await app.close();app=await launch();page=await app.firstWindow();page.setDefaultTimeout(18000);
 // The header shows the name the player chose for themselves, which this account set to
 // "Independent fixture profile" above; the username stays the sign-in identifier.
 await page.keyboard.press('Escape');await page.locator('.desktop-account-nav').filter({hasText:'Independent fixture profile'}).waitFor();
 state=await page.evaluate(()=>window.easterDesktop.status());assert.equal(state.account.username,name);
 assert.deepEqual(state.account.providers,['discord','google']);
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.locator('.desktop-account-nav').click();
 await page.locator('#desktop-company-signin').getByLabel('Username or Email',{exact:true}).fill(name);
 await page.locator('#desktop-company-signin').getByLabel('Password',{exact:true}).fill('provider fixture passphrase');
 await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in',exact:true}).click();
 await page.locator('.desktop-account-nav').filter({hasText:'Independent fixture profile'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).account.username,name);
 // The account view keeps the username as the secondary sign-in line, so signing in with it
 // still shows which handle the player typed.
 await page.locator('.desktop-account-nav').click();
 assert.equal(await page.locator('.desktop-profile-heading.desktop-account .desktop-account-signin').innerText(),name,'the account view prints the bare username under the display name, with no prefix (Owen, 2026-10-22)');
 await page.keyboard.press('Escape');
 // Signing up and signing in are one flow: the button that created this account has to put a
 // returning player back into it, with no second account and no setup step asked twice. The
 // fixture derives the provider subject from the code, so this second Discord sign-in IS the
 // same person as the one who signed up at the top of this journey.
 const returningId=(await page.evaluate(()=>window.easterDesktop.status())).account.id;
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.locator('.desktop-account-nav').click();
 await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in with Discord',exact:true}).click();
 const returning=await waitForStatus(s=>s.account?.id===returningId,'the returning Discord sign-in to land in the account it is linked to');
 assert.equal(returning.account.username,name,'and it is the account whose username was already chosen');
 assert.deepEqual(returning.account.providers,['discord','google'],'the links are unchanged by signing in again');
 assert.equal(await page.locator('#desktop-company-username').isVisible(),false,'a returning sign-in never asks for the username again');
 assert.equal(await page.locator('#desktop-company-password').isVisible(),false,'a returning sign-in never asks for a password again');
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'and it reports no failure');
 // A forgotten password has no reset and no recovery chooser (Owen, 2026-10-22): the route is
 // to sign in with a linked account, which this journey has just done, and change it in My
 // Profile. The chooser says that in one sentence where the recovery link used to be.
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.locator('.desktop-account-nav').click();
 const signedOutChooser=page.locator('#desktop-company-signin');await signedOutChooser.waitFor();
 assert.equal(await signedOutChooser.getByRole('button',{name:'Forgot your password?',exact:true}).count(),0,'the chooser offers no password recovery');
 assert.equal((await signedOutChooser.locator('.company-no-reset').textContent()).trim(),'If you have forgotten your password there is no reset: sign in with a linked account, then change the password in My Profile.');
 await signedOutChooser.getByRole('button',{name:'Sign in with Discord',exact:true}).click();
 await page.locator('.desktop-account-nav').filter({hasText:'Independent fixture profile'}).waitFor();
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'My Profile',exact:true}).click();
 const reset=page.locator('#company-profile');await reset.waitFor();
 await reset.getByLabel('New password',{exact:true}).fill('replacement provider fixture passphrase');
 await reset.getByLabel('Confirm password',{exact:true}).fill('replacement provider fixture passphrase');
 await reset.getByRole('button',{name:'Change password',exact:true}).click();
 await reset.locator('.company-status').filter({hasText:'Your password is changed.'}).waitFor();
 await reset.getByRole('button',{name:'Close My Profile',exact:true}).click();
 console.log('PASS: Discord signup, mandatory username/password, signing in again with the same linked Discord identity lands in that same account with no second setup and no second account, Google linking on Linked Accounts, profile name and avatar editing on My Profile, encrypted fixture restart persistence, password login, and a password change in My Profile with the chooser offering no recovery; Minecraft access remains gated.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
