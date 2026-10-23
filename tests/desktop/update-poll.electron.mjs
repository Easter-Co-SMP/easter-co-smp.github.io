// The background version question, in a real Electron window: a failing check is a line in the
// update log and nothing else, a newer release is staged and verified on disk without touching
// what the player sees, and a check held in flight does not delay a Play press. Nothing here
// waits for a timer in production code: the poller's interval is shortened by the harness, and
// the schedule itself is proven in tests/desktop/update-poll.test.cjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const require=createRequire(import.meta.url),{createPackage}=require('@electron/asar'),crypto=require('node:crypto');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'update-poll-'));
const stash=path.join(home,'Easter Company','launcher-updates');
await fs.mkdir(path.join(home,'Easter Company'),{recursive:true});
await fs.writeFile(path.join(home,'Easter Company','settings.json'),JSON.stringify({memoryMB:4096,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false}));
// The release the stub publishes: a real ASAR carrying this launcher's identity at 9.9.9, so
// main.cjs's own `launcherIdentity` check is the real one and accepts real code shape.
const source=path.join(home,'payload');
await fs.mkdir(source,{recursive:true});
await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'easter-company-launcher',version:'9.9.9'}));
const asar=path.join(home,'release.asar');
await createPackage(source,asar);
const published=await fs.readFile(asar);
const publishedHash=crypto.createHash('sha256').update(published).digest('hex');
// Electron's own `fs` reads through an `.asar` path as an archive, so the harness is handed the
// same bytes under a name that is not one. What lands in the stash is an ordinary ASAR again.
const stagedSource=path.join(home,'release.bin');
await fs.writeFile(stagedSource,published);
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/update-poll-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_POLL_ASAR:stagedSource,EASTER_POLL_INTERVAL:'400'}});
// What the player can see and what the state channel says, in one comparable shape. Any change
// to this between two checks is a change the poll caused, which is exactly what it must not do.
const snapshot=page=>page.evaluate(async()=>{
 const state=await window.easterDesktop.status();
 return {phase:state.phase,canPlay:state.canPlay,message:state.message,error:state.error,startupReady:state.startupReady,actions:state.actions,install:state.install,launcherUpdate:state.launcherUpdate,activity:state.activity};
});
const surfaces=async page=>({
 dialog:await page.locator('#desktop-update[open]').count(),
 notice:await page.locator('.desktop-page-notice').isVisible().catch(()=>false),
 spinner:await page.locator('.desktop-update-spinner:visible').count(),
 progress:await page.locator('#desktop-update [role=progressbar]:visible').count()
});
const waitFor=async (probe,label,timeout=20000)=>{
 const deadline=Date.now()+timeout;
 for(;;){
  const answer=await probe();
  if(answer)return answer;
  if(Date.now()>deadline)throw Error('timed out waiting for '+label);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const pid=await app.evaluate(()=>process.pid);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 await waitFor(async()=>(await page.evaluate(async()=>(await window.easterDesktop.status()).startupReady)),'the startup gate to open');
 const fields=await app.evaluate(()=>global.easterPollOptions);
 assert.equal(fields.current,'1.0.44','the poll is told which version this launcher is');
 assert.equal(fields.enabled,true,'the autoUpdateLauncher preference reaches the poller');
 assert.match(fields.root,/launcher-updates$/,'it stages into the same stash the startup gate uses');
 assert.equal(fields.probe,'function','main supplies the redirect question');
 assert.equal(fields.fetch,'function','and the transport the staging pipeline downloads through');
 assert.equal(fields.busy,'function','and the answer to "is the launcher busy?"');
 assert((await app.evaluate(()=>global.easterPollProbes))>=0,'the poll has begun asking on its own interval');

 // ---- 1. A failing check is one line in the log and nothing else ---------------------
 const before=await snapshot(page);
 assert.deepEqual(await surfaces(page),{dialog:0,notice:false,spinner:0,progress:0},'the first screen carries no update surface');
 await app.evaluate(()=>{global.easterPollMode='offline';});
 await waitFor(async()=>await app.evaluate(()=>global.easterPollLines.length),'a failed check');
 await new Promise(resolve=>setTimeout(resolve,600));   // a second tick would land here if the failure had armed one
 const failedLines=await app.evaluate(()=>global.easterPollLines);
 assert.deepEqual(failedLines.map(entry=>entry.outcome),['failed'],'one line, one failure');
 assert.match(await fs.readFile(path.join(home,'Easter Company','launcher-update.log'),'utf8'),/step=update-poll outcome=failed version=- note=ENOTFOUND/,'the update log records the unreachable check');
 assert.deepEqual(await snapshot(page),before,'an unreachable release server changes nothing the player or the view can see');
 assert.deepEqual(await surfaces(page),{dialog:0,notice:false,spinner:0,progress:0},'no dialog, no notice, no spinner, no progress');
 await assert.rejects(()=>fs.access(path.join(stash,'staged.json')),'a failed check stages nothing');
 await assert.rejects(()=>fs.access(path.join(stash,'current.json')),'and activates nothing');

 // ---- 2. A newer release is staged and verified, and still paints nothing ------------
 const beforeStage=await snapshot(page);
 await app.evaluate(()=>{global.easterPollMode='newer';});
 await waitFor(async()=>await app.evaluate(()=>global.easterPollLines.some(entry=>entry.note==='staged')),'a staged release');
 await app.evaluate(()=>{global.easterPollMode='current';});
 const record=JSON.parse(await fs.readFile(path.join(stash,'staged.json'),'utf8'));
 assert.equal(record.version,'9.9.9','the staged record names the release');
 assert.equal(record.sha256,publishedHash,'and carries the hash the payload was verified against');
 const payload=await fs.readFile(path.join(stash,publishedHash+'.asar'));
 assert.equal(crypto.createHash('sha256').update(payload).digest('hex'),publishedHash,'the payload on disk is the verified bytes, byte for byte');
 assert.equal(await app.evaluate(()=>global.easterPollDownloads),2,'one manifest read and one payload download: nothing is fetched to answer the question alone');
 await assert.rejects(()=>fs.access(path.join(stash,'current.json')),'a background stage never writes the activation record bootstrap loads');
 const afterStage=await snapshot(page);
 const withoutStaged=state=>({...state,launcherUpdate:{...state.launcherUpdate,staged:undefined}});
 assert.deepEqual(withoutStaged(afterStage),withoutStaged(beforeStage),'a staged update paints nothing: every other field of the state is exactly as it was');
 assert.equal(afterStage.launcherUpdate.phase,'current','the launcher update phase never moved off current');
 assert.deepEqual({version:afterStage.launcherUpdate.staged.version,from:afterStage.launcherUpdate.staged.from},{version:'9.9.9',from:'1.0.44'},'the staged release is published as one field for the restart ticket to use');
 assert.deepEqual(await surfaces(page),{dialog:0,notice:false,spinner:0,progress:0},'and no update surface appears while a stage is on disk');
 assert.equal(await app.evaluate(()=>process.pid),pid,'nothing restarted the launcher: it is the same process');

 // ---- 3. A check in flight does not delay Play, and cannot overlap the next one -------
 await page.locator('[data-desktop-play][data-action=download]').click();
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();
 await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 await app.evaluate(()=>{global.easterPollMode='hold';global.easterPollHeld.length=0;});
 await waitFor(async()=>await app.evaluate(()=>global.easterPollConcurrent),'a check to be in flight');
 const pressedAt=Date.now();
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor({timeout:15000});
 const launchMs=Date.now()-pressedAt;
 assert.equal(await app.evaluate(()=>global.easterPollConcurrent),1,'the check was still in flight when the game started: Play never waited for it');
 assert.equal(await app.evaluate(()=>global.easterPollMaxConcurrent),1,'no check ever overlapped another');
 assert(launchMs<15000,'the launch happened while the question was outstanding ('+launchMs+' ms)');
 // The held question is answered late; the poller is still exactly one check wide.
 await app.evaluate(()=>{global.easterPollMode='current';global.easterPollRelease();});
 await waitFor(async()=>(await app.evaluate(()=>global.easterPollConcurrent))===0,'the held check to settle');
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 await page.waitForFunction(async()=>(await window.easterDesktop.status()).phase==='ready');
 // A whole install, sign-in, launch and game exit happened with a staged release on disk and
 // the launcher never offered it: the phase the player was left on is the game's own return to
 // ready, and the launcher update phase is still `current`.
 const after=await page.evaluate(async()=>{const state=await window.easterDesktop.status();return {phase:state.phase,launcherUpdate:state.launcherUpdate};});
 assert.equal(after.phase,'ready','the game ending returned the hero to ready');
 assert.equal(after.launcherUpdate.phase,'current','and the launcher update phase never left current: a stage is not an offer');
 assert.deepEqual(after.launcherUpdate.staged&&{version:after.launcherUpdate.staged.version,from:after.launcherUpdate.staged.from},{version:'9.9.9',from:'1.0.44'},'the staged release is still published for the restart ticket to use');
 assert.deepEqual(await surfaces(page),{dialog:0,notice:false,spinner:0,progress:0},'and no update surface was ever shown');
 assert.equal(await app.evaluate(()=>process.pid),pid,'still the same process: nothing was relaunched or quit');
 assert.deepEqual(errors,[]);
 console.log('Update poll PASS: one 302 question, a failed check is one log line with the state and the screen untouched, a real 9.9.9 payload verified and staged without current.json or any surface, a check held in flight does not delay Play, no overlap, no relaunch.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
