import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-deslop-'));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/deslop-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:temp}});
try{
 const page=await app.firstWindow();await page.setViewportSize({width:1360,height:920});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');await page.keyboard.press('Escape');
 assert.equal(await page.locator('.desktop-account-nav:visible').textContent(),'Sign in');
 // The header already carries Map, so the hero carries no second route to it, and no
 // screen offers the same action twice.
 assert.equal(await page.getByRole('link',{name:'View Map',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:/^(download the game|start download|install the game)\b/i}).count(),1,'one download action per screen');
 assert.equal(await page.getByRole('button',{name:'Settings',exact:true}).count(),0,'Settings is offered only at the Play Now stage');
 await page.evaluate(()=>window.easterDesktop.startInstall({}));
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 const signIn=async()=>{
  await page.evaluate(()=>{window.pending=window.easterDesktop.signIn().catch(e=>e.message);});
  await page.waitForFunction(async()=>Boolean((await window.easterDesktop.status()).device));
  await app.evaluate(()=>global.easterTestApprove());await page.evaluate(()=>window.pending);
 };
 await signIn();await page.locator('[data-desktop-play][data-action=play]').waitFor();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.keyboard.press('Escape');
 // A launcher update check withholds Settings, and a check that starts while the dialog
 // is open closes it (Owen's decision of 2026-10-17). Nothing else is gated: the real
 // main process is told to broadcast `checking` on the state channel it already uses.
 const sendState=payload=>app.evaluate(({BrowserWindow},next)=>BrowserWindow.getAllWindows()[0].webContents.send('launcher:state',next),payload);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.locator('#desktop-launcher').waitFor({state:'visible'});
 await sendState({launcherUpdate:{phase:'checking',version:null,url:null,message:null}});
 await page.waitForFunction(()=>document.querySelector('.desktop-settings-button')?.hidden===true,null,{timeout:15000});
 assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),false,'a check closes the settings dialog');
 assert.equal(await page.locator('.hero-copy h1').count(),0,'the launcher carries no marketing headline');
 // The map is still reachable and the game controls still work: only Settings waits.
 assert.equal(await page.getByRole('link',{name:'Map',exact:true}).isVisible(),true,'the check gates Settings only');
 await sendState({launcherUpdate:{phase:'current',version:'1.0.7',url:null,message:null}});
 await page.waitForFunction(()=>document.querySelector('.desktop-settings-button')?.hidden===false,null,{timeout:15000});
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),true,'the dialog is offered again once the check settles');
 await page.keyboard.press('Escape');
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).canPlay,true);
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav canvas').getContext('2d').getImageData(16,16,1,1).data[0]===200);
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Add account',exact:true}).click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.waitForFunction(async()=>Boolean((await window.easterDesktop.status()).device));
 await page.evaluate(()=>window.easterDesktop.cancelSignIn());
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).device===null);
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).profile.name,'Captain1');
 await page.keyboard.press('Escape');await signIn();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).accounts.length,2);
 await page.locator('.desktop-account-nav').click();await page.waitForTimeout(250);await page.screenshot({path:'/tmp/easter-deslop-profile.png'});await page.getByRole('button',{name:'Switch Account',exact:true}).click();
 await page.getByRole('button',{name:'captain1',exact:true}).click();
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).profile?.name==='Captain1');
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Logout',exact:true}).click();
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).profile===null);
 const state=await page.evaluate(()=>window.easterDesktop.status());assert.equal(state.install.installed,true);assert.deepEqual(state.actions,['signin']);assert.equal(state.accounts.length,1);
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 await page.screenshot({path:'/tmp/easter-deslop-home.png'});
 assert.deepEqual(errors,[]);console.log('PASS: install → sign in → Play Now; cancelled add; add/switch/logout; Settings; profile visibility');
}finally{await app.close();await fs.rm(temp,{recursive:true,force:true});}
