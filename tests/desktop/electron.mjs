import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-electron-test-'));
const run=async(entry,exercise,manageArrival)=>{
 const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',entry],env:{...process.env,EASTER_TEST_HOME:temp}});
 try{const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  const arriving=await page.evaluate(()=>document.body.classList.contains('is-arriving'));
  if(!manageArrival)await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  await exercise(app,page,arriving);assert.deepEqual(errors,[]);}finally{await app.close();}
};
// The Skip intro control must not exist in the desktop DOM at all, and the arrival must still be
// skippable and bounded without it. Separate fresh sessions prove Escape and the timer;
// reloading the same session must not replay the arrival.
const noSkipControl=async page=>{
 assert.equal(await page.locator('.skip-arrival').count(),0);
 assert.equal(await page.getByRole('button',{name:'Skip intro'}).count(),0);
};
const arrival=async()=>await run(path.join(root,'desktop/main.cjs'),async(app,page,arriving)=>{
 // Absence is a DOM fact, so it is asserted while the arrival is still running, not only after it ends.
 await noSkipControl(page);
 assert(arriving,'the desktop home plays the bounded arrival');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
 // The opening belongs to this window session, so a reload must not replay it.
 await page.reload();
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.body.classList.contains('is-arriving')),false,'reload keeps the completed arrival');
 await noSkipControl(page);
},true);
try{
 await arrival();
 // A new launcher window gets its own opening, which must end within its bound.
 await run(path.join(root,'desktop/main.cjs'),async(app,page,arriving)=>{
  assert(arriving,'a fresh launcher window plays the arrival');
  await noSkipControl(page);
  await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'),{},{timeout:6500});
  await noSkipControl(page);
 },true);
 await run(path.join(root,'desktop/main.cjs'),async(app,page)=>{
  // Settings is the hero's secondary action, and the header has no client settings
  // button at all. With nothing installed yet, Settings is not offered.
  assert.equal(await page.locator('.site-header .desktop-settings-button').count(),0,'the header carries no client settings button');
  assert.equal(await page.locator('.site-header').getByRole('button',{name:'Settings',exact:true}).count(),0,'and no settings button is placed in the header nav');
  assert.equal(await page.locator('.site-header .map-link').count(),0,'the header stays account-only');
  // Owen's decision of 2026-10-17: the launcher keeps the crest and the small eyebrow and
  // does not carry the website's headline.
  assert.equal(await page.locator('.hero-copy h1').count(),0,'the launcher carries no marketing headline');
  assert.equal(await page.getByRole('heading',{name:/The Ultimate/i}).count(),0,'and no heading that repeats it elsewhere on Home');
  assert.equal(await page.locator('.hero-copy .eyebrow').count(),1,'the small Easter Co. SMP eyebrow stays');
  assert.equal(await page.locator('.crest-frame img').isVisible(),true,'and so does the crest');
  // One screen carries one action: the hero's own Download the game. The details beside
  // it say where the client installs and carry no second download button.
  const installDetails=page.locator('#desktop-install-details');
  await installDetails.waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:/^(download the game|start download|install the game)\b/i}).count(),1,'the first run offers exactly one download action');
  assert.equal(await page.getByRole('button',{name:/^start download$/i}).count(),0,'no second download button exists on Home');
  assert.equal(await installDetails.locator('[data-choose-location]').isVisible(),true,'choosing the folder is a real button');
  assert((await installDetails.locator('.desktop-install-current').textContent()).length>0,'the installation path is visible');
  assert.equal(await installDetails.locator('.desktop-install-default').isVisible(),false,'the default path is not repeated');
  assert.equal(await installDetails.getByRole('button').count(),1,'the folder picker is the only control in the details');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().nodeIntegration),false);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().contextIsolation),true);
  await page.getByRole('link',{name:'Map',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('snapshot-date').textContent.includes('Charted'));
  assert.equal(await page.locator('.atlas-home').count(),0);
  assert.equal(await page.locator('.arrival-mist').count(),0);
  assert.equal(await page.locator('nav [popovertarget]').count(),0);
  // The utility pages carry no hero, so they carry no Settings: client settings are
  // offered where the client is played, not on the chart.
  assert.equal(await page.locator('.desktop-settings-button').count(),0,'the map offers no client settings button');
  await page.screenshot({path:'/tmp/easter-desktop-map.png'});
  await page.getByRole('link',{name:'Home',exact:true}).click();
  await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  assert.equal(await page.getByRole('button',{name:'Skip intro'}).count(),0);
  await page.screenshot({path:'/tmp/easter-desktop-home.png',fullPage:true});
 });
 await run(path.join(root,'tests/desktop/harness.cjs'),async(app,page)=>{
  await page.locator('[data-desktop-play]').click();
  await page.locator('#desktop-install-details').waitFor({state:'hidden'});
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
  const instruction=page.locator('.desktop-device-instruction');
  await instruction.filter({hasText:'The Microsoft sign-in page is open in your browser.'}).waitFor();
  const signin=page.locator('#desktop-signin');
  assert.equal(await signin.isVisible(),true);
  // There is no code to copy any more (Owen, 2026-10-24): the dialog the player used to copy one
  // out of is gone, and this is the launcher-wide journey where that is checked.
  assert.equal(await page.locator('.desktop-code').count(),0,'the sign-in dialog offers nothing to copy');
  // The property that selection protected still holds for the sentence in its place: a real
  // text selection and clipboard copy survive repeated download progress broadcast through the
  // actual isolated preload.
  await instruction.evaluate(element=>{
   window.__selectedDeviceText=element.firstChild;
   const range=document.createRange();range.selectNodeContents(element);
   const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await app.evaluate(async()=>{
   for(let n=0;n<40;n++){global.easterTestDownloadProgress();await new Promise(resolve=>setTimeout(resolve,10));}
  });
  const selected='The Microsoft sign-in page is open in your browser.';
  assert.equal(await page.evaluate(()=>window.getSelection().toString()),selected,'progress preserves the selected sentence');
  assert.equal(await page.locator('.desktop-device-instruction').evaluate(element=>element.firstChild===window.__selectedDeviceText),true,'the sentence keeps its text node');
  assert.equal(await signin.isVisible(),true,'the same sign-in dialog remains open');
  await page.keyboard.press('Control+c');
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),selected,'the selection can actually be copied');
  await page.evaluate(()=>window.getSelection().removeAllRanges());
  await app.evaluate(()=>global.easterTestFinishDownload());
  await instruction.filter({hasText:'The Microsoft sign-in page is open in your browser.'}).waitFor();
  assert.equal(await signin.locator('.desktop-status').count(),0,'transfer status must not duplicate the sign-in instruction');
  assert.equal(await signin.locator('[data-open-microsoft]').evaluate(el=>el===document.activeElement),true,'focus goes to the browser action');
  // The action re-opens the sign-in main is already waiting on; it opens no address of its own.
  // (Firefox, Enter on a focused button.)
  await app.evaluate(()=>{global.easterTestReopens=0;});
  await page.keyboard.press('Enter');
  assert.equal(await app.evaluate(()=>global.easterTestReopens),1,'Enter asks main to put the sign-in page back in front of the player');
  assert.equal(await signin.isVisible(),true,'keyboard activation must not be mistaken for a backdrop click');
  for(const width of [800,390,320]){
   await page.setViewportSize({width,height:width===800?600:568});
   const bounds=await signin.boundingBox();
   assert(bounds.x>=0&&bounds.x+bounds.width<=width+1,'sign-in fits '+width+'px');
   assert.equal(await signin.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'sign-in has no horizontal overflow');
   assert.equal(await signin.getByRole('button',{name:'Open the Microsoft sign-in page again',exact:true}).isVisible(),true);
   assert.equal(await signin.locator('.desktop-code').count(),0,'and there is still no code to copy');
   await signin.screenshot({path:'/tmp/signin-reviewed-'+width+'.png'});
  }
  await page.setViewportSize({width:800,height:600});
  assert(!(await page.evaluate(()=>JSON.stringify(document.body.textContent))).includes('fixture-private'));
  // Stage feedback crosses the real isolated preload without replacing the dialog, and the
  // waiting state goes away once the sign-in is being verified. A transfer continues
  // independently underneath it.
  await app.evaluate(()=>global.easterTestAuthStage('microsoft-verifying'));
  await signin.locator('.desktop-auth-wait').filter({hasText:'Verifying your Microsoft sign-in…'}).waitFor();
  assert.equal(await signin.locator('.desktop-device').isVisible(),false,'the waiting state is hidden during verification');
  assert.equal(await signin.getByRole('button',{name:'Cancel sign-in',exact:true}).isVisible(),true,'verification remains genuinely cancellable');
  const startedAt=(await page.evaluate(()=>window.easterDesktop.status())).activity.startedAt;
  await app.evaluate(()=>global.easterTestAuthStage('company-waking'));
  await signin.locator('.desktop-auth-wait').filter({hasText:'The account service is waking up.'}).waitFor();
  assert.equal((await page.evaluate(()=>window.easterDesktop.status())).activity.startedAt,startedAt,'stage changes keep the operation clock');
  assert.equal(await signin.getByRole('button',{name:'Cancel sign-in',exact:true}).isVisible(),false,'a pending Company mutation offers no misleading cancellation');
  await page.keyboard.press('Escape');
  assert.equal(await signin.isVisible(),true,'Escape does not dismiss an active Company mutation');
  await app.evaluate(()=>global.easterTestAuthStage('microsoft-waiting'));
  await signin.locator('[data-open-microsoft]').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
  assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'cancelling sign-in is not an error');
  // Signing in is the hero's action, not a control inside the settings dialog.
  assert.equal(await page.locator('#desktop-launcher').getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),0,'the settings dialog offers no sign-in action');
  // The dialog is modal: it has to be closed before the hero behind it can be used.
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open);
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
  await page.locator('#desktop-signin').waitFor({state:'visible'});
  await app.evaluate(()=>global.easterTestApprove());
  // A completed sign-in closes the dialog it opened for the browser page. The player must not
  // land in client settings just because the login finished.
  await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open,null,{timeout:25000});
  assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),false,'signing in leaves no dialog open');
  // The client is installed now, so Play belongs to the hero and only to the hero.
  const hero=page.locator('[data-desktop-play][data-action=play]');
  await hero.waitFor();
  assert.equal(await page.locator('#desktop-launcher').getByRole('button',{name:'PLAY NOW',exact:true}).count(),0,'the settings dialog carries no play action');
  await hero.click();
  await page.locator('[data-desktop-play][data-action=running]').waitFor();
  assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),false,'Play launches the game without opening a dialog');
  // The in-game hero is Owen's Exit Game, and it is a control rather than a disabled label:
 // ticket 4869be14 made the in-game state pressable. This journey's client is an EventEmitter
 // stand-in with no process behind it, so what is asserted here is the action the state produces;
 // the press itself, against real processes (a launched one and an adopted one), is
 // tests/desktop/exit-game.electron.mjs.
 assert.equal(await page.locator('[data-desktop-play]').getAttribute('data-action'),'running','the hero is the in-game action while a game runs');
 assert((await page.locator('[data-desktop-play]').innerText()).includes('Exit Game'),'which is Exit Game, Owen\'s own naming: '+(await page.locator('[data-desktop-play]').innerText()).replace(/\s+/g,' '));
 assert.equal(await page.locator('[data-desktop-play]').isDisabled(),false,'and the in-game action is pressable, not a disabled label');
  const status=await page.evaluate(()=>window.easterDesktop.status());assert.equal(status.profile.name,'TestCaptain');assert(!JSON.stringify(status).includes('fixture-private'));
  // While the game is running the launcher asks for nothing: no download, no update,
  // no settings.
  // The contract keys Settings on the client being installed, not on the game's state: a
  // player who is running the game may still open settings, and nothing here may hide them.
  assert.equal(await page.locator('.desktop-settings-button:visible').count(),1,'Settings stays available while the game runs');
  await page.locator('.desktop-settings-button').click();
  await page.locator('[data-save-settings]').click();
  await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
  await page.keyboard.press('Escape');
  await app.evaluate(()=>global.easterTestGame.emit('exit',0));
  // The status line lives in the dialog, which Play never opens now, so it is read
  // attached rather than visible.
  await page.waitForFunction(async()=>(await window.easterDesktop.status()).phase==='ready');
  await page.locator('[data-desktop-play][data-action=play]').waitFor();
  assert.equal(await page.locator('[data-desktop-play]').isDisabled(),false,'game exit restores the Play action');
  assert.equal((await page.evaluate(()=>window.easterDesktop.status())).phase,'ready');
  // Settings at the Play Now stage is the hero's secondary action, and its dialog is
  // client settings only. Starting the game opened nothing, so it is closed already.
  assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),false,'no dialog is left open after launching');
  const settingsButton=page.locator('.desktop-settings-button');
  await settingsButton.waitFor({state:'visible',timeout:30000});
  await settingsButton.click();
  const dialog=page.locator('#desktop-launcher');
  await dialog.waitFor({state:'visible'});
  const settingsText=await dialog.innerText();
  for(const forbidden of ['Start download','Include enhanced graphics + shaders'])
   assert(!settingsText.includes(forbidden),'the settings dialog must not carry "'+forbidden+'"');
  assert.equal(await dialog.locator('.desktop-install-details,.desktop-progress,.desktop-play').count(),0,'the dialog carries no install section, progress bar or play button');
  assert.equal(await dialog.locator('[data-choose-location]').count(),0,'the installation folder is not a settings row');
  // No server address is offered anywhere: the launcher targets one fixed production
  // server (doc/launcher-states.md, "The one server the launcher targets"), so the dialog
  // and the state the real main process broadcasts both carry none.
  assert.equal(await dialog.locator('select[name=serverSelect],input[name=server]').count(),0,'the real window offers no server address');
  assert(!/server/i.test(settingsText),'and the dialog does not mention a server at all: '+settingsText);
  const liveState=await page.evaluate(()=>window.easterDesktop.status());
  assert.equal('servers' in liveState,false,'the state the real main process publishes carries no server list');
  assert.equal('server' in liveState.settings,false,'and the settings it publishes carry no address: '+JSON.stringify(liveState.settings));
  const advanced=dialog.locator('.desktop-advanced');
  await advanced.locator('summary').click();
  await advanced.locator('input[name=memoryMB]').fill('3072');
  await dialog.getByRole('button',{name:'Save settings',exact:true}).click();
  await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
  await page.keyboard.press('Escape');
  // The graphics toggle is a hero control and the only graphics control. Its own
  // behaviour is proven in tests/browser.mjs against the stubbed bridge; in a real
  // window it appears only once the preload exposes setGraphics and main publishes
  // status().graphics, which the main-process ticket owns. Until then it must be
  // absent rather than rendered dead, which is what is asserted here.
  assert.equal(await page.evaluate(()=>typeof window.easterDesktop.setGraphics),'function','the preload exposes the graphics toggle of the amended contract');
  assert.equal(await page.locator('#desktop-launcher .desktop-graphics, #desktop-launcher input[data-graphics-toggle]').count(),0,'no second graphics control appears in Settings');
  // The toggle belongs to the Play Now stage: it is offered once the client is installed,
  // and driving it moves the state the main process publishes on this machine's own
  // hardware answer. Without an installed client there is nothing to toggle, and asking
  // is refused by design, so the state decides which case this run is in.
  const installedNow=(await page.evaluate(()=>window.easterDesktop.status())).install.installed;
  // A fixture may report an installed client without the marker file that proves it. The
  // toggle is allowed to refuse that honestly, so the refusal is accepted as the documented
  // answer instead of being reported as a broken control.
  let toggleRefused=false;
  if(installedNow){
   assert.equal(await page.locator('.hero-graphics:visible').count(),1,'the toggle is offered at the Play Now stage');
   const graphicsBefore=(await page.evaluate(()=>window.easterDesktop.status())).graphics;
   try{
    await page.evaluate(enabled=>window.easterDesktop.setGraphics(enabled),!graphicsBefore.enabled);
   }catch(error){
    toggleRefused=true;
    assert(/Download the game before changing its graphics settings/.test(String(error.message)),'a refusal names the reason: '+error.message);
   }
   if(!toggleRefused){
   await page.waitForFunction(previous=>window.easterDesktop.status().then(s=>s.graphics.enabled!==previous),graphicsBefore.enabled,{timeout:60000}).catch(()=>{});
   const graphicsAfter=(await page.evaluate(()=>window.easterDesktop.status())).graphics;
   assert.equal(graphicsAfter.enabled,!graphicsBefore.enabled,'the graphics state follows the player\'s choice');
   assert.equal(typeof graphicsAfter.recommended,'boolean','and the machine\'s recommendation is still published beside it');
   await page.evaluate(enabled=>window.easterDesktop.setGraphics(enabled),graphicsBefore.enabled);
   }
  }else{
   assert.equal(await page.locator('.hero-graphics:visible').count(),0,'without an installed client there is nothing to toggle, so no dead control is shown');
  }
  await page.screenshot({path:'/tmp/easter-desktop-launcher.png'});
  await page.locator('.desktop-account-nav').click();
  await page.getByRole('button',{name:'Logout',exact:true}).click();
  await page.locator('[data-desktop-play][data-action=signin]').waitFor();
  assert.equal(await page.locator('.desktop-account-nav').textContent(),'Sign in');
 });
 const savedCustom=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));
 // The save writes settings and no address: there is no longer a field to save.
 assert.equal('server' in savedCustom,false,'the settings file carries no server address: '+JSON.stringify(savedCustom));
 assert.equal(savedCustom.memoryMB,3072,'the advanced memory setting reaches the settings file');
 // The graphics choice is persisted when the toggle could actually be driven (the fixture
 // may report an installed client whose marker file is absent, and the toggle then refuses
 // honestly instead of writing a choice it cannot honour).
 assert.equal(typeof savedCustom.includeGraphics,'boolean','the settings file records a graphics choice, never a missing field');
 console.log('DESKTOP PASS: no Skip intro control in the desktop DOM (Escape and the 4.6s bound still end the arrival), real Electron, isolated renderer, shared Home/Map, a single download action with the folder choice beside it, a settings-only dialog at the Play Now stage that offers no server address at all, the themed enhanced graphics toggle, native settings persistence, sign-in cancellation, a browser sign-in with nothing to copy, authenticated Play, game lifecycle, no tokens in UI');
}finally{await fs.rm(temp,{recursive:true,force:true});}
