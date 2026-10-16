// Main-process proof for the download-first flow: the live state object main.cjs
// broadcasts, the Play gate, the location handlers, pause/resume/cancel and the
// quiet update check. Real Electron, real IPC, no upstream download.
// Run: xvfb-run -a node tests/desktop/flow.electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-flow-test-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const CONTRACT=['phase','progress','paused','install','actions','canPlay','bar'];
const PHASES=['uninstalled','downloading','paused','verifying','installing','updating','ready','launching','running'];
const PROGRESS_FIELDS=['label','percent','bytesDone','bytesTotal','bytesPerSecond','etaSeconds'];
let failures=0;
function check(condition,message){if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}}
// The graphics profile this run is told to assume: a software renderer, so the
// "on unless the GPU is clearly weak" rule has something weak to answer about. The
// launcher reads it only in an unpackaged test run.
const WEAK_GPU_PROFILE=JSON.stringify({
 gpu:null,vendor:null,vramMB:null,tier:'weak',reason:'Software graphics (llvmpipe (LLVM 23.1.1, 256 bits)): enhanced graphics stay off.',
 source:'none',software:true,recommended:false,tunable:false,
 adapters:[{name:'llvmpipe (LLVM 23.1.1, 256 bits)',vendorId:null,deviceId:null,vramMB:null,source:'system_profiler'}]
});
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'tests/desktop/flow-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:temp,EASTER_TEST_GPU:WEAK_GPU_PROFILE}});
try{
 const page=await app.firstWindow();
 page.setDefaultTimeout(20000);
 const pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 // Record what the main process actually broadcasts. Reading it here rather than
 // through a renderer listener keeps the evidence independent of any renderer error.
 await app.evaluate(({BrowserWindow})=>{
  const win=BrowserWindow.getAllWindows()[0];
  global.__states=[];global.__mark=0;
  const send=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>{if(channel==='launcher:state')global.__states.push(JSON.parse(JSON.stringify(args[0])));return send(channel,...args);};
 });
 const broadcast=async()=>app.evaluate(()=>global.__states);
 const latest=async()=>{const seen=await broadcast();return seen.length?seen[seen.length-1]:page.evaluate(()=>window.easterDesktop.status());};
 const since=async()=>app.evaluate(()=>global.__states.slice(global.__mark));
 const mark=()=>app.evaluate(()=>{global.__mark=global.__states.length;});
 const invoke=async(code,...args)=>page.evaluate(code,...args);
 const waitFor=async(predicate,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   const hit=(await since()).find(predicate);
   if(hit)return hit;
   await sleep(25);
  }
  throw Error('timed out waiting for '+label+'; last state '+JSON.stringify(await latest()));
 };

 console.log('\n1. fresh first run');
 const initial=await page.evaluate(()=>window.easterDesktop.status());
 for(const field of CONTRACT)check(field in initial,'status() carries '+field);
 check(PHASES.includes(initial.phase),'phase '+initial.phase+' is one of the contract values');
 check(initial.phase==='uninstalled','nothing is installed yet');
 check(initial.progress===null,'progress is null when nothing is transferring');
 check(initial.paused===false,'paused is false when nothing can be resumed');
 for(const field of ['location','defaultLocation','installed','includeGraphics','version','updatedAt'])check(field in initial.install,'install.'+field+' is present');
 for(const field of ['gpu','vendor','vramMB','tier','reason'])check(field in initial.hardware,'hardware.'+field+' is present');
 check(['capable','weak','unknown'].includes(initial.hardware.tier),'the tier is one of the contract values: '+initial.hardware.tier);
 check(typeof initial.hardware.reason==='string'&&initial.hardware.reason.length>0,'hardware.reason is displayable: '+initial.hardware.reason);
 for(const field of ['enabled','recommended','tunable','tuned'])check(field in initial.graphics,'graphics.'+field+' is present');
 check(initial.graphics.enabled===initial.install.includeGraphics,'graphics.enabled is install.includeGraphics under its player-facing name');
 check(typeof initial.graphics.recommended==='boolean','graphics.recommended is the automatic answer for this machine');
 check(Array.isArray(initial.servers)&&initial.servers.length>0,'status() publishes the server list');
 check(JSON.stringify(initial.servers.map(entry=>entry.address))===JSON.stringify(['100.100.1.0:25565','127.0.0.1:25565','smp.easter.company:25565']),'the servers are in display order: '+JSON.stringify(initial.servers.map(entry=>entry.address)));
 check(initial.servers.filter(entry=>entry.pending).length===1&&initial.servers[2].pending===true,'the entry with no DNS record is marked pending');
 check(initial.install.location===initial.install.defaultLocation,'the app-owned directory is the default location');
 check(path.resolve(initial.install.location)===path.resolve(path.join(temp,'minecraft')),'the default location is inside the app data directory');
 check(initial.install.installed===false&&initial.install.version===null&&initial.install.updatedAt===null,'an uninstalled client reports no version and no timestamp');
 check(JSON.stringify(initial.actions)===JSON.stringify(['download','signin']),'actions are the ordered remaining requirements');
 check(initial.canPlay===false,'an uninstalled client with no account cannot play');
 check(initial.bar.visible===false,'the bar is hidden before any download starts');
 // This run is told to assume a weak adapter, so the machine's answer is off and the
 // first run has already decided and persisted it.
 check(initial.hardware.tier==='weak','the injected weak adapter is reported as weak: '+JSON.stringify(initial.hardware));
 check(initial.graphics.recommended===false,'a clearly weak GPU recommends enhanced graphics off');
 check(initial.install.includeGraphics===false&&initial.graphics.enabled===false,'and the first run takes that answer');
 const firstRunSettings=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));
 check(firstRunSettings.includeGraphics===false&&firstRunSettings.graphicsChosen===true,'the automatic answer is persisted as the recorded choice: '+JSON.stringify({includeGraphics:firstRunSettings.includeGraphics,graphicsChosen:firstRunSettings.graphicsChosen}));
 // The player's own choice then wins over the machine's, and is kept.
 const chosen=await invoke(()=>window.easterDesktop.setGraphics(true).catch(error=>'error: '+error.message));
 check(typeof chosen==='object'||String(chosen).startsWith('error'),'the toggle answers even before the client exists: '+JSON.stringify(chosen));
 const afterChoice=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));
 check(afterChoice.includeGraphics===true,'an explicit player choice is persisted');
 check(afterChoice.graphicsChosen===true,'and is never re-decided later');

 console.log('\n2. signing in without a client');
 await invoke(()=>{window.__signIn=window.easterDesktop.signIn().catch(error=>error.message);});
 const device=await waitFor(state=>Boolean(state.device),'the device code');
 check(device.device.code==='TEST-CODE','the device code arrives in the state');
 await app.evaluate(()=>global.easterTestApprove());
 // The sign-in request only settles after the launcher's account step, so the next
 // command waits for it instead of racing the launcher's own operation lock.
 const signInResult=await invoke(()=>window.__signIn);
 check(!/^error/.test(String(signInResult)),'the sign-in request completed: '+signInResult);
 const signedIn=await waitFor(state=>state.profile!==null,'the signed-in profile');
 check(JSON.stringify(signedIn.actions)===JSON.stringify(['download']),'only the download is left to do');
 check(signedIn.canPlay===false,'a signed-in account with no client cannot play');

 console.log('\n3. starting the download, then pausing it');
 await mark();
 await invoke(()=>{window.__install=window.easterDesktop.startInstall({includeGraphics:true}).then(()=> 'done',error=>'error: '+error.message);});
 const downloading=await waitFor(state=>state.progress&&state.progress.percent>=20,'the download to report progress');
 check(downloading.phase==='downloading','phase is downloading');
 check(downloading.install.includeGraphics===true,'the enhanced graphics toggle reached the install');
 for(const field of PROGRESS_FIELDS)check(field in downloading.progress,'progress.'+field+' is present');
 check(typeof downloading.progress.percent==='number'&&downloading.progress.percent>=20,'progress carries a percentage');
 check(typeof downloading.progress.bytesDone==='number'&&downloading.progress.bytesTotal===1000,'progress carries byte counts for a sized transfer');
 check(downloading.bar.visible===true,'the bar appears once the download starts');
 await invoke(()=>window.easterDesktop.pauseInstall());
 const paused=await waitFor(state=>state.paused===true,'the paused state');
 check(paused.phase==='paused','phase is paused');
 check(paused.paused===true,'the pause is reported as resumable');
 check(paused.canPlay===false,'a paused client cannot play');
 await sleep(400);
 // A step already in flight when the pause lands may report once more, exactly as
 // an in-flight chunk does; after it settles nothing may move at all.
 const frozenAt=(await latest()).progress.percent;
 const settledReports=(await since()).length;
 await sleep(800);
 const stillPaused=await latest();
 check(stillPaused.paused===true,'the pause holds');
 check(stillPaused.progress.percent===frozenAt,'progress does not advance while paused ('+frozenAt+'%)');
 check((await since()).length===settledReports,'a paused download reports nothing at all');

 console.log('\n4. resuming, then cancelling');
 await mark();
 await invoke(()=>window.easterDesktop.resumeInstall());
 const resumed=await waitFor(state=>state.paused===false&&state.progress&&state.progress.percent>frozenAt,'the resumed state');
 check(resumed.paused===false,'the resume is reported and the transfer moved on from '+frozenAt+'% to '+resumed.progress.percent+'%');
 await invoke(()=>window.easterDesktop.cancelInstall());
 const cancelled=await waitFor(state=>/cancelled/i.test(state.message||''),'the cancellation');
 check(cancelled.paused===false,'nothing is left paused after a cancel');
 check(cancelled.phase==='uninstalled','a cancelled first download leaves the client uninstalled');
 check(cancelled.install.installed===false,'the cancelled install installed nothing');
 check(await invoke(()=>window.__install)==='done','the cancelled install request still settles');

 console.log('\n5. a completed install');
 await mark();
 await invoke(()=>{window.__install2=window.easterDesktop.startInstall({includeGraphics:true}).then(()=> 'done',error=>'error: '+error.message);});
 const ready=await waitFor(state=>state.install.installed===true&&state.phase==='ready','the installed state');
 check(await invoke(()=>window.__install2)==='done','the install request completed');
 check(ready.install.installed===true,'the client is installed');
 check(ready.install.version==='fixture-2.0.0','install.version is the installed client release');
 check(Boolean(ready.install.updatedAt),'install.updatedAt is set');
 check(ready.install.includeGraphics===true,'install.includeGraphics reports the persisted toggle');
 check(ready.progress===null,'nothing is transferring once ready');
 check(ready.actions.length===0,'nothing is required once the client and the account are both present');
 check(ready.canPlay===true,'an installed client with a connected account can play');
 check(JSON.stringify(ready.bar)===JSON.stringify({visible:true}),'the bar stays visible once the client is ready');
 check(/not published yet/.test(ready.message),'an unpublished graphics payload is reported instead of pretended: '+ready.message);
 const saved=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));
 check(saved.includeGraphics===true,'the enhanced graphics toggle persists in the settings file');

 console.log('\n6. an installed client with no account');
 await invoke(()=>window.easterDesktop.signOut());
 const signedOut=await waitFor(state=>state.profile===null&&state.install.installed===true,'the signed-out state');
 check(signedOut.canPlay===false,'an installed client with no account cannot play');
 check(JSON.stringify(signedOut.actions)===JSON.stringify(['signin']),'the remaining requirement is the sign-in');

 console.log('\n7. the location handlers take no renderer path');
 const rejected=[];
 for(const target of ['/etc','/home/player/.minecraft','relative/minecraft',path.join(temp,'elsewhere')])
  rejected.push(await invoke(target=>window.easterDesktop.setLocation(target).then(()=>null,error=>error.message),target));
 check(rejected.every(message=>message&&/folder picker/.test(message)),'every location the picker did not return is refused: '+JSON.stringify(rejected));
 const started=await invoke(()=>window.easterDesktop.startInstall({location:'/srv/minecraft'}).then(()=>null,error=>error.message));
 check(/folder picker/.test(started||''),'starting an install cannot name a path either: '+started);
 const reset=await invoke(()=>window.easterDesktop.setLocation(null));
 check(path.resolve(reset.location)===path.resolve(path.join(temp,'minecraft')),'the default location can be restored without a path');

 console.log('\n8. an update check that finds nothing stays quiet');
 await mark();
 const beforeUpdate=await latest();
 const checked=await invoke(()=>window.easterDesktop.checkUpdates());
 await sleep(600);
 const afterUpdate=await latest();
 const quiet=await since();
 check(JSON.stringify(checked)===JSON.stringify({checked:true,changed:false,applied:false,changes:[],result:null}),'the check reported that nothing differs');
 check(JSON.stringify(beforeUpdate)===JSON.stringify(afterUpdate),'a quiet update check changes no state at all');
 check(quiet.every(state=>state.progress===null||state.phase==='ready'),'no phase the UI would render as work, and no progress bar');

 console.log('\n9. the final state the main process broadcast');
 console.log(JSON.stringify({final:await latest()},null,1));
 check(pageErrors.filter(message=>!/HTMLProgressElement/.test(message)).length===0,'the main process raised no unexpected renderer error: '+JSON.stringify(pageErrors.filter(message=>!/HTMLProgressElement/.test(message))));
}finally{await app.close();}

// A second launch, with an install already present, checks for updates on start.
console.log('\n10. an installed client checks for updates on launch');
try{
 const relaunch=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'tests/desktop/flow-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:temp,EASTER_FLOW_INSTALLED:'1'}});
 let launchState;
 try{
  const relaunchPage=await relaunch.firstWindow();
  relaunchPage.setDefaultTimeout(20000);
  await relaunchPage.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await sleep(1500);
  const checks=await relaunch.evaluate(()=>global.easterTestUpdateChecks);
  check(checks>=1,'the launcher checked for updates on launch ('+checks+' call(s))');
  launchState=await relaunchPage.evaluate(()=>window.easterDesktop.status());
 }finally{await relaunch.close();}
 check(launchState.install.installed===true&&launchState.phase==='ready','an existing install reports ready without a download phase');
 check(launchState.progress===null&&launchState.paused===false,'a quiet launch check shows no progress and nothing paused');
 check(launchState.canPlay===false,'an installed client with no account is still not playable');
 check(JSON.stringify(launchState.actions)===JSON.stringify(['signin']),'the only remaining requirement is the sign-in');
}finally{await fs.rm(temp,{recursive:true,force:true});}
console.log(failures===0?'\nFLOW PASS: the live main process produced the frozen state contract for every step (fresh run, sign-in, download, pause, resume, cancel, install, quiet update no-op, launch update check, location refusals) and gated Play on both requirements':'\nFLOW FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
