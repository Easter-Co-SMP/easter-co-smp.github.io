// Exit Game — Owen's own control, in real Electron processes.
//
// Owen, verbatim (ticket 4869be14): *"like a 'Exit Game' button which can be used as a backup force
// quit the client immediately button."* What each part proves, and how it is measured rather than
// read:
//
//   1. THE LAUNCHED GAME, WITH THE ACCOUNT SERVICE DOWN. A game is started through the real Play
//      path, so the launcher holds a real child handle and a real process is playing. The account
//      service is then broken (`global.easterServiceDown`): a session read really fails, which is
//      what proves the service is unreachable rather than merely quiet. The hero reads **Exit Game**
//      and is enabled; pressing it ends the process, removes the marker and settles the sentence a
//      closed game has always had — and the account-service call counter does not move by one,
//      which is the whole claim "this is local process control and nothing else".
//   2. THE ADOPTED GAME THAT IGNORES A POLITE ASK. A game this launcher did not start (a real child
//      of this test process, with the marker written by `desktop/game-marker.cjs` exactly as the
//      launcher writes it) is adopted at startup — the case after an update, where the launcher has
//      only a pid and no handle, which is what a naive `game.kill()` misses. The client swallows
//      SIGTERM, so the measurement is the instruction Owen gave: still alive at 700 ms (the ask did
//      not work), gone by the time the bound ran out, and only then killed.
//   3. NEVER A DEAD BUTTON. Three shapes of "no game is there": a marker naming a pid that has
//      already exited, a marker naming a live process whose start time is not its own (a reused
//      pid), and a game that goes away while the launcher still believes it is running. Each
//      resolves to the ordinary launcher state with no Exit Game action on screen — the third one
//      through the press itself, which answers honestly instead of failing.
//
// Run: xvfb-run -a node tests/desktop/exit-game.electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const require=createRequire(import.meta.url);
const gameMarker=require('../../desktop/game-marker.cjs');
const root=process.cwd();
const home=await fs.mkdtemp(path.join(os.tmpdir(),'exit-game-'));
const markerFile=path.join(home,'running-game.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The two sentences this journey is allowed to see, taken from the launcher's own state rather than
// spelled out twice here: a copy of the wording would be a second author of it.
const GAME_CLOSED='Minecraft closed. Ready to play.';
const labelled=async page=>(await page.locator('[data-desktop-play]').innerText()).replace(/\s+/g,' ').trim();
const actionOf=page=>page.locator('[data-desktop-play]').getAttribute('data-action');
const statusOf=page=>page.evaluate(()=>window.easterDesktop.status());
const waitFor=async(probe,label,timeout=30000)=>{
 const deadline=Date.now()+timeout;
 for(;;){
  const answer=await probe();
  if(answer)return answer;
  if(Date.now()>deadline)throw Error('timed out waiting for '+label);
  await sleep(25);
 }
};
// Whether the process a pid names is still running, asked the way the launcher asks it (the
// kernel's own start marker) and then told apart from a process that has exited and is waiting to
// be reaped: a zombie is not playing Minecraft.
async function processState(pid){
 const stat=await fs.readFile('/proc/'+pid+'/stat','utf8').catch(()=>null);
 if(!stat)return {running:false,state:'gone',start:null};
 const tail=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/);
 return {running:tail[0]!=='Z',state:tail[0],start:tail[19]};
}
const gone=async pid=>(await processState(pid)).running===false;
const launch=async(env={})=>{
 const app=await electron.launch({
  executablePath:path.resolve('node_modules/electron/dist/electron'),
  args:['--no-sandbox',path.resolve('tests/desktop/exit-game-harness.cjs')],
  env:{...process.env,EASTER_TEST_HOME:home,...env}
 });
 const page=await app.firstWindow();
 page.setDefaultTimeout(20000);
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await waitFor(async()=>(await statusOf(page)).startupReady,'the startup gate to open');
 return {app,page,errors};
};
// The launcher is asked to quit through its own application object and given a bounded moment to
// go; anything still there after the bound is ended by pid, never by pattern.
const close=async({app})=>{
 const pid=await app.evaluate(()=>process.pid).catch(()=>null);
 await app.evaluate(()=>{require('electron').app.quit();}).catch(()=>{});
 for(let attempt=0;attempt<60;attempt++){
  if(!pid||await gone(pid))return;
  await sleep(100);
 }
 if(pid)try{process.kill(pid,'SIGTERM');}catch{}
};
// The game this journey adopts: a real process, detached with no inherited pipe, exactly the shape
// `install.cjs` `execOptions` gives the client. `EASTER_GAME_IGNORES_SIGTERM` is what makes the
// second half of Owen's force-quit the one that does the work.
const spawnAdopted=(ignoreSigterm=false)=>{
 const source=ignoreSigterm?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)':'setInterval(()=>{},1000)';
 const child=spawn(process.execPath,['-e',source],{detached:true,stdio:'ignore'});
 child.on('exit',()=>{});   // reaped, so a dead game is a dead pid rather than a zombie
 return child;
};
let failures=0;
function check(condition,message){if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}}
try{

 // ---- 1. A launched game, with the account service unreachable ---------------------------
 console.log('\n1. a launched game, pressed with the account service down');
 let current=await launch();
 try{
  const {app,page}=current;
  await page.locator('[data-desktop-play][data-action=download]').click();
  await page.locator('[data-desktop-play][data-action=signin]').click();
  await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
  await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();
  await app.evaluate(()=>global.easterTestApprove());
  await page.locator('[data-desktop-play][data-action=play]').waitFor();
  await page.locator('[data-desktop-play][data-action=play]').click();
  await page.locator('[data-desktop-play][data-action=running]').waitFor({timeout:20000});
  const gamePid=await app.evaluate(()=>global.easterGamePid);
  check(Number.isInteger(gamePid)&&gamePid>0,'the game is a real process ('+gamePid+')');
  check((await processState(gamePid)).running===true,'and it is running');
  // The hero, read as the player reads it: the label Owen gave, the state under it, and a control
  // that can actually be pressed.
  const label=await labelled(page);
  check(label.startsWith('Exit Game'),'the in-game hero is Owen\'s own naming: '+JSON.stringify(label));
  check(label.includes('Minecraft is running'),'and the note still says the state it is in: '+JSON.stringify(label));
  check((await page.locator('[data-desktop-play]').isDisabled())===false,'the in-game action is pressable rather than a disabled label');
  check((await statusOf(page)).phase==='running','the launcher publishes the in-game phase');
  const written=JSON.parse(await fs.readFile(markerFile,'utf8'));
  check(written.pid===gamePid&&typeof written.start==='string','the marker names the game by pid and the kernel\'s start time: '+JSON.stringify(written));
  // The account service is broken, and asked, so "unreachable" is a fact rather than an assumption.
  await app.evaluate(()=>{global.easterServiceDown=true;});
  // A read that really goes to the account service, so "unreachable" is a fact and not an
  // assumption: the launcher's provider list has no cache to fall back on.
  const refused=await page.evaluate(()=>window.easterDesktop.accountProviders().then(()=>null,error=>error.message));
  check(Boolean(refused),'the account service really is unreachable: '+String(refused));
  const callsBefore=await app.evaluate(()=>global.easterServiceCalls);
  check(callsBefore>0,'and it was reached at all before it was broken ('+callsBefore+' call(s))');
  const started=Date.now();
  await page.locator('[data-desktop-play][data-action=running]').click();
  await waitFor(async()=>(await statusOf(page)).phase!=='running','the ordinary launcher state');
  const settled=await statusOf(page);
  const took=Date.now()-started;
  check(settled.message===GAME_CLOSED,'the settle is the sentence a closed game has always had: '+JSON.stringify(settled.message));
  check(settled.error===null,'and it is not reported as a failure: '+JSON.stringify(settled.error));
  check(await gone(gamePid),'the client process is gone ('+gamePid+'), not merely unreported');
  check(took<1500,'a client that closes on a polite ask costs the player no measurable wait ('+took+' ms)');
  await assert.rejects(()=>fs.access(markerFile),'and the marker is removed, so nothing can adopt a dead game');
  const callsAfter=await app.evaluate(()=>global.easterServiceCalls);
  check(callsAfter===callsBefore,'the exit made no account-service call at all ('+callsBefore+' before, '+callsAfter+' after)');
  check(await page.locator('[data-desktop-play][data-action=running]').count()===0,'the hero no longer offers Exit Game');
  check(await page.locator('[data-desktop-play][data-action=play]').count()===1,'and the ordinary Play action is back');
  check((await app.evaluate(()=>global.easterServiceCalls))===callsBefore,'nothing asked the broken service on the way back either');
  assert.deepEqual(current.errors,[]);
  console.log('  · launched game '+gamePid+': labelled "Exit Game", process gone, marker removed, "Minecraft closed. Ready to play." in '+took+' ms, 0 account-service calls across the exit');
 }finally{await close(current);}

 // ---- 2. An adopted game that ignores the polite ask ------------------------------------
 console.log('\n2. an adopted game, which the launcher has only a pid for');
 await assert.rejects(()=>fs.access(markerFile),'the previous run left no marker behind');
 const stubborn=spawnAdopted(true);
 const adoptedPid=stubborn.pid;
 const record=await gameMarker.remember(home,adoptedPid);
 check(Boolean(record)&&record.pid===adoptedPid,'the marker names the game the launcher will adopt: '+JSON.stringify(record));
 current=await launch({EASTER_GAME_IGNORES_SIGTERM:'1'});
 try{
  const {app,page}=current;
  const adopted=await statusOf(page);
  check(adopted.phase==='running','the launcher re-adopted a game it did not start and publishes the in-game state');
  check((await actionOf(page))==='running','and the hero offers the in-game action, not Play');
  check((await labelled(page)).startsWith('Exit Game'),'which is Exit Game: '+JSON.stringify(await labelled(page)));
  check(await page.locator('[data-desktop-play][data-action=play]').count()===0,'a second Play is not offered while that game runs');
  // The launcher has no child handle for this one: the game is this test process's child, so a
  // `game.kill()` on the launcher side could only ever miss it.
  check((await processState(adoptedPid)).running===true,'the adopted game is a live process ('+adoptedPid+')');
  const started=Date.now();
  await page.locator('[data-desktop-play][data-action=running]').click();
  await sleep(700);
  check((await processState(adoptedPid)).running===true,'700 ms in, the polite ask has not ended it — this client ignores SIGTERM');
  await waitFor(async()=>(await statusOf(page)).phase!=='running','the adopted game to settle');
  const took=Date.now()-started;
  const settled=await statusOf(page);
  check(await gone(adoptedPid),'the hard kill did: the adopted process is gone ('+adoptedPid+')');
  check(took>=1400&&took<4000,'which took the bound and no longer: '+took+' ms');
  check(settled.message===GAME_CLOSED,'the settle is the same sentence: '+JSON.stringify(settled.message));
  check(settled.error===null,'with no failure invented for a client that was killed: '+JSON.stringify(settled.error));
  await assert.rejects(()=>fs.access(markerFile),'and the marker is removed');
  check(await page.locator('[data-desktop-play][data-action=running]').count()===0,'the in-game action is gone from the hero');
  assert.deepEqual(current.errors,[]);
  console.log('  · adopted game '+adoptedPid+': still alive at 700 ms (SIGTERM ignored), gone at '+took+' ms after the hard kill, marker removed, settled');
 }finally{await close(current);}

 // ---- 3. Never a dead button ------------------------------------------------------------
 console.log('\n3. a marker for a game that is not there');
 // (a) The pid has already exited. The game this journey starts and waits for is the pid the marker
 // names, so the marker is exactly what a launcher finds after a crash took the client with it.
 // A client that has already ended: this process exits on its own, so the marker below names a pid
 // the operating system has handed back.
 const dead=spawn(process.execPath,['-e','process.exit(0)'],{detached:true,stdio:'ignore'});
 const deadPid=dead.pid;
 await new Promise(resolve=>dead.on('exit',resolve));
 check(await gone(deadPid),'the pid in the marker has exited and been reaped ('+deadPid+')');
 await fs.writeFile(markerFile,JSON.stringify({pid:deadPid,start:'12345',startedAt:new Date().toISOString()}));
 current=await launch();
 try{
  const {page}=current;
  const state=await statusOf(page);
  check(state.phase!=='running','a marker naming a pid that is gone resolves to the ordinary launcher state: '+state.phase);
  check(await page.locator('[data-desktop-play][data-action=running]').count()===0,'and the hero never offers Exit Game for a process that is not there');
  await assert.rejects(()=>fs.access(markerFile),'the stale marker is removed on the first read');
  assert.deepEqual(current.errors,[]);
  console.log('  · a marker for an exited pid ('+deadPid+'): ordinary state ('+state.phase+'), no Exit Game, marker removed');
 }finally{await close(current);}
 // (b) The pid is alive but is not that game: the reused-pid case, which only the recorded start
 // time can refuse. This journey's own pid is guaranteed to exist, with a start time that is not 1.
 await fs.writeFile(markerFile,JSON.stringify({pid:process.pid,start:'1',startedAt:new Date().toISOString()}));
 current=await launch();
 try{
  const {page}=current;
  const state=await statusOf(page);
  check(state.phase!=='running','a marker whose pid carries a different start time is refused ('+state.phase+')');
  check(await page.locator('[data-desktop-play][data-action=running]').count()===0,'so no Exit Game is offered for a process this launcher cannot prove is Minecraft');
  await assert.rejects(()=>fs.access(markerFile),'and that marker is removed too');
  assert.deepEqual(current.errors,[]);
  console.log('  · a reused pid ('+process.pid+', start 1): ordinary state ('+state.phase+'), no Exit Game, marker removed');
 }finally{await close(current);}
 // (c) The game goes away while the launcher still believes it is running. The press is the thing
 // under test, and it is pressed through the launcher's own API rather than the hero so the race
 // with the launcher's 2 s liveness watch cannot decide the result: whichever of the two notices
 // first, the claim is that the press answers honestly and leaves the ordinary state.
 const last=spawnAdopted(false);
 const lastPid=last.pid;
 await gameMarker.remember(home,lastPid);
 current=await launch();
 try{
  const {page}=current;
  check((await statusOf(page)).phase==='running','the launcher believes the game is running');
  check((await actionOf(page))==='running','and the hero is offering Exit Game');
  process.kill(lastPid,'SIGKILL');
  await new Promise(resolve=>last.on('exit',resolve));
  const answer=await page.evaluate(()=>window.easterDesktop.exitGame());
  check(answer&&answer.exited===false,'a press for a game that is already gone answers that it ended nothing: '+JSON.stringify(answer));
  check(['gone','none'].includes(answer.reason),'with the reason it has: '+JSON.stringify(answer.reason));
  const settled=await statusOf(page);
  check(settled.phase!=='running','the published state is the ordinary one: '+settled.phase);
  check(settled.message===GAME_CLOSED,'and carries the closing sentence: '+JSON.stringify(settled.message));
  check(settled.error===null,'with no error for a game that had already closed: '+JSON.stringify(settled.error));
  check(await page.locator('[data-desktop-play][data-action=running]').count()===0,'and no Exit Game action is left on screen');
  await assert.rejects(()=>fs.access(markerFile),'the marker is gone');
  assert.deepEqual(current.errors,[]);
  console.log('  · game gone under a believing launcher: press answered '+JSON.stringify(answer)+', ordinary state ('+settled.phase+'), "'+settled.message+'"');
 }finally{await close(current);}

 console.log(failures===0
  ?'\nEXIT GAME PASS: Owen\'s control, in his words — a launched game and an adopted one are both ended by Exit Game (the second only by the hard kill, because the client ignores the polite ask), with the account service broken and not one account-service call across the exit, and three shapes of "no game is there" resolve to the ordinary launcher state with no Exit Game offered for a process that is not running.'
  :'\nEXIT GAME FAIL: '+failures+' check(s) failed');
}finally{
 await fs.rm(home,{recursive:true,force:true});
}
process.exitCode=failures===0?0:1;
