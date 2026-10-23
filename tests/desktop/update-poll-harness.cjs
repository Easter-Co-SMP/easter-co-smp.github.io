// Excluded from the package. The only thing stubbed here is the transport main.cjs hands the
// poller — the redirect hop, the manifest response and the asset response. Everything behind
// that boundary is the real thing: manifest validation, the streamed download, the sha256
// check, the atomic rename, the staged record and the update log.
//
// The startup gate's own question is answered "current" without the network, exactly as the
// mandatory-update journey does, so this journey proves the *background* path alone. That stub
// replaces the module's exported `update`; the poller calls the module-local pipeline, so it
// cannot be reached by this stub — a background check in this journey stages for real.
const {app}=require('electron'),fs=require('node:fs'),crypto=require('node:crypto');
Object.defineProperty(app,'isPackaged',{value:true});
app.setPath('appData',process.env.EASTER_TEST_HOME);
const updater=require('../../desktop/updater.cjs');
const RUNTIME=require('electron/package.json').version;
const TAG='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v9.9.9';
const bytes=fs.readFileSync(process.env.EASTER_POLL_ASAR);
const sha=crypto.createHash('sha256').update(bytes).digest('hex');
const manifest={schema:1,bootstrap:1,version:'9.9.9',platform:process.platform,arch:process.arch,runtime:RUNTIME,asset:'Easter-Company-Update-'+process.platform+'-'+process.arch+'.asar',size:bytes.length,sha256:sha};
// What the stubbed release says this time. The journey flips this between checks; a check reads
// it when it runs, which is what lets one journey prove a failure, a stage and a held question.
global.easterPollMode='current';
global.easterPollProbes=0;
global.easterPollDownloads=0;
global.easterPollConcurrent=0;
global.easterPollMaxConcurrent=0;
global.easterPollAsked=[];
global.easterPollLines=[];
global.easterPollOptions=null;
global.easterPollHeld=[];
// The tag that means "you are current", and the answer a *held* question gives when it is let go.
// A hold is the same question still outstanding, not a different answer: it is released into
// whatever the mode says at that moment, so a journey that holds a check while it presses Play
// and then releases it with the mode back on `current` gets "current" — an answer that stages a
// release because the harness always said 9.9.9 would make the hold a hidden stage, and the
// assertions that follow a hold would then be racing the apply step (measured 2026-10-23: it
// passed twice and failed on the third run before this was fixed).
const CURRENT_TAG='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v'+require('../../package.json').version;
const answer=()=>global.easterPollMode==='newer'?TAG:CURRENT_TAG;
const poll=async()=>{
 global.easterPollProbes+=1;
 global.easterPollConcurrent+=1;
 global.easterPollMaxConcurrent=Math.max(global.easterPollMaxConcurrent,global.easterPollConcurrent);
 try{
  switch(global.easterPollMode){
   case 'offline':throw Object.assign(Error('getaddrinfo ENOTFOUND github.com'),{code:'ENOTFOUND'});
   case 'hold':return await new Promise((resolve,reject)=>{
    global.easterPollHeld.push(resolve);
    global.easterPollRelease=()=>resolve({status:302,location:answer()});
    setTimeout(()=>resolve({status:302,location:answer()}),20000).unref();
   });
   case 'newer':return {status:302,location:TAG};
   default:return {status:302,location:CURRENT_TAG};
  }
 }finally{global.easterPollConcurrent-=1;}
};
const download=async url=>{
 global.easterPollDownloads+=1;
 if(url.endsWith('.json'))return Response.json(manifest);
 return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
};
const real=updater.createLauncherPoll;
updater.createLauncherPoll=options=>{
 global.easterPollOptions={current:options.current,root:options.root,enabled:options.enabled,inspect:typeof options.inspect,probe:typeof options.probe,fetch:typeof options.fetch,busy:typeof options.busy};
 return real({...options,probe:poll,fetch:download,intervalMs:Number(process.env.EASTER_POLL_INTERVAL||400),jitterMs:0,random:()=>0,
  log:{poll:entry=>{global.easterPollLines.push(entry);options.log?.poll?.(entry);}}});
};
// What the apply step (ticket 7620bcf9) does when it takes a stage: `app.relaunch` and `app.quit`
// are recorded instead of performed, so this journey can go on looking at the process that asked
// for the restart. `easterRestoreApp` puts the real functions back for the final close.
const realRelaunch=app.relaunch.bind(app),realQuit=app.quit.bind(app);
global.easterRelaunch=null;
global.easterQuits=0;
global.easterRealQuit=false;
app.relaunch=options=>{global.easterRelaunch=options||{};};
app.quit=()=>{global.easterQuits+=1;if(global.easterRealQuit)realQuit();};
global.easterRestoreApp=()=>{app.quit=realQuit;app.relaunch=realRelaunch;};
global.easterQuitNow=()=>{global.easterRealQuit=true;app.quit();};
// The startup gate's question, answered without a single request.
updater.update=async({current,notify})=>{
 global.easterStartupChecks=(global.easterStartupChecks||0)+1;
 notify({phase:'current',version:current,percent:null,message:null});
 return null;
};
require('./deslop-harness.cjs');
