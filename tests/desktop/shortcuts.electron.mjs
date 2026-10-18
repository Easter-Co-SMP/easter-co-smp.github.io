// The game shortcut, end to end, against a real launcher process: the two Settings
// toggles create and remove a desktop entry and a Start menu entry inside an isolated
// HOME, the entries run the LAUNCHER with an explicit auto-start argument and carry no
// credential of any kind, and a second launch of the launcher with that argument starts
// the game through the real main process - and declines to, leaving the window in its
// normal state, whenever something still needs the player.
// Run: xvfb-run -a node tests/desktop/shortcuts.electron.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
// The worktree's node_modules is a symlink into the main checkout, and the launcher
// reports the binary it is actually running from, so the expected target is resolved the
// same way the launcher resolves it.
const electronPath=await fs.realpath(path.join(root,'node_modules/electron/dist/electron'));
const harness=path.join(root,'tests/desktop/flow-harness.cjs');
const AUTO_START='--play';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const homes=[];
let failures=0;
function check(condition,message){if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}}
// Every credential-shaped word the launcher handles. None of them may ever appear in a
// file the desktop will run, because a shortcut is world-readable text.
const SECRETS=['token','bearer','authorization','accessToken','refreshToken','xbox','password','clientid','xuid','fixture-private','@'];

// An isolated HOME with the two directories a desktop session gives a player. The
// launcher resolves both entry locations from the home directory and the XDG variables,
// so an isolated HOME is an isolated desktop.
async function makeHome(prefix,{desktop=true}={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
 homes.push(home);
 await fs.mkdir(path.join(home,'.config'),{recursive:true});
 await fs.mkdir(path.join(home,'.local','share'),{recursive:true});
 if(desktop)await fs.mkdir(path.join(home,'Desktop'),{recursive:true});
 return home;
}
function envFor(home,extra={}){
 return {...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),EASTER_TEST_HOME:home,EASTER_TEST_TRAY:'0',...extra};
}
const desktopEntry=home=>path.join(home,'Desktop','easter-co-game.desktop');
const menuEntry=home=>path.join(home,'.local','share','applications','easter-co-game.desktop');
const fileExists=async file=>{try{await fs.stat(file);return true;}catch{return false;}};
// A second launch of the launcher with the shortcut's own argument. It is spawned as a
// plain process rather than through the browser harness because its whole job is to be
// refused by the single-instance lock and to hand its command line to the running app.
async function secondLaunch(home,args=[AUTO_START],env={}){
 const child=spawn(electronPath,['--no-sandbox',harness,...args],{env:envFor(home,env),stdio:'ignore'});
 await new Promise(resolve=>child.once('exit',resolve));
}

console.log('\n1. two Settings toggles create both entries in an isolated HOME');
const home=await makeHome('easter-shortcut-test-');
const settingsFile=path.join(home,'settings.json');
const app=await electron.launch({executablePath:electronPath,args:['--no-sandbox',harness],env:envFor(home,{EASTER_FLOW_INSTALLED:'1'})});
try{
 const page=await app.firstWindow();
 page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 const dialog=page.locator('#desktop-launcher');
 const settingsButton=page.locator('.desktop-settings-button');
 await settingsButton.click();
 await dialog.waitFor({state:'visible'});

 const desktopToggle=dialog.locator('input[name=desktopShortcut]');
 const menuToggle=dialog.locator('input[name=startMenuShortcut]');
 const note=dialog.locator('.desktop-shortcuts-note');
 check(await desktopToggle.count()===1&&await menuToggle.count()===1,'the dialog offers a desktop-shortcut switch and a Start-menu switch');
 check(await desktopToggle.isChecked()===false&&await menuToggle.isChecked()===false,'both are off on a fresh install: no new icon appears without being asked for');
 check(await note.isVisible()===false,'and nothing is said about shortcuts that are neither wanted nor present');
 check(await desktopToggle.evaluate(input=>input.previousElementSibling!==null&&input.parentElement.className.includes('desktop-preference')),'the switch keeps the dialog\'s existing preference markup');
 for(const [width,height] of [[1360,920],[800,600]]){
  await page.setViewportSize({width,height});
  check(await dialog.evaluate(el=>el.scrollHeight<=el.clientHeight+1),'the settings dialog still fits a '+width+'x'+height+' window with the two new switches in it');
 }
 await page.setViewportSize({width:1360,height:920});

 await desktopToggle.check();
 await menuToggle.check();
 await dialog.locator('[data-save-settings]').click();
 await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 const afterSave=JSON.parse(await fs.readFile(settingsFile,'utf8'));
 check(afterSave.desktopShortcut===true&&afterSave.startMenuShortcut===true,'the save records both preferences: '+JSON.stringify({desktopShortcut:afterSave.desktopShortcut,startMenuShortcut:afterSave.startMenuShortcut}));
 check(await fileExists(desktopEntry(home)),'the desktop shortcut exists at '+path.relative(home,desktopEntry(home)));
 check(await fileExists(menuEntry(home)),'the Start menu entry exists at '+path.relative(home,menuEntry(home)));
 for(const [file,label] of [[desktopEntry(home),'desktop entry'],[menuEntry(home),'Start menu entry']]){
  const stat=await fs.stat(file);
  check((stat.mode&0o111)!==0,'the '+label+' is executable: '+('0'+(stat.mode&0o777).toString(8)));
  const text=await fs.readFile(file,'utf8');
  const execLine=/^Exec=(.+)$/m.exec(text)?.[1]||'';
  console.log('  info Exec='+execLine);
  check(execLine.endsWith(' '+AUTO_START),'the '+label+' runs the launcher with the explicit auto-start argument '+AUTO_START);
  check(execLine.startsWith(electronPath),'and the target is the launcher binary itself, not Minecraft: '+execLine);
  check(/^X-Easter-Company=game-shortcut$/m.test(text),'the '+label+' carries the launcher\'s own marker, so removal can prove the file is ours');
  const leaked=SECRETS.filter(word=>text.toLowerCase().includes(word.toLowerCase()));
  check(leaked.length===0,'no credential, token or account identifier is written into the '+label+': '+JSON.stringify(leaked));
 }
 const stateAfter=await page.evaluate(()=>window.easterDesktop.status());
 check(stateAfter.shortcuts.available===true,'the launcher reports shortcuts as available on this computer');
 check(stateAfter.shortcuts.desktop.exists===true&&stateAfter.shortcuts.startMenu.exists===true,'and reports both entries as really present');
 check(stateAfter.shortcuts.desktop.ours===true&&stateAfter.shortcuts.startMenu.ours===true,'as files this launcher wrote, which is what removal is allowed to trust');
 check(await note.isVisible()===false,'so the dialog says nothing more about them');

 console.log('\n2. the dialog reports the file, not the preference');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('#desktop-launcher').open);
 await fs.rm(desktopEntry(home),{force:true});
 await settingsButton.click();
 await dialog.waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#desktop-launcher .desktop-shortcuts-note')?.hidden===false);
 check(/desktop shortcut is not on this computer/i.test(await note.textContent()),'a shortcut deleted by hand is reported when the dialog opens: '+JSON.stringify(await note.textContent()));
 check(await desktopToggle.isChecked()===true,'while the saved preference still shows what was asked for');
 const missingState=await page.evaluate(()=>window.easterDesktop.status());
 check(missingState.shortcuts.desktop.wanted===true&&missingState.shortcuts.desktop.exists===false,'status() carries the preference and the fact, separately');
 // Saving again is what puts the file back.
 await dialog.locator('[data-save-settings]').click();
 await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 check(await fileExists(desktopEntry(home)),'saving the dialog re-creates the missing entry');

 console.log('\n3. unticking removes exactly the files the launcher created');
 await desktopToggle.uncheck();
 await menuToggle.uncheck();
 await dialog.locator('[data-save-settings]').click();
 await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 check(await fileExists(desktopEntry(home))===false,'the desktop shortcut is gone');
 check(await fileExists(menuEntry(home))===false,'and so is the Start menu entry');
 const afterRemove=JSON.parse(await fs.readFile(settingsFile,'utf8'));
 check(afterRemove.desktopShortcut===false&&afterRemove.startMenuShortcut===false,'and both preferences are off in settings.json');
 check(await fileExists(path.join(home,'.local','share','applications'))===true,'the applications directory itself is left alone');
 check(await fs.readdir(path.join(home,'Desktop')).then(entries=>entries.length===0,()=>false),'and nothing else on the desktop was touched');
 // A file the launcher did not write is never deleted, even if it sits at its own name:
 // the removal only trusts a file that carries the launcher's own marker.
 const nativeEntry='[Desktop Entry]\nType=Application\nName=Somebody else\nExec=/usr/bin/true\n';
 await fs.writeFile(desktopEntry(home),nativeEntry,{mode:0o755});
 await menuToggle.check();
 await dialog.locator('[data-save-settings]').click();
 await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 check(await fs.readFile(desktopEntry(home),'utf8')===nativeEntry,'a .desktop file without the launcher\'s marker is left exactly as it was');
 check(/was not created by this launcher/i.test(await note.textContent()),'and the dialog says a foreign file is still there instead of pretending it removed it: '+JSON.stringify(await note.textContent()));
 await menuToggle.uncheck();
 await dialog.locator('[data-save-settings]').click();
 await dialog.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 await fs.rm(desktopEntry(home),{force:true});

 console.log('\n4. a shortcut launch starts the game through the real main process, once the gate is open');
 // The account the fixture harness signs in with, reached through the UI it always uses.
 await page.keyboard.press('Escape');
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await page.getByRole('button',{name:'Continue with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
 await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor({timeout:30000});
 check(await page.evaluate(()=>window.easterDesktop.status().then(state=>state.canPlay))===true,'the client and the account are in place, so Play is offered');
 check(await app.evaluate(()=>global.easterTestLaunches)===0,'and nothing has started the game yet');
 // The click the desktop makes: the launcher, again, with the shortcut's own argument.
 await secondLaunch(home);
 await page.waitForFunction(async()=>{const state=await window.easterDesktop.status();return state.phase==='running';},null,{timeout:30000});
 check(await app.evaluate(()=>global.easterTestLaunches)===1,'the second launch reached the running launcher through the single-instance lock and started exactly one game');
 const running=await page.evaluate(()=>window.easterDesktop.status());
 check(running.phase==='running'&&Boolean(running.profile?.name),'the game is running for the signed-in player: '+running.profile?.name);
 check(await app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()))===true,'the window is on screen, as it is for the default launch behaviour');

 console.log('\n5. the shortcut click is refused while a game is already running');
 const beforeSecond=await app.evaluate(()=>global.easterTestLaunches);
 await secondLaunch(home);
 await sleep(2000);
 check(await app.evaluate(()=>global.easterTestLaunches)===beforeSecond,'a second click starts no second game');
 check((await page.evaluate(()=>window.easterDesktop.status())).phase==='running','and the running game is untouched');
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).phase==='ready',null,{timeout:20000});

 console.log('\n6. the launch behaviour the player chose is applied by the shortcut too');
 await app.evaluate(()=>{process.env.EASTER_TEST_TRAY='1';});
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();return window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 await secondLaunch(home);
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).phase==='running',null,{timeout:30000});
 let hidden=false;
 for(let attempt=0;attempt<200;attempt++){
  hidden=!(await app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible())));
  if(hidden)break;
  await sleep(25);
 }
 check(hidden,'with the tray preference on, the shortcut launch steps the launcher aside exactly as Play does');
 const inTray=await page.evaluate(()=>window.easterDesktop.status());
 check(inTray.phase==='running'&&inTray.error===null,'and the game keeps running with no invented warning: '+JSON.stringify(inTray.error));
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).phase==='ready',null,{timeout:20000});
 check(await app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()))===true,'the window comes back by itself when the game ends');
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();return window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:false});});
 check(JSON.parse(await fs.readFile(settingsFile,'utf8')).trayOnLaunch===false,'the test leaves the saved launch behaviour off, as it found it');
}finally{await app.close();}

console.log('\n7. a shortcut that needs the player opens the window and starts nothing');
// An installed client with no account: the same click must leave the launcher normal and idle.
const signedOutHome=await makeHome('easter-shortcut-decline-');
await fs.writeFile(path.join(signedOutHome,'settings.json'),JSON.stringify({memoryMB:4096,javaPath:'',server:'100.100.1.0:25565',location:'',includeGraphics:false,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false,trayOnLaunch:false,desktopShortcut:true,startMenuShortcut:true,graphicsChosen:false}));
const declineApp=await electron.launch({executablePath:electronPath,args:['--no-sandbox',harness,AUTO_START],env:envFor(signedOutHome,{EASTER_FLOW_INSTALLED:'1'})});
try{
 const page=await declineApp.firstWindow();
 page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await sleep(2000);
 const state=await page.evaluate(()=>window.easterDesktop.status());
 check(await declineApp.evaluate(()=>global.easterTestLaunches)===0,'a shortcut launch with no account starts no game');
 check(state.phase!=='running','the launcher stays in its normal state: '+state.phase);
 check(JSON.stringify(state.actions)===JSON.stringify(['signin']),'and says what the player still has to do, in the state it always shows: '+JSON.stringify(state.actions));
 check(await page.locator('[data-desktop-play][data-action=signin]').count()===1,'the window is showing the sign-in action the shortcut did not take');
 check(await declineApp.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()))===true,'and the window is on screen rather than hidden');
}finally{await declineApp.close();}

// Nothing installed at all: a shortcut click is still a shortcut click, never an install.
const emptyHome=await makeHome('easter-shortcut-empty-');
const emptyApp=await electron.launch({executablePath:electronPath,args:['--no-sandbox',harness,AUTO_START],env:envFor(emptyHome)});
try{
 const page=await emptyApp.firstWindow();
 page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await sleep(2000);
 const state=await page.evaluate(()=>window.easterDesktop.status());
 check(await emptyApp.evaluate(()=>global.easterTestLaunches)===0,'with nothing installed the shortcut starts no game');
 check(JSON.stringify(state.actions)===JSON.stringify(['download','signin']),'the first-run actions are what the player sees: '+JSON.stringify(state.actions));
 check(await page.locator('[data-desktop-play][data-action=download]').count()===1,'and the hero still offers the download it offered before');
}finally{await emptyApp.close();}

console.log('\n8. a computer with no Desktop folder is told plainly, and the Start menu entry still works');
const noDesktopHome=await makeHome('easter-shortcut-nodesktop-',{desktop:false});
const noDesktopApp=await electron.launch({executablePath:electronPath,args:['--no-sandbox',harness],env:envFor(noDesktopHome,{EASTER_FLOW_INSTALLED:'1'})});
try{
 const page=await noDesktopApp.firstWindow();
 page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.keyboard.press('Escape');
 await page.locator('.desktop-settings-button').click();
 const dialog=page.locator('#desktop-launcher');
 await dialog.waitFor({state:'visible'});
 await dialog.locator('input[name=desktopShortcut]').check();
 await dialog.locator('input[name=startMenuShortcut]').check();
 await dialog.locator('[data-save-settings]').click();
 const result=dialog.locator('.desktop-settings-result');
 await result.filter({hasText:'Saved.'}).waitFor({timeout:20000});
 const note=dialog.locator('.desktop-shortcuts-note');
 await page.waitForFunction(()=>document.querySelector('#desktop-launcher .desktop-shortcuts-note')?.hidden===false);
 const message=await note.textContent();
 console.log('  info the dialog said: '+JSON.stringify(message));
 check(/There is no Desktop folder on this computer/i.test(message),'the dialog says plainly that no desktop shortcut was created');
 check(await fileExists(menuEntry(noDesktopHome))===true,'the Start menu entry, which was possible, was still written');
 check(await fileExists(desktopEntry(noDesktopHome))===false,'and no Desktop folder was invented');
 const saved=JSON.parse(await fs.readFile(path.join(noDesktopHome,'settings.json'),'utf8'));
 check(saved.desktopShortcut===false&&saved.startMenuShortcut===true,'the saved preference for the impossible entry is turned off, so the file and the setting agree: '+JSON.stringify({desktopShortcut:saved.desktopShortcut,startMenuShortcut:saved.startMenuShortcut}));
 const state=await page.evaluate(()=>window.easterDesktop.status());
 check(state.shortcuts.desktop.exists===false&&state.shortcuts.desktop.wanted===false,'and the published state says the same: '+JSON.stringify(state.shortcuts.desktop));
 check(await dialog.locator('input[name=desktopShortcut]').isChecked()===false,'the dialog shows the corrected preference rather than claiming success');
}finally{await noDesktopApp.close();}

for(const home of homes)await fs.rm(home,{recursive:true,force:true});
console.log(failures===0?'\nSHORTCUT PASS: the two Settings toggles created and removed a desktop entry and a Start menu entry in an isolated HOME, both executable, both running the launcher binary with --play and carrying no credential, token or account identifier; the dialog reported the files rather than the preference, including a shortcut deleted by hand and a computer with no Desktop folder; a second launch of the launcher with the flag reached the running launcher through the single-instance lock and started exactly one game, refused a second game while one ran, applied the tray launch behaviour exactly as Play does, and started nothing at all when the account or the client still needed attention':'\nSHORTCUT FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
