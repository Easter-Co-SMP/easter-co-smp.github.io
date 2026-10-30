import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The pill's face belongs to the shared account control now, which paints the picture - or the head
// it crops from the skin, or the letter tile - into a 32px slot as an <img>. Reading a pixel off it
// means drawing that image into an offscreen 32x32 canvas first; the crop behind it is the same
// 8x8-at-8,8 plus hat-at-40,8 arithmetic the window's own canvas used.
const FACE_PIXEL='(()=>{const slot=document.querySelector(".desktop-account-nav .web-account-face");if(!slot)return null;const canvas=document.createElement("canvas");canvas.width=32;canvas.height=32;const context=canvas.getContext("2d");context.imageSmoothingEnabled=false;const image=slot.querySelector("img.web-account-picture");if(image&&!image.hidden&&image.complete&&image.naturalWidth){context.drawImage(image,0,0,32,32);}else{const style=getComputedStyle(slot);context.fillStyle=style.backgroundColor;context.fillRect(0,0,32,32);const letter=((slot.querySelector(".web-account-initial")||{}).textContent||"").trim();if(letter){context.fillStyle=style.color;context.font="bold 20px sans-serif";context.textAlign="center";context.fillText(letter,16,24);}}return [...context.getImageData(2,2,1,1).data];})()';
// The copy rules that keep slop out of the launcher, on the one-account model.
//
// What this journey protected is unchanged: no screen offers the same action twice, the
// header (not the hero) carries Map, Settings is offered only once there is a client to
// configure, a launcher update check withholds Settings and closes its dialog, and every
// wait or failure is written once. What changed is the account half. Provider sign-in
// (4341b90, launcher 1.0.23) removed the saved Company account list, its Switch Account IPC
// handler and the Add/Switch Account entries, so this journey no longer adds an account,
// cancels an add, switches between two accounts or counts them: the launcher has exactly one
// signed-in account (state.account), the header names it, and signing out is the only way to
// change it. A second account in the menu would be the design coming back, which is what the
// two count assertions below refuse. The picture path itself (an account's own upload, and
// its removal) is asserted in providers.electron.mjs.
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-deslop-'));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/deslop-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:temp}});
try{
 const page=await app.firstWindow();await page.setViewportSize({width:1360,height:920});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');await page.keyboard.press('Escape');
 assert.equal(await (await page.locator('.desktop-account-nav:visible .web-account-name').textContent()).trim(),'Sign in');
 // The header already carries Map, so the hero carries no second route to it, and no
 // screen offers the same action twice.
 assert.equal(await page.getByRole('link',{name:'View Map',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:/^(download the game|start download|install the game)\b/i}).count(),1,'one download action per screen');
 assert.equal(await page.getByRole('button',{name:'Settings',exact:true}).count(),0,'Settings is offered only at the Play Now stage');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
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
 assert.equal((await status()).canPlay,true);
 // The header names the one signed-in account and paints its avatar. This account has no
 // uploaded picture but does have a Minecraft skin, so what is painted is its own character's
 // head, drawn from the skin the launcher already holds (1.0.31, Owen's easter egg). The
 // fixture skin's face is rgb(200,130,90) and its hat layer is transparent, so that colour at
 // the centre of the 32px canvas is the head and not the letter tile. The full precedence -
 // picture, then head, then the initial as the last resort, and the tile only when there is
 // neither - is asserted pixel by pixel in tests/identity-browser.mjs.
 await page.waitForFunction(expression=>{const pixels=eval(expression);return Boolean(pixels)&&pixels[3]===255&&pixels[0]===200&&pixels[1]===130&&pixels[2]===90;},FACE_PIXEL,{timeout:15000});
 let state=await status();
 assert.equal(state.account.username,'captain1','the header names the account that is signed in');
 assert.equal(state.account.picture,null,'this account has no picture, so the header paints its initial');
 assert.equal('accounts' in state,false,'one signed-in account: the state carries no account list');
 await page.locator('.desktop-account-nav').click();
 const menu=page.locator('.desktop-profile-menu');
 assert.equal(await menu.getByRole('button',{name:'Add account',exact:true}).count(),0,'nothing offers a second account');
 assert.equal(await menu.getByRole('button',{name:'Switch Account',exact:true}).count(),0,'switching accounts left with the account list');
 assert.equal(await menu.getByRole('button',{name:'Sign out',exact:true}).count(),1,'the one account can be signed out');
 await page.waitForTimeout(250);await page.screenshot({path:'/tmp/easter-deslop-profile.png'});
 await menu.getByRole('button',{name:'Sign out',exact:true}).click();
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).profile===null);
 state=await status();assert.equal(state.install.installed,true);assert.deepEqual(state.actions,['signin']);assert.equal(state.account,null);assert.equal('accounts' in state,false);
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 assert.equal(await (await page.locator('.desktop-account-nav:visible .web-account-name').textContent()).trim(),'Sign in','signing out returns the header to its signed-out copy');
 await page.screenshot({path:'/tmp/easter-deslop-home.png'});
 assert.deepEqual(errors,[]);console.log('PASS: install → sign in → Play Now; one-account header and menu; Settings; launcher-update gating; logout; no duplicate copy');
}finally{await app.close();await fs.rm(temp,{recursive:true,force:true});}
