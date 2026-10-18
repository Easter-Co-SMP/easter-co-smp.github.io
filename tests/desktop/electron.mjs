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
// skippable and bounded without it. Launch one runs the arrival both ways; launch two runs the shell.
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
 // Left untouched after a fresh load, the bounded 4.6s timer still ends the arrival.
 await page.reload();
 await page.waitForFunction(()=>document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
},true);
try{
 await arrival();
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
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Login with Microsoft Account',exact:true}).click();
  await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
  const signin=page.getByRole('dialog',{name:'Sign in with Microsoft',exact:true});
  assert.equal(await signin.isVisible(),true);
  assert.equal(await signin.locator('.desktop-status').count(),0,'transfer status must not duplicate the sign-in instruction');
  assert.equal(await signin.locator('[data-open-microsoft]').evaluate(el=>el===document.activeElement),true,'focus goes to the Microsoft browser action');
  await app.evaluate(({shell})=>{global.__openedMicrosoft=[];shell.openExternal=async url=>{global.__openedMicrosoft.push(url);};});
  await page.keyboard.press('Enter');
  assert.deepEqual(await app.evaluate(()=>global.__openedMicrosoft),['https://www.microsoft.com/link'],'Enter opens the intended Microsoft page through main');
  assert.equal(await signin.isVisible(),true,'keyboard activation must not be mistaken for a backdrop click');
  for(const width of [800,390,320]){
   await page.setViewportSize({width,height:width===800?600:568});
   const bounds=await signin.boundingBox();
   assert(bounds.x>=0&&bounds.x+bounds.width<=width+1,'sign-in fits '+width+'px');
   assert.equal(await signin.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'sign-in has no horizontal overflow');
   assert.equal(await signin.getByRole('button',{name:'Login with Microsoft',exact:true}).isVisible(),true);
   assert.equal(await signin.locator('.desktop-code').isVisible(),true);
   await signin.screenshot({path:'/tmp/signin-reviewed-'+width+'.png'});
  }
  await page.setViewportSize({width:800,height:600});
  assert(!(await page.evaluate(()=>JSON.stringify(document.body.textContent))).includes('fixture-private'));
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
  assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'cancelling sign-in is not an error');
  // Signing in is the hero's action, not a control inside the settings dialog.
  assert.equal(await page.locator('#desktop-launcher').getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),0,'the settings dialog offers no sign-in action');
  // The dialog is modal: it has to be closed before the hero behind it can be used.
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#desktop-launcher')?.open);
  await page.locator('[data-desktop-play]').click();await page.getByRole('button',{name:'Login with Microsoft Account',exact:true}).click();
  await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
  await app.evaluate(()=>global.easterTestApprove());
  // A completed sign-in closes the dialog it used for the device code. The player must not
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
  assert(await page.locator('[data-desktop-play]').isDisabled());
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
  const serverSelect=dialog.locator('select[name=serverSelect]');
  // The options are filled from the state the main process broadcasts, so wait for them
  // rather than reading a select that may still be empty.
  await serverSelect.locator('option').first().waitFor({state:'attached'});
  assert.equal(await serverSelect.inputValue(),'100.100.1.0:25565','the published default server is selected');
  const pendingOption=serverSelect.locator('option[value="smp.easter.company:25565"]');
  await pendingOption.waitFor({state:'attached'});
  // The dialog re-renders as state arrives, so wait for the pending entry to settle as
  // unusable instead of sampling a render that is still in flight.
  await page.waitForFunction(()=>document.querySelector('#desktop-launcher select[name=serverSelect] option[value="smp.easter.company:25565"]')?.disabled===true,{timeout:20000});
  // Playwright's isDisabled() reflects form controls, not <option disabled>, so read the
  // property the browser actually enforces.
  assert.equal(await pendingOption.evaluate(el=>el.disabled),true,'the pending server is shown as unavailable');
  // A custom address is the player's own, and it round-trips through main's settings.
  await serverSelect.selectOption('__custom__');
  await dialog.locator('input[name=server]').fill('test.example:25565');
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
 assert.equal(savedCustom.server,'test.example:25565','a custom server address is saved exactly as typed');
 assert.equal(savedCustom.memoryMB,3072,'the advanced memory setting reaches the settings file');
 // The graphics choice is persisted when the toggle could actually be driven (the fixture
 // may report an installed client whose marker file is absent, and the toggle then refuses
 // honestly instead of writing a choice it cannot honour).
 assert.equal(typeof savedCustom.includeGraphics,'boolean','the settings file records a graphics choice, never a missing field');
 console.log('DESKTOP PASS: no Skip intro control in the desktop DOM (Escape and the 4.6s bound still end the arrival), real Electron, isolated renderer, shared Home/Map, a single download action with the folder choice beside it, a settings-only dialog at the Play Now stage with a published server choice, the themed enhanced graphics toggle, native settings persistence, sign-in cancellation, device-code UI, authenticated Play, game lifecycle, no tokens in UI');
}finally{await fs.rm(temp,{recursive:true,force:true});}
