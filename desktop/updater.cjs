'use strict';
const path=require('node:path'),crypto=require('node:crypto');
let raw;try{raw=require('original-fs');}catch{raw=require('node:fs');}
const fs=raw.promises;
const REPO='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/download/';
const LATEST='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/latest/download/';
const BOOTSTRAP=1,MAX_BYTES=200*1024*1024;
// The one refusal for a version this launcher cannot read. It carries a name and a code as
// well as the sentence a player sees, because the clear policy below has to be able to say
// "this pair was unparsable" without mistaking it for a filesystem failure.
function invalidVersion(){const invalid=Error('Invalid launcher release version.');invalid.name='LauncherVersionError';invalid.code='invalid-version';return invalid;}
function version(value){
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
 if(!match)throw invalidVersion();
 const parts=match.slice(1).map(Number);if(!parts.every(Number.isSafeInteger))throw invalidVersion();return parts;
}
function compare(a,b){const left=version(a),right=version(b);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
function validate(manifest,{release,platform,arch,runtime}){
 if(!manifest||manifest.schema!==1||manifest.version!==release||manifest.platform!==platform||manifest.arch!==arch)throw Error('The launcher update manifest does not match this release or device.');
 version(release);
 if(manifest.bootstrap!==BOOTSTRAP||manifest.runtime!==runtime)throw Error('This release needs a newer launcher runtime. Install the latest launcher to continue.');
 const asset='Easter-Company-Update-'+platform+'-'+arch+'.asar';
 if(manifest.asset!==asset||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.size)||manifest.size<1||manifest.size>MAX_BYTES)throw Error('The launcher update manifest is invalid.');
 return {...manifest,url:REPO+'launcher-v'+release+'/'+asset};
}
// A launcher-update failure is worded for the player: what stopped and what to do about it. The
// HTTP status stays off the sentence and on the error (`httpStatus`, with the `host` and `step`
// that produced it), and one line per failure goes to the launcher's failure record — the same
// bounded, redacted line log the sign-in uses (desktop/auth.cjs SignInLog). main.cjs owns the
// paths and hands the log in through setFailureLog(); until it does, a failure carries its status
// and writes nothing. This file keeps its own copy of these ten lines deliberately: it runs before
// the gate, and requiring desktop/install.cjs here would pull the whole Minecraft installer in
// front of it.
let failureLog=null;
function setFailureLog(log){failureLog=log&&typeof log.append==='function'?log:null;}
function fault(message,{step='launcher-update',status,host}={}){
 const failed=Error(message);
 if(Number.isInteger(status))failed.httpStatus=status;
 if(typeof host==='string'&&host)failed.host=host;
 failed.step=step;
 try{failureLog?.append({step,outcome:'failed',status:Number.isInteger(status)?status:undefined,note:host});}catch{}
 return failed;
}
// One timeout, or the caller's own cancellation AND that timeout: a check the launcher can
// abort on quit is also bounded by the same number it was bounded by before.
function bounded(signal,ms){return signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);}
async function json(fetch,url,{signal}={}){
 const response=await fetch(url,{signal:bounded(signal,20000),cache:'no-store',headers:{Accept:'application/json'}});
 if(!response.ok)throw fault('The launcher update could not be checked. Check your connection and try again.',{status:response.status,host:hostOf(url)});
 const text=await response.text();if(text.length>65536)throw Error('The update response is too large.');
 return JSON.parse(text);
}
function hostOf(url){try{return new URL(url).hostname;}catch{return '';}}
async function atomic(file,value){
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
 finally{await fs.rm(temp,{force:true});}
}
async function stage(manifest,{root,fetch,notify=()=>{},signal}={}){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const target=path.join(root,manifest.sha256+'.asar'),temp=target+'.'+crypto.randomUUID()+'.part';
 let handle;
 try{
  const response=await fetch(manifest.url,{signal:bounded(signal,300000)});
  if(!response.ok||!response.body)throw fault('The launcher update could not be downloaded. Try again.',{step:'launcher-asset',status:response.status,host:hostOf(manifest.url)});
  const length=response.headers.get('content-length');
  if(length!==null&&Number(length)!==manifest.size)throw Error('The launcher update size does not match the release.');
  handle=await fs.open(temp,'wx',0o600);
  const hash=crypto.createHash('sha256');let done=0;
  for await(const chunk of response.body){
   done+=chunk.length;if(done>manifest.size)throw Error('The launcher update exceeds its declared size.');
   hash.update(chunk);await handle.writeFile(chunk);
   notify({phase:'downloading',version:manifest.version,percent:Math.floor(done/manifest.size*100),message:'Updating launcher…'});
  }
  notify({phase:'verifying',version:manifest.version,percent:100,message:'Verifying launcher…'});
  if(done!==manifest.size||hash.digest('hex')!==manifest.sha256)throw Error('The launcher update failed verification. Retry to download a fresh copy.');
  await handle.sync();await handle.close();handle=null;
  // Validate package identity before activation; no downloaded code executes here.
  await fs.rename(temp,target);
  return target;
 }finally{await handle?.close();await fs.rm(temp,{force:true});}
}
// The one pipeline that turns "a release is published" into a verified payload on disk. It
// answers the path of the verified payload when a strictly newer release was downloaded, and
// null when this launcher already is the published one.
//
// `apply` decides what happens after the payload is verified, and it is the whole difference
// between the startup gate and the background check:
//   * `apply:true` (the startup gate) writes `current.json`, the activation record bootstrap
//     loads on the next start, and announces the restart. This is the only path that
//     activates anything, and the version policy's clear belongs to it because it is the one
//     moment a version change may destroy something.
//   * `apply:false` (the background check, ticket 2cd301e3) writes `staged.json` instead and
//     announces nothing. A background stage that wrote `current.json` would make a minor
//     release activate on the next ordinary start *without* the clear its level asks for,
//     because bootstrap would then load the new bundle and the startup gate would find
//     nothing newer. So the staged record is a fact about the stash, not an activation.
async function update({current,platform=process.platform,arch=process.arch,runtime,root,fetch=globalThis.fetch,notify=()=>{},inspect=()=>{},apply=true,signal}={}){
 notify({phase:'checking',percent:null,message:'Checking launcher updates…'});
 const name='Easter-Company-Update-'+platform+'-'+arch+'.json';
 const info=await json(fetch,LATEST+name,{signal});
 const release=info?.version;
 const manifest=validate(info,{release,platform,arch,runtime});
 if(compare(release,current)<=0){notify({phase:'current',version:current,percent:null,message:null});return null;}
 const target=await stage(manifest,{root,fetch,notify,signal});
 await inspect(target,manifest);
 if(!apply){await atomic(path.join(root,'staged.json'),manifest);return target;}
 await atomic(path.join(root,'current.json'),manifest);
 notify({phase:'restarting',version:release,percent:100,message:'Restarting launcher…'});
 return target;
}
function selected(root,{bundled,runtime,platform=process.platform,arch=process.arch,inspect=()=>{}}){
 try{
  const manifest=JSON.parse(raw.readFileSync(path.join(root,'current.json'),'utf8'));
  validate(manifest,{release:manifest.version,platform,arch,runtime});
  if(compare(manifest.version,bundled)<=0)return null;
  const target=path.join(root,manifest.sha256+'.asar');
  if(raw.statSync(target).size!==manifest.size)return null;
  const bytes=raw.readFileSync(target);
  if(bytes.length!==manifest.size||crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)return null;
  inspect(target,manifest);return target;
 }catch{return null;}
}
// What the background check has staged, and where it is. `selected` above answers "may this
// payload be loaded as the running launcher now?" and hashes the whole payload because it is
// about to execute it; this answers "what is sitting in the stash, verified, waiting for an
// apply step?", so it validates the record exactly as `selected` does and checks the payload's
// length. The bytes were hashed by `stage` when they were written and the file is named after
// that hash, so re-hashing here would be a 40 MB read on every question and prove nothing new.
function staged(root,{current,runtime,platform=process.platform,arch=process.arch}={}){
 try{
  const manifest=JSON.parse(raw.readFileSync(path.join(root,'staged.json'),'utf8'));
  validate(manifest,{release:manifest.version,platform,arch,runtime});
  if(current!==undefined&&compare(manifest.version,current)<=0)return null;
  const target=path.join(root,manifest.sha256+'.asar');
  if(raw.statSync(target).size!==manifest.size)return null;
  return {...manifest,file:target};
 }catch{return null;}
}
function relaunchOptions({platform=process.platform,env=process.env,execPath=process.execPath,argv=process.argv}={}){
 // A shortcut's Play request must survive the mandatory launcher update. Preserve
 // only the two recognised switches, never arbitrary launch arguments or paths.
 const args=['--no-sandbox','--play'].filter(argument=>argv.includes(argument));
 return {execPath:platform==='linux'&&env.APPIMAGE?env.APPIMAGE:execPath,args};
}
// ---- asking again, while the launcher is open ----------------------------------------
//
// Owen's rule of 2026-10-23: "If the updater is open, every 10 or 15 minutes, or maybe 20,
// 30, 1 hour? ... let's have the launcher client ping our servers asking 'hey am I still
// running the latest version?', and if it's not then it automatically updates and restarts."
// This section is the ping and the stage. The restart is a separate ticket and nothing here
// calls app.relaunch or app.quit: this file never has, and the only caller that does is
// main.cjs's startup gate.
//
// **The question is the release's own `/releases/latest` redirect, not an API call.** One
// request, no token, no GitHub API, and the redirect is not followed, so the answer is a bare
// 302 whose `Location` names the tag and whose body is empty — measured against the real
// endpoint on 2026-10-23: `302`, `content-length: 0`,
// `location: .../releases/tag/launcher-v1.0.44`, 21-138 ms. Following that redirect would
// download the release page; the manifest under `/releases/latest/download/` would be a
// second request plus a CDN round trip. Neither is needed to answer "is there something
// newer?", and the manifest is still read — through `update()` — only when the answer is yes.
//
// **Every bound is named, and each one is here rather than in the wiring.**
//   POLL_INTERVAL_MS     15 minutes. 96 checks a day of a ~1 KB header-only request. The
//                        alternative tick paid by every player must be cheap enough that it
//                        decides nothing else in the launcher; a shorter one buys nothing
//                        (releases are cut by hand, a handful a week at most) and a longer
//                        one leaves a player on an old build for an hour after a fix ships.
//   POLL_JITTER_MS       90 s added at random, so a fleet started together does not check in
//                        lockstep: the whole point of a 302 is that a synchronised herd is
//                        the only thing that could ever make it expensive.
//   POLL_BACKOFF_CAP_MS  one hour. After consecutive failures the interval doubles (30 min,
//                        60 min) and stops at the cap, so an offline laptop asks at most 24
//                        times a day and any success returns it to 15 minutes.
//   POLL_BACKOFF_MAX     three doublings reach the cap; more would only be arithmetic.
//   POLL_TIMEOUT_MS      15 s for the redirect question. A hop that takes longer than a
//                        release page fetch is not an answer, and the next tick is a fresh try.
const LATEST_PAGE='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/latest';
const POLL_INTERVAL_MS=15*60*1000,POLL_JITTER_MS=90*1000,POLL_BACKOFF_CAP_MS=60*60*1000,POLL_BACKOFF_MAX=3,POLL_TIMEOUT_MS=15000;
// The tag the redirect points at. `launcher-v` is the prefix scripts/release.sh publishes
// under, and the version has to be one `version()` accepts, so a tag this launcher cannot read
// is an unanswered question rather than a downgrade or a crash.
const TAG_LOCATION=/\/releases\/tag\/launcher-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
function tagVersion(location){const match=TAG_LOCATION.exec(String(location||''));return match?match[1]:null;}
function pollFault(message,{step='launcher-poll',status}={}){
 const failed=Error(message);
 if(Number.isInteger(status))failed.httpStatus=status;
 failed.step=step;
 failed.code='not-latest-answer';
 return failed;
}
// One question, one answer: the version `/releases/latest` points at. `probe` is the transport
// that resolves a manual-redirect hop (`{status, location}`), because Electron's `net.fetch`
// *refuses* `redirect:'manual'` with "Redirect was cancelled" (measured 2026-10-23) and follows
// the redirect otherwise; main.cjs answers it with net.request, a test with a stub. An answer
// that is not a 3xx carrying a readable tag is a failed check, never a version.
async function latestVersion({probe,signal,url=LATEST_PAGE}={}){
 const hop=await probe({url,signal});
 const release=tagVersion(hop?.location);
 const status=Number(hop?.status);
 if(!(status>=300&&status<400)||!release)throw pollFault('The launcher update could not be checked.',{status:Number.isInteger(status)?status:undefined});
 return release;
}
// How long until the next question. The base interval doubles per consecutive failure up to
// the cap, and up to `jitterMs` of uniform noise is added so a fleet does not arrive together.
// `random` is injectable so a test can pin both ends of the jitter without sleeping.
function pollDelay({failures=0,intervalMs=POLL_INTERVAL_MS,jitterMs=POLL_JITTER_MS,backoffCapMs=POLL_BACKOFF_CAP_MS,random=Math.random}={}){
 const exponent=Math.min(Math.max(0,Math.floor(Number(failures)||0)),POLL_BACKOFF_MAX);
 const base=Math.min(intervalMs*2**exponent,backoffCapMs);
 const noise=Math.min(Math.max(Number(random())||0,0),0.999999)*Math.max(0,jitterMs);
 return base+Math.floor(noise);
}
// The loop itself, drivable without Electron and without waiting: every knob is an option and
// the clock is injected. Its properties are the ticket's:
//   * it never overlaps itself — the next tick is armed only once the current check settles,
//     and a second `check()` while one is in flight is refused rather than queued;
//   * its timer is unref'd, so a pending version question is never the reason a process lives;
//   * `stop()` cancels the timer and aborts a check in flight, and a check cancelled that way
//     is not a failure: it writes nothing and moves no interval;
//   * nothing it does can be seen. It has no notify, no phase, no window: its only output is
//     `log` (one line per failure, and one per stage) and `onStaged` (a field for the state the
//     view already publishes, carried by whatever broadcast comes next);
//   * `enabled:false` is the `autoUpdateLauncher` preference, and it means no timer at all.
function createLauncherPoll({current,root,runtime,platform=process.platform,arch=process.arch,probe,fetch=globalThis.fetch,inspect=()=>{},enabled=true,busy=()=>false,log=null,onStaged=()=>{},timers={setTimeout,clearTimeout},intervalMs=POLL_INTERVAL_MS,jitterMs=POLL_JITTER_MS,backoffCapMs=POLL_BACKOFF_CAP_MS,random=Math.random,now=()=>new Date().toISOString()}={}){
 const poll={started:false,stopped:false,running:false,failures:0,timer:null,controller:null,last:null};
 const clear=()=>{if(poll.timer!==null){timers.clearTimeout(poll.timer);poll.timer=null;}};
 function arm(){
  if(poll.stopped)return;
  const delay=pollDelay({failures:poll.failures,intervalMs,jitterMs,backoffCapMs,random});
  poll.timer=timers.setTimeout(()=>{poll.timer=null;void tick();},delay);
  if(poll.timer&&typeof poll.timer.unref==='function')poll.timer.unref();
 }
 function line(entry){try{log?.poll?.(entry);}catch{}}
 // The question, then — only if the answer is "not current" — the same pipeline the startup
 // gate uses, with activation withheld. The manifest is re-read and re-validated there, so the
 // tag is a hint and the manifest is the authority about what is actually downloaded.
 async function run(signal){
  const release=await latestVersion({probe,signal});
  if(compare(release,current)<=0){poll.last={state:'current',version:release,at:now()};return poll.last;}
  const target=await update({current,root,runtime,platform,arch,fetch,inspect,signal,apply:false});
  if(!target){poll.last={state:'current',version:release,at:now()};return poll.last;}
  // The staged record is the authority on what was written, and `release` is the tag that sent
  // it here; the record wins, because the manifest is what `validate` accepted.
  const record=staged(root,{current,runtime,platform,arch});
  poll.last={state:'staged',version:record?.version||release,from:String(current),at:now()};
  line({outcome:'ok',version:poll.last.version,note:'staged'});
  try{onStaged(poll.last);}catch{}
  return poll.last;
 }
 async function tick(){
  if(poll.stopped||poll.running||!enabled)return poll.last;
  // A launcher in the middle of a game, an install or its own startup gate is not asked: the
  // question would compete with work the player is waiting for. Deferring is not failing, so
  // the interval it re-arms is the healthy one.
  if(busy()){arm();return poll.last;}
  poll.running=true;poll.controller=new AbortController();
  try{
   await run(poll.controller.signal);
   poll.failures=0;
  }catch(error){
   // A cancelled check is not an answer about the release. The stage path's own failures are
   // already a line in install.log; this is the one line the update log gets.
   if(!poll.stopped&&error?.name!=='AbortError'){
    poll.failures+=1;
    line({outcome:'failed',version:null,note:error?.code||(error?.name&&error.name!=='Error'?error.name:'failed')});
   }
  }finally{
   poll.running=false;poll.controller=null;arm();
  }
  return poll.last;
 }
 // What the launcher may see of the loop: whether it is armed, what it last answered, and how
 // many failures are behind the current interval. The timer and the controller stay inside.
 const state=()=>({started:poll.started,stopped:poll.stopped,running:poll.running,armed:poll.timer!==null,failures:poll.failures,last:poll.last});
 return {
  start(){if(poll.started||poll.stopped||!enabled)return state();poll.started=true;arm();return state();},
  stop(){poll.stopped=true;clear();try{poll.controller?.abort();}catch{}return state();},
  check(){return tick();},
  state
 };
}
// ---- how big a version change is, and what that change may clear --------------
// Owen's rule of 2026-10-19: "if only the patch is incremented between current client and
// the target during the update process, preserve client side cache and user auth session.
// For minor updates, the launcher should clear cache but keep the minimum required
// user/auth cache. For major updates, clear cache, and any locally stored user session
// data. This also provides a baseline for deciding what kind of increment a new release
// should have."
//
// So the release's own version number is the whole statement of what it may destroy, and
// nothing else decides it. `classify` is pure arithmetic on the three numbers: it reads no
// file, no setting and no environment, so a test can walk the whole matrix and the path
// that applies an update cannot quietly disagree with the table in doc/launcher-states.md.
const LEVELS=['patch','minor','major'];
function levelRank(level){const rank=LEVELS.indexOf(String(level));if(rank<0)throw Error('Unknown launcher update level.');return rank;}
function classify(fromVersion,toVersion){
 const from=version(fromVersion),to=version(toVersion);
 if(to[0]!==from[0])return 'major';
 if(to[1]!==from[1])return 'minor';
 // The third number moved, or nothing moved. Both answer `patch`, which clears nothing:
 // the level names the largest clearing the pair can justify, and a pair that leaves every
 // number at or below where it started justifies none. An equal pair and a same-field
 // downgrade are therefore harmless here; neither can reach the clearing code either,
 // because update() returns null unless the release is strictly newer.
 return 'patch';
}
// The one list of what an update may remove. Clearing iterates this table and nothing
// else: the data directory is never globbed, and a name that is not here is never removed,
// so a file the launcher did not think about (a player's own notes, a dialect dictionary,
// an installed.json the launcher is still using) survives by not being listed. Each member
// says why it is expendable, because "cache" is a claim about every one of them and the
// next person to add a name has to be able to make the same claim honestly.
//
// `level` is the smallest bump that clears the member, and an update clears every member
// at or below its own level. A patch clears nothing at all, so the only levels here are
// minor (a copy of something the launcher can fetch or rebuild) and major (the player's
// stored session, which a major release may have invalidated).
const CLEAR=[
 // Deliberately NOT on this list: IndexedDB. It holds the map's drawing layer, which is
 // content the player made rather than a copy of something we published, and a cache rule
 // must not delete drawings. Nothing in an upgrade has needed it cleared; if a release ever
 // truly does, that is a major with an explicit migration, not a silent wipe.
 {name:'minecraft',level:'minor',keep:['.easter-client','saves','screenshots'],why:'The client tree the installer built: versions, libraries, assets, mods, resource packs and the installed.json record. Every file the launcher wrote into it is a copy of something the published client manifest describes, so it can be rebuilt exactly and a stale tree is the usual reason a release needs a fresh install. Three things in it are not the launcher’s to throw away, so the tree is emptied one level deep and they stay: the .easter-client marker, which is the proof that this folder is ours rather than another launcher’s, saves/, the worlds the player made on this computer, and screenshots/, the pictures they took. A tree the player placed somewhere else is not this entry: only the default, app-owned folder inside the launcher’s own data directory is ever cleared.'},
 {name:'launcher-updates',level:'minor',keepCurrent:true,why:'The downloaded launcher payloads, except the one this update just activated. A staged payload is the bundle the relaunch is about to load, so it is the one thing in this stash that must survive; every earlier payload is a release asset that can be fetched again, and keeping them all would keep every previous bundle on disk forever.'},
 {name:'Cache',level:'minor',why:'Electron’s HTTP disk cache for the launcher’s own pages. Its keys belong to the bundle being replaced, and a new bundle re-fetches what it needs.'},
 {name:'Code Cache',level:'minor',why:'Compiled JavaScript and WebAssembly for the old bundle. Stale by definition the moment the bundle changes, and rebuilt on the next start.'},
 {name:'GPUCache',level:'minor',why:'GPU resource cache for the old bundle’s rendering. Rebuilt on demand; a stale one produces the blank or flickering first frame.'},
 {name:'DawnGraphiteCache',level:'minor',why:'Chromium’s WebGPU/Graphite pipeline cache. Same class as GPUCache: rebuilt on demand, worthless across a bundle change.'},
 {name:'DawnWebGPUCache',level:'minor',why:'The WebGPU half of the same cache, kept separate by Chromium. Removed with it so neither half outlives the code that filled it.'},
 {name:'ShaderCache',level:'minor',why:'Compiled shaders for the renderer that just changed. Rebuilt on demand.'},
 {name:'GrShaderCache',level:'minor',why:'The other shader cache Chromium keeps; removed with ShaderCache so no compiled artefact of the old renderer survives.'},
 {name:'blob_storage',level:'minor',why:'Blobs the old renderer stored for its own use. The launcher keeps no player state here: settings live in settings.json and sessions in the vaults.'},
 {name:'Local Storage',level:'minor',why:'Key/value storage of the old bundle’s pages. Nothing the launcher needs across a version change is kept here.'},
 {name:'Session Storage',level:'minor',why:'Per-window storage; it belongs to a window that is closing for the relaunch, so it cannot outlive the update anyway.'},
 {name:'WebStorage',level:'minor',why:'Chromium’s umbrella storage directory for the pages above; cleared with them so no half of the old bundle’s storage is left behind.'},
 {name:'signin.log',level:'minor',why:'The bounded, redacted one-line-per-step record of the sign-in legs. Its steps belong to the code being replaced: after a minor release the file describes a bundle that is no longer running, and the next sign-in writes a fresh one. It carries no credential, so removing it loses diagnoses and nothing else.'},
 {name:'accounts.enc',level:'major',why:'The saved account sessions: the Microsoft account and the Minecraft access token the launcher launches with. A major release is the one that may invalidate what a session was minted for, so a major update removes it and the player signs in again. This and the two vaults below are the only members a major adds to the cache list, and no path outside the launcher’s data directory is ever touched.'},
 {name:'company.enc',level:'major',why:'The Company session token for the account API, stored through OS-backed safeStorage. It is the other half of the same stored session: a major update that removed accounts.enc alone would leave the launcher half signed in.'},
 {name:'account.enc',level:'major',why:'The single-account vault from before the account list, left behind by an install that predates it. A major update removes it so an old session cannot outlive the sign-in it belongs to.'},
];
// A patch is a release that needs no clearing, so its plan is empty by construction rather
// than by a special case somewhere else: there is no code path that clears on a patch.
function clearPlan(level){
 const wanted=levelRank(level);
 return wanted===0?[]:CLEAR.filter(entry=>levelRank(entry.level)<=wanted);
}
// One rule for every path a clear may touch: a single name, resolved inside the launcher’s
// own data directory. A name that resolves anywhere else is refused rather than followed,
// and the check is on the path that is actually removed, so no name can be talked past it.
// The refusal carries a name and a code so the caller can tell it from a member that merely
// could not be removed: this one is a bug in the launcher, not an outcome to report.
function refusal(message){const refused=Error(message);refused.name='ClearRefusalError';refused.code='refused';return refused;}
function withinDataDirectory(dataRoot,name){
 if(!dataRoot)throw Error('The launcher data directory is required.');
 const root=path.resolve(String(dataRoot));
 const value=String(name??'');
 // Leading separators, `..`, an embedded separator and the NUL byte are all ways for a name
 // to become a path; a member of CLEAR is a constant, so a name like this is a bug in the
 // launcher, refused loudly instead of acted on.
 if(!value||value==='.'||value==='..'||value.includes('/')||value.includes('\\')||value.includes('\0'))throw refusal('Refusing to clear a path outside the launcher data directory.');
 const target=path.resolve(root,value);
 if(target===root||!target.startsWith(root+path.sep))throw refusal('Refusing to clear a path outside the launcher data directory.');
 return target;
}
// The names inside the update stash that must survive a clear: the record the relaunch reads
// and the one payload it names. bootstrap.cjs loads the staged bundle from current.json, so a
// clear that removed it would relaunch into the version being replaced and re-download the
// same update on every start. A record that cannot be read keeps the whole stash instead,
// which is the same safety with a worse clean-up, never a relaunch into nothing.
async function keepStaged(filesystem,dir){
 try{
  const record=JSON.parse(await filesystem.readFile(path.join(dir,'current.json'),'utf8'));
  if(record&&typeof record.sha256==='string'&&/^[a-f0-9]{64}$/.test(record.sha256))return ['current.json',record.sha256+'.asar'];
 }catch{}
 return null;
}
// Clearing, drivable without Electron: `filesystem` supplies the reads and `remove` supplies
// the deletion, so a test can prove the matrix on a fixture directory and count exactly how
// many paths were touched. Neither is required in the launcher, which passes neither.
//
// A member that cannot be removed does not stop the rest: a locked file on Windows is one
// stale cache, not a reason to leave the session vault and the client tree behind. What
// failed is reported, so the decision line says what actually happened rather than what was
// intended. A name that resolves outside the data directory is not that kind of failure: it
// is refused by throwing, because it means a member of CLEAR is wrong.
async function clearForLevel(level,{dataRoot,filesystem=fs,remove}={}){
 const plan=clearPlan(level);
 const removal=typeof remove==='function'?remove:(target,options)=>filesystem.rm(target,options);
 const cleared=[],failed=[],skipped=[];
 for(const entry of plan){
  const target=withinDataDirectory(dataRoot,entry.name);
  try{
   if(entry.keep||entry.keepCurrent){
    // One level deep, so the kept names inside survive. readdir gives single segments, and
    // each child is put through the same rule: nothing under the tree can escape it.
    let children=[];
    try{children=await filesystem.readdir(target);}
    catch(error){
     if(error.code!=='ENOENT')throw error;
     // Already absent, so this member is already as clear as the level asks for.
     cleared.push(entry.name);continue;
    }
    let keep=Array.isArray(entry.keep)?[...entry.keep]:[];
    if(entry.keepCurrent){
     const staged=await keepStaged(filesystem,target);
     // No readable record of what is staged: leave the stash alone rather than guess which
     // payload the relaunch will load, and say so instead of claiming it was cleared.
     if(!staged){skipped.push(entry.name);continue;}
     keep=keep.concat(staged);
    }
    for(const child of children){
     if(keep.includes(child))continue;
     await removal(withinDataDirectory(target,child),{recursive:true,force:true});
    }
    cleared.push(entry.name);
    continue;
   }
   await removal(target,{recursive:true,force:true});
   cleared.push(entry.name);
  }catch(error){
   // A refusal is not an outcome to record and carry on from: it means a member of CLEAR
   // resolves outside the data directory, which is a bug that must be seen.
   if(error?.code==='refused')throw error;
   failed.push({name:entry.name,code:error?.code||'failed'});
  }
 }
 return {level,cleared,failed,skipped};
}
// One line per decision, and the decision is the whole record a later question needs: which
// way the version moved, what that meant, what was cleared. It gets its own file rather than
// sharing install.log or signin.log, whose vocabulary is a single token per field: this line
// carries the from/to pair and the list of cleared names, which they cannot express. The
// values are a validated version, one of three words and the constants from CLEAR above, so
// no player data, no path and no credential can reach it, and `token` refuses anything else
// outright instead of writing a name-free line.
const UPDATE_LOG_LIMIT=65536;
function token(value){const text=typeof value==='string'?value.trim():'';return /^[0-9A-Za-z][0-9A-Za-z ._-]*$/.test(text)&&text.length<=64?text:'-';}
class UpdateLog{
 constructor({file=null,version='',maxBytes=UPDATE_LOG_LIMIT,now=()=>new Date()}={}){
  this.file=file;this.version=token(version);this.maxBytes=Number.isInteger(maxBytes)&&maxBytes>0?maxBytes:UPDATE_LOG_LIMIT;this.now=now;
 }
 line({from,to,level,cleared=[],failed=[],skipped=[],outcome='ok',note}={}){
  const names=(value)=>{const list=(Array.isArray(value)?value:[]).map(token).filter(name=>name!=='-');return list.length?list.join('|'):'-';};
  return [this.now().toISOString(),'v'+(this.version||'unknown'),'step=update-policy','outcome='+(outcome==='failed'?'failed':'ok'),'level='+(LEVELS.includes(level)?level:'-'),'from='+token(from),'to='+token(to),'cleared='+names(cleared)]
   .concat(names(skipped)!=='-'?['skipped='+names(skipped)]:[])
   .concat(names(failed)!=='-'?['failed='+names(failed)]:[])
   .concat(note?['note='+token(note)]:[]).join(' ')+'\n';
 }
 append(entry={}){
  this.write(this.line(entry));
 }
 // The background check's own line, in the same file and under the same rules, with the
 // vocabulary that question needs: `step=update-poll`, the release it was about, and why it
 // failed. Only failures and stages are written — a check that finds the launcher current is
 // the normal state of the world 96 times a day, and a file that records it would rotate away
 // the lines that say something happened. A failure is `note=unreachable`,
 // `note=not-latest-answer` or the error's own name; anything a token cannot hold is `-`.
 pollLine({outcome='ok',version=null,note=null}={}){
  return [this.now().toISOString(),'v'+(this.version||'unknown'),'step=update-poll','outcome='+(outcome==='failed'?'failed':'ok'),'version='+token(version),'note='+token(note)].join(' ')+'\n';
 }
 poll(entry={}){
  this.write(this.pollLine(entry));
 }
 write(line){
  if(!this.file)return;
  try{
   try{raw.mkdirSync(path.dirname(this.file),{recursive:true});}catch{}
   let size=0;
   try{size=raw.statSync(this.file).size;}catch{}
   if(size+Buffer.byteLength(line,'utf8')>this.maxBytes){
    try{raw.renameSync(this.file,this.file+'.1');}catch{}
   }
   raw.appendFileSync(this.file,line,{encoding:'utf8'});
  }catch{}
 }
}
// What the launcher calls once, on the update it is about to apply, and the only entry point
// that decides a level. One line is written per decision whatever happens: ok with the names
// that went, or failed with the names that would not go and the code that stopped them. A
// refusal still throws, unlogged as a decision, because a member of CLEAR escaping the data
// directory is a bug rather than an outcome.
async function applyVersionPolicy({from,to,dataRoot,filesystem=fs,remove,log=null}={}){
 const level=classify(from,to);
 let result;
 try{result=await clearForLevel(level,{dataRoot,filesystem,remove});}
 catch(error){
  try{log?.append?.({from:String(from),to:String(to),level,cleared:[],outcome:'failed',note:'refused'});}catch{}
  throw error;
 }
 try{
  log?.append?.({from:String(from),to:String(to),level,cleared:result.cleared,skipped:result.skipped,failed:result.failed.map(item=>item.name),outcome:result.failed.length?'failed':'ok',note:result.failed.length?result.failed[0].code:null});
 }catch{}
 return result;
}
module.exports={setFailureLog,fault,update,stage,selected,staged,validate,compare,version,relaunchOptions,BOOTSTRAP,LEVELS,classify,clearPlan,CLEAR,withinDataDirectory,clearForLevel,applyVersionPolicy,UpdateLog,
 LATEST_PAGE,POLL_INTERVAL_MS,POLL_JITTER_MS,POLL_BACKOFF_CAP_MS,POLL_BACKOFF_MAX,POLL_TIMEOUT_MS,tagVersion,latestVersion,pollDelay,createLauncherPoll};
