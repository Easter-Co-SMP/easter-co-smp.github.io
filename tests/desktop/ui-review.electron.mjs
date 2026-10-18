import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'launcher-ui-'));
const images=process.env.EASTER_REVIEW_IMAGES||'/tmp/launcher-ui-after';
await fs.mkdir(images,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),
 args:['--no-sandbox',path.resolve('tests/desktop/deslop-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_TEST_TRAY:'0'}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');await page.keyboard.press('Escape');
 const shot=async(name)=>page.screenshot({path:path.join(images,name+'.png'),animations:'disabled'});
 for(const [width,height] of [[1360,920],[800,600]]){
  await page.setViewportSize({width,height});await shot('first-run-'+width);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Home fits window');
 }
 await page.setViewportSize({width:1360,height:920});
 const initial=await page.evaluate(()=>window.easterDesktop.status());
 const send=state=>app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('launcher:state',state),state);
 await send({...initial,phase:'downloading',actions:['pause','signin'],bar:{visible:true},progress:{label:'Downloading client files',percent:47,bytesDone:470000000,bytesTotal:1000000000,bytesPerSecond:12000000,etaSeconds:44}});
 await shot('downloading');
 await send({...initial,phase:'error',message:'The download was interrupted. Check your connection and try again.',actions:['download']});
 await shot('error');
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),true,'operation errors are visible on Home');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'errors do not open unrelated settings');
 await send(initial);
 await page.locator('[data-desktop-play][data-action=download]').click();
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 await app.evaluate(()=>global.easterTestDelayDevice=true);
 await page.locator('[data-desktop-play][data-action=signin]').click();await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
 await page.locator('.desktop-auth-wait').waitFor();await shot('sign-in-pending');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'pending authentication never flashes settings');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'pending authentication cancels cleanly');
 await page.locator('[data-desktop-play][data-action=signin]').click();await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
 await page.locator('.desktop-auth-wait').waitFor();
 await app.evaluate(()=>{global.easterTestDeviceReady();global.easterTestDelayDevice=false;});
 await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();await shot('sign-in');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'sign-in never displays settings');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'cancellation is not an error');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'cancellation does not reveal settings');
 await page.locator('[data-desktop-play][data-action=signin]').click();await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();
 await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 assert.equal(await page.locator('#launcher-bar').isVisible(),false,'one Play entry point on Home');
 for(const [width,height] of [[1360,920],[800,600]]){
  await page.setViewportSize({width,height});await shot('ready-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await app.evaluate(()=>global.easterTestFailPlay=true);
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('.desktop-page-notice').waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'Unable to start Minecraft. Try again.','main publishes a safe typed failure');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'a failed launch does not open settings');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'failure notice can be dismissed');
 await app.evaluate(()=>global.easterTestFailPlay=false);
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false});});
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await app.evaluate(()=>global.easterTestGame.emit('error',new Error('fixture child failure')));
 await page.locator('.desktop-page-notice').filter({hasText:'Minecraft could not start'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'Minecraft could not start. Check Java and try again.','asynchronous game failure remains visible');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 const ready={...await page.evaluate(()=>window.easterDesktop.status()),error:null};
 await send({...ready,phase:'running'});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await shot('settings');
 await page.setViewportSize({width:800,height:600});await shot('settings-800');
 assert(await page.locator('#desktop-launcher').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'default settings fit compact window');
 await page.setViewportSize({width:1360,height:920});
 assert.equal(await page.locator('.desktop-settings').evaluate(el=>el.inert),false,'settings stay usable while playing');
 for(const input of await page.locator('.desktop-preference input').all()){
  assert(await input.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.previousElementSibling.getBoundingClientRect();return a.x>b.right&&Math.abs(a.y+a.height/2-b.y-b.height/2)<3;}),'switch aligns beside its label');
 }
 await page.locator('select[name=serverSelect]').selectOption('__custom__');
 await page.locator('input[name=server]').fill('keyboard.example:25565');
 await page.locator('input[name=server]').press('Enter');
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).settings.server,'keyboard.example:25565','Enter saves settings');
 // Owen's two linked launch behaviours: both off by default, and never both on.
 const exitToggle=page.locator('input[name=exitOnLaunch]');
 const trayToggle=page.locator('input[name=trayOnLaunch]');
 assert.equal(await exitToggle.isChecked(),false,'a fresh launcher does not close behind the game');
 assert.equal(await trayToggle.isChecked(),false,'and does not minimise to the tray either');
 await trayToggle.check();
 assert.equal(await exitToggle.isChecked(),false,'ticking the tray leaves close off');
 await exitToggle.check();
 assert.equal(await trayToggle.isChecked(),false,'ticking close unticks the tray');
 await trayToggle.check();
 assert.equal(await exitToggle.isChecked(),false,'ticking the tray unticks close again');
 await page.locator('[data-save-settings]').click();
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 const traySaved=(await page.evaluate(()=>window.easterDesktop.status())).settings;
 assert.equal(traySaved.trayOnLaunch,true,'the tray choice round-trips through the main process');
 assert.equal(traySaved.exitOnLaunch,false,'with the other one off');
 assert.equal(JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8')).trayOnLaunch,true,'and is written to the settings file');
 // The dialog fills itself from the status broadcast, so reopening shows the saved pair.
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 assert.equal(await trayToggle.isChecked(),true,'the saved tray choice is read back into the dialog');
 assert.equal(await exitToggle.isChecked(),false);
 await exitToggle.check();
 await page.locator('[data-save-settings]').click();
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 const closeSaved=(await page.evaluate(()=>window.easterDesktop.status())).settings;
 assert.equal(closeSaved.exitOnLaunch,true,'the close choice round-trips too');
 assert.equal(closeSaved.trayOnLaunch,false,'and clears the tray choice in the main process');
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:false});});
 await page.locator('.desktop-advanced summary').click();await shot('settings-advanced');
 await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();await shot('profile');
 for(const action of await page.locator('[data-profile-action]:visible').all())assert(await action.isDisabled(),'account changes disabled while game runs');
 await page.keyboard.press('Escape');await send(ready);
 await page.getByRole('link',{name:'Wiki',exact:true}).click();await page.locator('.wiki-card').first().waitFor();await shot('wiki');
 assert.equal(await page.locator('#launcher-bar').isVisible(),true,'idle action stays available on Wiki');
 await send({...ready,error:'Unable to start Minecraft. Try again.'});
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),true,'utility pages show failures');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'utility failures do not open settings');
 // The launch-time pair, honestly. Main is told by EASTER_TEST_TRAY=0 that this desktop
 // has no status-notifier host, which is the state of the test seat, of a bare X session
 // and of Owen's own i3/polybar seat: polybar's tray is XEmbed, so no watcher owns the
 // StatusNotifier name and an Electron tray icon would never be drawn there.
 const windowVisible=()=>app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()));
 const waitVisible=async(wanted,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   if(await windowVisible()===wanted)return;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('timed out waiting for the window to '+(wanted?'come back':'step aside')+' ('+label+')');
 };
 const waitStatus=async(predicate,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   const status=await page.evaluate(()=>window.easterDesktop.status());
   if(predicate(status))return status;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('timed out waiting for '+label);
 };
 await page.getByRole('link',{name:'Home',exact:true}).click();
 await page.locator('[data-desktop-play]').waitFor();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 assert.equal(await windowVisible(),true,'the launcher is on screen before the game starts');
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await waitVisible(false,'the no-tray path');
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'This desktop has no system tray, so start Easter Co. Launcher again to bring the window back.','one sentence says why the window went and how to bring it back, rather than the setting quietly doing nothing');
 // Starting the launcher again is the way back, and it is the same second-instance path
 // the game shortcut uses.
 await app.evaluate(({app})=>app.emit('second-instance',{},[],process.cwd()));
 await waitVisible(true,'a second instance');
 assert.equal(await page.evaluate(()=>document.visibilityState!=='hidden'),true,'the page is live again once the window is shown');
 // The sentence the player needs is on screen the moment they get back, not only in state.
 assert.equal(await page.locator('.desktop-page-notice').filter({hasText:'no system tray'}).isVisible(),true,'the way back is stated where the player can read it');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 const closed=await waitStatus(status=>status.message==='Minecraft closed. Ready to play.','the game exit to settle');
 assert.equal(closed.error,null,'the exit handler still settles its own message, not an error');
 assert.equal(await windowVisible(),true,'and the launcher window is on screen for the next launch');
 await shot('no-tray-host');
 // And the tray path itself. Electron creates a Tray object on this seat — the icon has
 // nowhere to be drawn, which is why the probe above is what decides — so telling main a
 // host exists exercises the real hide: the window goes away while the game runs and
 // comes back by itself when the game ends, with the exit message it always settles.
 await app.evaluate(()=>{process.env.EASTER_TEST_TRAY='1';});
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await waitVisible(false,'the tray path');
 const inTray=await page.evaluate(()=>window.easterDesktop.status());
 assert.equal(inTray.phase,'running','the game is still running while the launcher sits in the tray');
 assert.equal(inTray.error,null,'a desktop with a real tray needs no do-it-yourself sentence');
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 await waitVisible(true,'the game exit');
 const restored=await waitStatus(status=>status.message==='Minecraft closed. Ready to play.','the exit to settle after the tray');
 assert.equal(restored.error,null,'the exit message is the same one, with the launcher back on screen');
 await shot('tray-restored');
 assert.deepEqual(errors,[]);
 console.log('Launcher UI state review PASS: first run, transfer, failure, sign-in, ready, settings, both linked launch behaviours, the no-tray hide and its way back, the tray path, profile, wiki.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
