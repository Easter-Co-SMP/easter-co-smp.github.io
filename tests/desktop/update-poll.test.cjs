// The background version question (ticket 2cd301e3): the schedule, the cheap source, the
// quiet failure, and a stage that leaves the activation record alone. Everything here runs
// on fixtures: a stubbed redirect hop, a stubbed transport, an injected clock. No network,
// no Electron, no relaunch.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const updater=require('../../desktop/updater.cjs');
const {pollDelay,latestVersion,tagVersion,createLauncherPoll,staged,update,UpdateLog,POLL_INTERVAL_MS,POLL_JITTER_MS,POLL_BACKOFF_CAP_MS,POLL_TIMEOUT_MS}=updater;
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const RUNTIME=require('electron/package.json').version;
const tempDir=prefix=>fs.mkdtemp(path.join(os.tmpdir(),prefix));
const TAG='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v9.9.9';
// A clock that does not run: every armed timer is recorded with its delay, and nothing fires
// until the test says so. That is what makes "15 minutes, then 30 after a failure" a fact
// rather than a wait.
function fakeClock(){
 const armed=[];
 return {
  armed,
  timers:{
   setTimeout(fn,ms){const handle={fn,ms,unref(){handle.unrefd=true;return handle;},cleared:false};armed.push(handle);return handle;},
   clearTimeout(handle){if(handle)handle.cleared=true;}
  },
  next(){const handle=armed.find(entry=>!entry.cleared&&!entry.fired);if(!handle)return null;handle.fired=true;return handle;},
  delays(){return armed.map(entry=>entry.ms);}
 };
}
// The manifest and the payload the way a release publishes them: one JSON asset and one
// ASAR-shaped byte string, whose sha256 the manifest declares.
function release({version='9.9.9'}={}){
 const bytes=Buffer.from('staged launcher payload for '+version+'\n'.repeat(64));
 const manifest={schema:1,bootstrap:1,version,platform:process.platform,arch:process.arch,runtime:RUNTIME,asset:'Easter-Company-Update-'+process.platform+'-'+process.arch+'.asar',size:bytes.length,sha256:sha256(bytes)};
 return {bytes,manifest};
}
// The transport the launcher hands to the poller, nothing more: a manifest response and an
// asset response. Calls are recorded so "asked once" and "downloaded once" are checkable.
function transport({version='9.9.9',fail=false}={}){
 const {bytes,manifest}=release({version});
 const calls=[];
 const fetch=async (url,init={})=>{
  calls.push({
   url,
   redirected:init.redirect,
   // A poll must never ask the API, must never send a token, and must never follow a redirect.
   token:Boolean((init.headers&&(init.headers.Authorization||init.headers.authorization))||init.redirect==='follow'),
   signal:Boolean(init.signal)
  });
  if(fail)throw Object.assign(new Error('getaddrinfo EAI_AGAIN github.com'),{name:'TypeError'});
  if(url.endsWith('.json'))return new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}});
  return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
 };
 return {calls,fetch,bytes,manifest};
}

test('the interval is fifteen minutes, with jitter on top and a named backoff cap',async()=>{
 assert.equal(POLL_INTERVAL_MS,15*60*1000,'15 minutes: 96 checks a day of a header-only 302');
 assert.equal(POLL_JITTER_MS,90*1000,'90 s of jitter, 10% of the interval, so a fleet spreads out');
 assert.equal(POLL_BACKOFF_CAP_MS,60*60*1000,'an hour is the floor of how often an offline machine asks');
 // Every delay the schedule can produce, at both ends of the injected randomness.
 assert.equal(pollDelay({random:()=>0}),POLL_INTERVAL_MS,'no jitter at random 0');
 assert.equal(pollDelay({random:()=>0.999999}),POLL_INTERVAL_MS+POLL_JITTER_MS-1,'jitter stays under its bound');
 for(const value of [0,0.1,0.5,0.9,1]){const delay=pollDelay({random:()=>value});assert(delay>=POLL_INTERVAL_MS&&delay<POLL_INTERVAL_MS+POLL_JITTER_MS,'delay '+delay+' for random '+value+' stays inside one interval plus jitter');}
 // Consecutive failures double the wait and then hold at the cap.
 assert.equal(pollDelay({failures:1,random:()=>0}),30*60*1000);
 assert.equal(pollDelay({failures:2,random:()=>0}),POLL_BACKOFF_CAP_MS);
 for(const failures of [3,4,99])assert.equal(pollDelay({failures,random:()=>0}),POLL_BACKOFF_CAP_MS,'failure '+failures+' does not grow past the cap');
 assert.equal(pollDelay({failures:-1,random:()=>0}),POLL_INTERVAL_MS,'a negative count is not a shorter interval');
 assert.equal(pollDelay({failures:1.7,random:()=>0}),30*60*1000,'a fractional count is floored, not thrown');
});

test('the question is the release redirect: a 3xx and a readable tag, and nothing else is an answer',async()=>{
 assert.equal(tagVersion(TAG),'9.9.9');
 assert.equal(tagVersion('https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v1.0.44'),'1.0.44');
 for(const location of ['','https://github.com/x/y/releases/latest','https://github.com/x/y/releases/tag/launcher-v01.0.44','https://github.com/x/y/releases/tag/launcher-v1.0','https://github.com/x/y/releases/tag/v1.0.44',null])assert.equal(tagVersion(location),null,'refused: '+location);
 // A hop the launcher can read.
 assert.equal(await latestVersion({probe:async()=>({status:302,location:TAG})}),'9.9.9');
 // A 200 means GitHub answered with a page instead of redirecting: unanswered, never guessed.
 await assert.rejects(()=>latestVersion({probe:async()=>({status:200,location:''})}),error=>error.code==='not-latest-answer'&&/could not be checked/.test(error.message));
 await assert.rejects(()=>latestVersion({probe:async()=>({status:302,location:'https://github.com/x/y/releases/tag/launcher-v1.0.44?x=1'})}),error=>error.code==='not-latest-answer');
 // An unreachable network is the transport's own error, passed through uncut.
 await assert.rejects(()=>latestVersion({probe:async()=>{throw Object.assign(new Error('offline'),{name:'TypeError'});}}),/offline/);
});

test('the schedule never overlaps itself, is unref\'d, aborts on stop, and does nothing when the preference is off',async()=>{
 const clock=fakeClock();
 let release_=null;
 let probes=0;
 const poll=createLauncherPoll({
  current:'1.0.44',root:await tempDir('poll-'),runtime:RUNTIME,
  probe:async()=>{probes+=1;return new Promise(resolve=>{release_=()=>resolve({status:302,location:TAG});});},
  fetch:transport().fetch,timers:clock.timers,random:()=>0,now:()=>'2026-10-23T12:00:00.000Z'
 });
 poll.start();
 assert.equal(clock.armed.length,1,'starting arms exactly one timer');
 assert.equal(clock.armed[0].ms,POLL_INTERVAL_MS,'the first question waits a full interval: the startup gate has just asked');
 assert.equal(clock.armed[0].unrefd,true,'the timer is unref\'d, so a pending question never keeps the process alive');
 // Fire it: the check is in flight and a second tick arriving now is refused, not queued.
 clock.next().fn();
 // Waiting is by deadline rather than by turn count: the staging pipeline does real file I/O,
 // and a machine running the whole suite at once must not make this flaky.
 const settle=async()=>{const deadline=Date.now()+10000;while(poll.state().running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));return !poll.state().running;};
 assert.equal(await settle(),false,'the fired tick is still waiting on its answer');
 assert.equal(probes,1);
 await poll.check();
 assert.equal(probes,1,'a tick while a check is in flight starts no second check');
 assert.equal(clock.armed.filter(entry=>!entry.cleared&&!entry.fired).length,0,'and it re-arms nothing while the first is still out');
 release_();
 assert.equal(await settle(),true,'the check settles');
 assert.equal(clock.armed.filter(entry=>!entry.cleared&&!entry.fired).length,1,'the next question is armed only once the first settled: overlap is impossible by construction');
 // stop() cancels a check in flight, and a cancelled check is not a failure: the transport is
 // told through the same signal main.cjs hands its request, and the answer never arrives.
 const stoppingClock=fakeClock();
 const stopping=createLauncherPoll({
  current:'1.0.44',root:'/nonexistent',runtime:RUNTIME,timers:stoppingClock.timers,
  probe:({signal})=>new Promise((resolve,reject)=>{
   const cancel=()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'}));
   if(signal?.aborted)return cancel();
   signal?.addEventListener?.('abort',cancel,{once:true});
  })
 });
 stopping.start();
 const flight=stopping.check();
 await new Promise(resolve=>setImmediate(resolve));
 stopping.stop();
 await flight;
 const afterStop=stopping.state();
 assert.equal(afterStop.stopped,true);
 assert.equal(afterStop.failures,0,'a cancelled check is not a failed one');
 assert.equal(stoppingClock.armed.filter(entry=>!entry.cleared).length,0,'stop() leaves no timer behind');
 // With the preference off there is no timer at all, and a manual tick asks nothing.
 const offClock=fakeClock();
 let offProbes=0;
 const off=createLauncherPoll({current:'1.0.44',root:'/nonexistent',runtime:RUNTIME,probe:async()=>{offProbes+=1;return {status:302,location:TAG};},enabled:false,timers:offClock.timers});
 off.start();
 assert.equal(offClock.armed.length,0,'autoUpdateLauncher off arms no timer');
 await off.check();
 assert.equal(offProbes,0,'and asks nothing at all');
});

test('a failing check is one line in the update log and changes nothing on disk',async()=>{
 const root=await tempDir('poll-fail-');
 const log=new UpdateLog({file:path.join(root,'launcher-update.log'),version:'1.0.44',now:()=>new Date('2026-10-23T12:00:00.000Z')});
 const clock=fakeClock();
 let stagedCalls=0;
 const poll=createLauncherPoll({
  current:'1.0.44',root,runtime:RUNTIME,log,timers:clock.timers,random:()=>0,
  onStaged:()=>{stagedCalls+=1;},
  probe:async()=>{throw Object.assign(new Error('getaddrinfo EAI_AGAIN'),{code:'ENOTFOUND'});},
  fetch:async()=>{throw Error('a failed ask must not reach the download');}
 });
 poll.start();
 await poll.check();
 const state=poll.state();
 assert.equal(state.failures,1,'one failure is counted');
 assert.equal(state.last,null,'a failed check publishes no result');
 assert.equal(stagedCalls,0,'and stages nothing');
 assert.equal(clock.armed.at(-1).ms,30*60*1000,'the next ask backs off to double the interval');
 const lines=(await fs.readFile(path.join(root,'launcher-update.log'),'utf8')).trim().split('\n');
 assert.equal(lines.length,1,'exactly one line: a failed check is not a page notice');
 assert.match(lines[0],/^2026-10-23T12:00:00\.000Z v1\.0\.44 step=update-poll outcome=failed version=- note=ENOTFOUND$/);
 // Nothing was written into the stash and nothing was activated.
 assert.deepEqual(await fs.readdir(root),['launcher-update.log'],'no payload, no staged record, no current.json');
 assert.equal(staged(root,{current:'1.0.44',runtime:RUNTIME}),null);
 // A second failure doubles again, and a success returns the schedule to fifteen minutes.
 await poll.check();
 assert.equal(poll.state().failures,2);
 assert.equal(clock.armed.at(-1).ms,POLL_BACKOFF_CAP_MS);
});

test('a newer release is staged and recorded, and current.json is never written by a background check',async()=>{
 const root=await tempDir('poll-stage-');
 const log=new UpdateLog({file:path.join(root,'launcher-update.log'),version:'1.0.44',now:()=>new Date('2026-10-23T12:00:00.000Z')});
 const wire=transport({version:'9.9.9'});
 const clock=fakeClock();
 const asked=[];
 const seen=[];
 const poll=createLauncherPoll({
  current:'1.0.44',root,runtime:RUNTIME,log,timers:clock.timers,random:()=>0,
  probe:async({url})=>{asked.push(url);return {status:302,location:TAG};},fetch:wire.fetch,inspect(){},onStaged:record=>seen.push(record)
 });
 poll.start();
 await poll.check();
 assert.equal(wire.calls.length,2,'one hop for the question, then the manifest and its payload');
 assert.deepEqual(asked,[updater.LATEST_PAGE],'the question is the release redirect, not the API and not the manifest');
 assert.match(asked[0],/\/releases\/latest$/,'and not the /download/ path, so no asset is fetched to answer it');
 assert.equal(wire.calls.every(call=>call.token===false),true,'no token and no followed redirect anywhere in the ask');
 assert.equal(wire.calls.every(call=>call.signal),true,'both requests carry an abort signal, so quit cancels them');
 const record=staged(root,{current:'1.0.44',runtime:RUNTIME});
 assert(record,'the staged record validates');
 assert.equal(record.version,'9.9.9');
 assert.equal(record.size,wire.bytes.length);
 const payload=await fs.readFile(record.file);
 assert.equal(sha256(payload),wire.manifest.sha256,'the payload on disk is the payload the manifest hashed');
 await assert.rejects(()=>fs.access(path.join(root,'current.json')),'a background check never writes the activation record bootstrap loads');
 assert.equal(poll.state().last.state,'staged');
 assert.equal(poll.state().last.version,'9.9.9');
 assert.deepEqual(seen.map(entry=>entry.version),['9.9.9'],'the stage is reported once, for the field the view will use');
 const lines=(await fs.readFile(path.join(root,'launcher-update.log'),'utf8')).trim().split('\n');
 assert.equal(lines.length,1);
 assert.match(lines[0],/step=update-poll outcome=ok version=9\.9\.9 note=staged$/);
 assert.equal(clock.armed.at(-1).ms,POLL_INTERVAL_MS,'a successful check re-arms the healthy interval, not a backed-off one');
});

test('a check that finds this launcher current downloads nothing and writes no line',async()=>{
 const root=await tempDir('poll-current-');
 const log=new UpdateLog({file:path.join(root,'launcher-update.log'),version:'1.0.44'});
 const wire=transport();
 const poll=createLauncherPoll({current:'9.9.9',root,runtime:RUNTIME,log,probe:async()=>({status:302,location:TAG}),fetch:wire.fetch,timers:fakeClock().timers});
 await poll.check();
 assert.equal(wire.calls.length,0,'no manifest, no payload: the tag already answered the question');
 assert.deepEqual(await fs.readdir(root),[],'nothing on disk at all');
 assert.equal(poll.state().last.state,'current');
 assert.equal(poll.state().last.version,'9.9.9');
});

test('a newer tag whose manifest disagrees is a failed check, not a stage',async()=>{
 const root=await tempDir('poll-mismatch-');
 const log=new UpdateLog({file:path.join(root,'launcher-update.log'),version:'1.0.44'});
 const wire=transport({version:'9.9.9'});
 const poll=createLauncherPoll({
  current:'1.0.44',root,runtime:RUNTIME,log,timers:fakeClock().timers,
  probe:async()=>({status:302,location:TAG}),
  // The manifest declares another platform, which `validate` refuses before any byte is fetched.
  fetch:async url=>{const response=await wire.fetch(url);if(!url.endsWith('.json'))return response;const wrong=await response.json();return Response.json({...wrong,platform:'aix'});}
 });
 await poll.check();
 assert.equal(poll.state().failures,1);
 assert.equal(staged(root,{current:'1.0.44',runtime:RUNTIME}),null,'an invalid manifest stages nothing');
 assert.deepEqual((await fs.readdir(root)).sort(),['launcher-update.log'],'and leaves nothing behind');
 assert.match((await fs.readFile(path.join(root,'launcher-update.log'),'utf8')).trim(),/outcome=failed version=- note=failed$/,'a failure with no code of its own is written as the plain word');
});

test('update() with apply false returns the payload without activating it, and apply true still activates',async()=>{
 const applyRoot=await tempDir('poll-apply-');
 const wire=transport({version:'9.9.9'});
 const applied=await update({current:'1.0.44',runtime:RUNTIME,root:applyRoot,fetch:wire.fetch,inspect(){}});
 assert.equal(typeof applied,'string','the startup gate still gets the verified payload path it relauches from');
 assert.equal(await fs.readFile(applied).then(buffer=>buffer.length),wire.bytes.length);
 assert.equal(staged(applyRoot,{current:'1.0.44',runtime:RUNTIME}),null,'the applying path writes no staged record');
 const activation=JSON.parse(await fs.readFile(path.join(applyRoot,'current.json'),'utf8'));
 assert.equal(activation.version,'9.9.9','apply:true writes the activation record as before');
});

test('the poll log line cannot carry anything but the vocabulary above',async()=>{
 const log=new UpdateLog({file:null,version:'1.0.44',now:()=>new Date('2026-10-23T12:00:00.000Z')});
 const line=log.pollLine({outcome:'failed',version:'9.9.9;sudo',note:'C:\\Users\\owen token=secret'});
 assert.match(line.trim(),/^2026-10-23T12:00:00\.000Z v1\.0\.44 step=update-poll outcome=failed version=- note=-$/,'a value a token cannot hold is written as -, never as itself');
 assert.match(log.pollLine({outcome:'ok',version:'9.9.9',note:'staged'}).trim(),/step=update-poll outcome=ok version=9\.9\.9 note=staged$/);
});

test('the poll path cannot restart anything: no relaunch, no quit, no state channel',async()=>{
 const fsSync=require('node:fs'),root=path.resolve(__dirname,'../..');
 const updaterSource=fsSync.readFileSync(path.join(root,'desktop/updater.cjs'),'utf8');
 assert.equal(/app\.(relaunch|quit)\(/.test(updaterSource),false,'the updater never restarts the launcher');
 // The background section of main.cjs, from its own heading to the graphics probe that follows it.
 const main=fsSync.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');
 const start=main.indexOf('---- asking again while the launcher is open');
 const end=main.indexOf('// What this machine says about its own graphics');
 assert(start>0&&end>start,'the background check is one contiguous section of main.cjs');
 // Comments say what the section must not do, so only the code is searched.
 const section=main.slice(start,end).split('\n').map(line=>/^\s*\/\//.test(line)?'':line).join('\n');
 for(const forbidden of ['app.relaunch(','app.quit(','.quit()'])
  assert.equal(section.includes(forbidden),false,'the background check must not call '+forbidden);
 // Two places apply a launcher update and no more: the startup gate's own step, and the apply
 // step that takes what this poll staged (Owen's design: a launcher behind a running game
 // updates in the background and comes back into it). The poll itself is neither of them.
 assert.equal((main.match(/app\.relaunch\(/g)||[]).length,2,'exactly two relaunches exist in main.cjs: the gate and the apply step');
 assert.match(main,/app\.relaunch\(updater\.relaunchOptions\(\{hiddenToTray:steppedAsideToTray\(\)\}\)\);app\.quit\(\);return;/,'the gate relays where the window was');
 assert.match(main,/app\.relaunch\(updater\.relaunchOptions\(\{hiddenToTray:inTray\}\)\);\n app\.quit\(\);/,'and the apply step relaunches into the tray when the launcher was in it');
 // The check publishes nothing: its answer reaches the state only as the staged field.
 assert.equal(/notify\(/.test(section),false,'the background check never broadcasts a state');
});
