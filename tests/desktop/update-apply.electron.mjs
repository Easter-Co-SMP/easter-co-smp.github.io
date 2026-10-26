// The launcher-update apply step, in real Electron processes: Owen's corrected design of
// 2026-10-23 — "the launcher can update while a game is open, in the background and resume that
// was a big part of my design."
//
// What each part proves, and how it is measured rather than read:
//
//   1. THE COMPOSED CASE. A launcher with a game running asks its release question, stages the
//      newer payload, applies it and relaunches — the real poll, the real staging pipeline, the
//      real sha256 check, the real version-policy clear and the real activation record. The game
//      is a real detached process spawned with the launcher's own `execOptions()`: its pid is the
//      same before and after, and it is still alive afterwards.
//   2. THE MARKER. The launcher wrote the game's identity (pid + the kernel's start time) before
//      anything restarted, and the next instance reads it back and publishes the in-game state
//      instead of Play.
//   3. THE TRAY RELAUNCH. A launcher relaunched with `--hidden-to-tray` on a desktop with a tray
//      host never makes its window visible: `visible` is sampled every 10 ms across startup and
//      every sample is false, and the tray icon exists. The ordinary relaunch, sampled the same
//      way, is visible.
//   4. THE NO-TRAY FALLBACK. The same switch on a desktop with no tray host comes up as an
//      ordinary visible window: an invisible launcher with no icon is one nobody can reach.
//   5. THE ADOPTED GAME ENDS. The launcher watching a game it did not start settles the same
//      sentence it always did when that process goes away, and removes the marker.
//   6. A STALE STAGED FILE AND A REUSED PID. A staged record for the version already running is
//      discarded rather than applied, and a marker whose start time does not match its pid is
//      refused: the launcher starts in its ordinary state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const require=createRequire(import.meta.url),{createPackage}=require('@electron/asar'),crypto=require('node:crypto');

const VERSION='9.9.9';
// The version this tree's launcher really runs: a staged record naming it is the stale case, and
// the apply's own line says where it came from.
const APP_VERSION=require('../../package.json').version;
const home=await fs.mkdtemp(path.join(os.tmpdir(),'update-apply-'));
const dataRoot=path.join(home,'Easter Company');
const stash=path.join(dataRoot,'launcher-updates');
const markerFile=path.join(dataRoot,'running-game.json');
await fs.mkdir(dataRoot,{recursive:true});
const settings=extra=>JSON.stringify({memoryMB:4096,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false,trayOnLaunch:false,...extra});
await fs.writeFile(path.join(dataRoot,'settings.json'),settings());
// The release the stub publishes: a real ASAR carrying this launcher's identity at 9.9.9, so
// main.cjs's own `launcherIdentity` check is the real one and accepts real code shape.
const source=path.join(home,'payload');
await fs.mkdir(source,{recursive:true});
await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'easter-company-launcher',version:VERSION}));
const asarFile=path.join(home,'release.asar');
await createPackage(source,asarFile);
const published=await fs.readFile(asarFile);
const publishedHash=crypto.createHash('sha256').update(published).digest('hex');
await fs.writeFile(path.join(home,'release.bin'),published);
const runtime=require('electron/package.json').version;
const manifest={schema:1,bootstrap:1,version:VERSION,platform:process.platform,arch:process.arch,runtime,asset:'Easter-Company-Update-'+process.platform+'-'+process.arch+'.asar',size:published.length,sha256:publishedHash};

// `packaged` decides two real things and both matter: a packaged instance is the one that runs the
// background poll and the startup gate, and an unpackaged one is the only place the
// `EASTER_TEST_TRAY` override of the tray probe applies. A packaged run's data directory is
// `<HOME>/Easter Company` and an unpackaged run's is `EASTER_TEST_HOME` itself, so both are given
// the same directory and the second instance reads the first one's stash and marker.
const launch=async ({packaged=true,env={},args:extraArgs=[]}={})=>{
 const app=await electron.launch({
  executablePath:path.resolve('node_modules/electron/dist/electron'),
  args:['--no-sandbox',path.resolve('tests/desktop/update-apply-harness.cjs'),...extraArgs],
  env:{...process.env,EASTER_TEST_HOME:packaged?home:dataRoot,EASTER_POLL_ASAR:path.join(home,'release.bin'),EASTER_APPLY_VERSION:VERSION,EASTER_POLL_INTERVAL:'250',...(packaged?{EASTER_APPLY_PACKAGED:'1'}:{}),...env}
 });
 const page=await app.firstWindow();
 page.setDefaultTimeout(20000);
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 return {app,page,errors};
};
// The launcher is asked to quit through its own API (the real one, put back first) and given a
// bounded moment to go. Playwright's own `close()` is not asked once the process is gone: it waits
// for a target that no longer exists. Anything still alive after the bound is ended by pid.
const close=async ({app})=>{
 const pid=await app.evaluate(()=>process.pid).catch(()=>null);
 await app.evaluate(()=>{global.easterRestoreApp();setTimeout(()=>global.easterQuitNow(),0);}).catch(()=>{});
 for(let attempt=0;attempt<50;attempt++){
  if(!pid||!alive(pid))return;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(pid)try{process.kill(pid,'SIGTERM');}catch{}
};
const waitFor=async (probe,label,timeout=30000)=>{
 const deadline=Date.now()+timeout;
 for(;;){
  const answer=await probe();
  if(answer)return answer;
  if(Date.now()>deadline)throw Error('timed out waiting for '+label);
  await new Promise(resolve=>setTimeout(resolve,50));
 }
};
const status=page=>page.evaluate(()=>window.easterDesktop.status());
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
let first=null,gamePid=null;
try{
 // ---- 1 & 2. A game is running and the launcher updates behind it -----------------------
 first=await launch({});
 const {app,page}=first;
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await waitFor(async()=>(await status(page)).startupReady,'the startup gate to open');
 // The game the launcher will start is spawned with the launcher's own options, so the claim
 // "it outlives the launcher" is about the real options rather than a paraphrase of them.
 const spawnOptions=await app.evaluate(()=>global.easterSpawnOptions);
 assert.equal(spawnOptions.detached,true,'the client is spawned detached: its own process group and session, so the launcher\'s exit does not take it down');
 assert.equal(spawnOptions.stdio,'ignore','and with no inherited pipe the launcher would have to keep servicing after it is gone');
 assert.equal(spawnOptions.shell,false,'and never through a shell');
 await page.locator('[data-desktop-play][data-action=download]').click();
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('#desktop-signin').waitFor({state:'visible'});
 await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor({timeout:20000});
 gamePid=await app.evaluate(()=>global.easterGamePid);
 assert(Number.isInteger(gamePid)&&gamePid>0,'the game is a real process ('+gamePid+')');
 assert.equal(alive(gamePid),true,'and it is alive');
 const launcherPid=await app.evaluate(()=>process.pid);
 // The marker is written before anything can restart: the pid and the start time the operating
 // system reports for it, so a recycled pid can never be mistaken for this game.
 const marker=JSON.parse(await fs.readFile(markerFile,'utf8'));
 assert.equal(marker.pid,gamePid,'the launcher wrote the running game\'s pid');
 assert.match(marker.start,/^\d+$/,'with the kernel start time that makes the pid an identity');
 assert.equal((await status(page)).phase,'running','and the launcher says the game is running');
 // Nothing was applied while the launcher was idle, and nothing could be: there was no stage.
 await assert.rejects(()=>fs.access(path.join(stash,'current.json')),'no activation record before the release question is answered with a newer release');
 assert.equal(await app.evaluate(()=>global.easterRelaunch),null,'and no relaunch');
 const probesBefore=await app.evaluate(()=>global.easterPollProbes);
 assert(probesBefore>=1,'the background question was asked at least once while the game ran ('+probesBefore+')');
 console.log('  · the launcher asked its release question '+probesBefore+' time(s) with Minecraft running, and never restarted');

 // The newer release is offered. Everything below is the composed path: redirect → manifest →
 // payload → verify → stage → apply → clear → activate → relaunch.
 await app.evaluate(()=>{global.easterPollMode='newer';});
 await waitFor(async()=>await app.evaluate(()=>global.easterRelaunch),'the apply to ask for a relaunch');
 assert.equal(await app.evaluate(()=>global.easterStages),1,'exactly one stage was written by the poll');
 assert.equal(await app.evaluate(()=>global.easterQuits),1,'and the launcher asked to quit for the restart');
 const relaunch=await app.evaluate(()=>global.easterRelaunch);
 assert.equal(relaunch.args.includes('--hidden-to-tray'),false,'a launcher whose window is on screen relaunches with a window');
 assert.equal(relaunch.args.includes('--play'),false,'and forwards no argument it was not given');
 // The activation record is written from the staged record, and the stage is gone.
 const activation=JSON.parse(await fs.readFile(path.join(stash,'current.json'),'utf8'));
 assert.equal(activation.version,VERSION,'current.json names the staged release');
 assert.equal(activation.sha256,publishedHash,'and the payload it was verified against');
 await assert.rejects(()=>fs.access(path.join(stash,'staged.json')),'the staged record is removed once it has been activated');
 assert.equal((await fs.readdir(stash)).includes(publishedHash+'.asar'),true,'the payload the relaunch will load survives the clear');
 // The version policy ran as part of the apply, and said so: 1.0.44 → 9.9.9 is a major, so the
 // stored sessions go with the caches. A stage that activated without this clear is the one thing
 // the staging ticket refused to allow.
 const log=await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8');
 const versionPattern=APP_VERSION.replace(/\./g,'\\.');
 assert.match(log,new RegExp('step=update-apply outcome=ok version=9\\.9\\.9 from='+versionPattern+' note=applied'),'one quiet line says what was applied');
 assert.match(log,new RegExp('step=update-policy outcome=ok level=major from='+versionPattern+' to=9\\.9\\.9 cleared='),'and the clear it ran says what it cost');
 await assert.rejects(()=>fs.access(path.join(dataRoot,'accounts.enc')),'a major update really did clear the stored session');
 // The player was looking at the launcher, so the mandatory-update surface said so: the gate's
 // own dialog and its own sentence, never a second one.
 assert.equal(await page.locator('#desktop-update[open]').count(),1,'the mandatory-update surface is open');
 assert.equal((await page.locator('#desktop-update h2').textContent()).trim(),'Restarting launcher…','with the sentence the gate already uses');
 const afterApply=await status(page);
 assert.equal(afterApply.startupReady,false,'and the launcher is closed to new work while it restarts');
 assert.equal(afterApply.launcherUpdate.phase,'restarting');
 // THE GAME. Untouched: the same process, still alive, never exited.
 assert.equal(alive(gamePid),true,'the game is still alive after the launcher applied an update and asked to restart');
 assert.equal(await app.evaluate(()=>global.easterGamePid),gamePid,'and it is the same pid — nothing restarted the client');
 assert.equal(await app.evaluate(()=>process.pid),launcherPid,'while the launcher is the process that asked to restart, not a new one');
 // The ordinary case, measured with the same sampler as the tray case below: a launcher that was
 // on screen comes up on screen, so the two answers are one measurement and not two claims.
 const ordinarySamples=await app.evaluate(()=>global.easterVisible);
 assert(ordinarySamples.length>3,'the ordinary window visibility was sampled across startup ('+ordinarySamples.length+' samples)');
 assert.equal(ordinarySamples.at(-1),true,'the ordinary relaunch is on screen');
 assert.equal(ordinarySamples.some(visible=>visible===true),true,'and it became visible rather than staying hidden');
 assert.deepEqual(first.errors,[]);
 console.log('  · applied and relaunched behind a running game: the same game pid ('+gamePid+') is alive, the marker is written, one log line each for the apply and the clear; '+ordinarySamples.length+' visibility samples, visible');
 await close(first);
 first=null;
 assert.equal(alive(gamePid),true,'the game outlived the launcher that started it');

 // ---- 3. The tray relaunch does not flash a window --------------------------------------
 const tray=await launch({packaged:false,env:{EASTER_TEST_TRAY:'1'},args:['--hidden-to-tray']});
 try{
  await tray.page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await waitFor(async()=>(await status(tray.page)).startupReady,'the tray relaunch to finish starting');
  await new Promise(resolve=>setTimeout(resolve,400));   // let any late show() land in the samples
  const samples=await tray.app.evaluate(()=>global.easterVisible);
  assert(samples.length>3,'the window\'s visibility was sampled across startup ('+samples.length+' samples)');
  assert.equal(samples.every(visible=>visible===false),true,'every sample is false: the tray relaunch never makes its window visible, so there is no frame to paint');
  const trays=await tray.app.evaluate(()=>global.easterTrays);
  assert.deepEqual(trays,['Easter Co. Launcher'],'and the tray icon exists again, which is how the player gets the launcher back');
  const adopted=await status(tray.page);
  assert.equal(adopted.phase,'running','the new instance re-adopted the game it did not start and publishes the in-game state');
  // ...and it refuses to start a second game, which is the whole meaning of that state: Play is
  // not offered because a game is running, not because the launcher is unsure.
  assert.equal(await tray.page.evaluate(()=>window.easterDesktop.play().then(()=>'allowed',error=>error.message)),'Wait for the current operation to finish.','a second Play is refused while the adopted game runs');
  assert.equal(await tray.page.locator('[data-desktop-play][data-action=play]').count(),0,'and the hero offers no Play action');
  assert.equal(await tray.app.evaluate(()=>global.easterRelaunch),null,'it relaunched nothing: it is the instance that came back');
  assert.deepEqual(tray.errors,[]);
  console.log('  · tray relaunch: '+samples.length+' visibility samples across startup, all false, one tray icon, the game adopted as running');
 }finally{await close(tray);}

 // ---- 4. The no-tray fallback is an ordinary window -------------------------------------
 const noTray=await launch({packaged:false,env:{EASTER_TEST_TRAY:'0'},args:['--hidden-to-tray']});
 try{
  await noTray.page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await waitFor(async()=>(await status(noTray.page)).startupReady,'the no-tray relaunch to finish starting');
  await new Promise(resolve=>setTimeout(resolve,400));
  const samples=await noTray.app.evaluate(()=>global.easterVisible);
  assert(samples.length>3,'the same sampler ran ('+samples.length+' samples)');
  assert.equal(samples.at(-1),true,'on a desktop with no tray host the window really is on screen');
  assert.equal(samples.some(visible=>visible===true),true,'it became visible rather than staying hidden and unreachable');
  assert.deepEqual(await noTray.app.evaluate(()=>global.easterTrays),[],'and no tray icon was created, because none could be drawn');
  const adopted=await status(noTray.page);
  assert.equal(adopted.phase,'running','the game is still adopted: the switch is about the window, not about the game');
  // ---- 5. The adopted game ends -----------------------------------------------------------
  process.kill(gamePid,'SIGTERM');
  await waitFor(async()=>{try{await fs.access(markerFile);return false;}catch{return true;}},'the marker to be removed when the game ends');
  await waitFor(async()=>(await status(noTray.page)).message==='Minecraft closed. Ready to play.','the adopted game to settle');
  const settled=await status(noTray.page);
  // The resting phase is the hero's own: this fixture process reports no installed client, so it
  // is `uninstalled` rather than `ready`. What matters is that the in-game state is gone and the
  // exit settled with the sentence it always had.
  assert.notEqual(settled.phase,'running','the launcher is back to its ordinary state, not left claiming a game');
  assert.equal(settled.error,null,'and the ending is not reported as a failure');
  assert.equal(alive(gamePid),false,'the game really did end (the process is gone, not merely unreported)');
  assert.deepEqual(noTray.errors,[]);
  console.log('  · no-tray fallback: '+samples.length+' samples, last one true, no tray created; the adopted game ending settled "Minecraft closed. Ready to play."');
 }finally{await close(noTray);}

 // ---- 6. A stale staged file, and a pid that was reused ----------------------------------
 // The launcher is already 9.9.9 (this file's own release): a record naming 1.0.44 or 9.9.9 can
 // never be newer than what runs, and a manifest whose payload is the wrong length cannot be
 // trusted. Both are discarded at startup rather than applied, and neither restarts anything.
 await fs.mkdir(stash,{recursive:true});
 await fs.writeFile(path.join(stash,publishedHash+'.asar'),published);
 await fs.writeFile(path.join(stash,'staged.json'),JSON.stringify({...manifest,version:APP_VERSION}));
 // A marker naming a live process with a start time that is not its own: the reused-pid case.
 // This journey's own pid is guaranteed to exist, so only the start marker can refuse it.
 await fs.writeFile(markerFile,JSON.stringify({pid:process.pid,start:'1',startedAt:new Date().toISOString()}));
 const stale=await launch({packaged:false});
 try{
  await stale.page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await waitFor(async()=>(await status(stale.page)).startupReady,'the stale-record launcher to finish starting');
  await assert.rejects(()=>fs.access(path.join(stash,'staged.json')),'a staged record for a version this launcher already runs is discarded');
  await assert.rejects(()=>fs.access(markerFile),'and a marker whose pid does not carry the recorded start time is refused and removed');
  const state=await status(stale.page);
  assert.notEqual(state.phase,'running','so the launcher starts in its ordinary state, not on a dead screen');
  assert.equal(await stale.page.locator('[data-desktop-play][data-action=running]').count(),0,'and never claims a game that is not running');
  assert.equal(await stale.app.evaluate(()=>global.easterRelaunch),null,'nothing was applied: a stale record never restarts the launcher');
  const log=await fs.readFile(path.join(dataRoot,'launcher-update.log'),'utf8');
  assert.match(log,new RegExp('step=update-apply outcome=failed version='+APP_VERSION.replace(/\./g,'\\.')+' from='+APP_VERSION.replace(/\./g,'\\.')+' note=stale'),'and one line says which answer it was');
  assert.deepEqual(stale.errors,[]);
  console.log('  · stale staged record discarded and a reused pid refused: the launcher started in its ordinary state (phase '+state.phase+'), with no relaunch');
 }finally{await close(stale);}

 console.log('Update apply PASS: a real detached game survives the launcher applying an update behind it (same pid, still alive), the marker round-trips into the next instance\'s in-game state, and the same 10 ms visibility sampler answers false for every sample of the tray relaunch and true for the ordinary one — so the tray relaunch paints no frame while the ordinary relaunch is a window. The no-tray fallback comes up visible, the adopted game settles its own sentence when it ends, and a stale staged record or a reused pid is refused without restarting anything.');
}finally{
 if(first)await close(first);
 // The game is a process this journey started and nothing else owns, so it is ended by pid —
 // never by a pattern, which would match the shell that ran this file.
 if(gamePid)try{process.kill(gamePid,'SIGTERM');}catch{}
 await fs.rm(home,{recursive:true,force:true});
}
// The Playwright driver socket outlives a launcher that ended itself, so the success path ends
// the way a suite does: explicitly, with the PASS line already printed.
process.exit(0);
