// Excluded from the package. The launcher-update apply step, driven through the real main process.
//
// What is stubbed, and nothing else: the *transport* the poll question and the staging pipeline
// use (the redirect hop, the manifest response and the asset response), the startup gate's own
// check (answered "current" without the network, so this journey is about the background path),
// and `app.relaunch`/`app.quit` — which are recorded instead of obeyed so one process can be
// inspected after it has applied an update. Everything behind those boundaries is the real thing:
// `stagedState`, the sha256 check, `applyVersionPolicy`, `activateStaged`, `current.json`, the
// marker `desktop/game-marker.cjs` writes, and the relaunch options `updater.relaunchOptions`
// builds.
//
// The game is a REAL detached process, spawned with the launcher's own `execOptions()` — the
// options under test, not a copy of them — so "the game survives the launcher" is measured on a
// process that really exists, at its real pid.
const {app}=require('electron'),fs=require('node:fs'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
// The apply step only runs in a packaged build (the poll starts there), so the instance that
// stages and applies reports itself packaged. The instances that measure *startup* do not: the
// tray probe honours `EASTER_TEST_TRAY` only in an unpackaged run, which is the only way a seat
// with no status-notifier host can prove both answers.
if(process.env.EASTER_APPLY_PACKAGED==='1')Object.defineProperty(app,'isPackaged',{value:true});
app.setPath('appData',process.env.EASTER_TEST_HOME);
const updater=require('../../desktop/updater.cjs');
const install=require('../../desktop/install.cjs');
const RUNTIME=require('electron/package.json').version;
const VERSION=process.env.EASTER_APPLY_VERSION||'9.9.9';
const TAG='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v'+VERSION;
const bytes=fs.readFileSync(process.env.EASTER_POLL_ASAR);
const sha=crypto.createHash('sha256').update(bytes).digest('hex');
const manifest={schema:1,bootstrap:1,version:VERSION,platform:process.platform,arch:process.arch,runtime:RUNTIME,asset:'Easter-Company-Update-'+process.platform+'-'+process.arch+'.asar',size:bytes.length,sha256:sha};
global.easterPollMode='current';
global.easterPollProbes=0;
global.easterPollDownloads=0;
global.easterStages=0;
const poll=async()=>{
 global.easterPollProbes+=1;
 if(global.easterPollMode==='offline')throw Object.assign(Error('getaddrinfo ENOTFOUND github.com'),{code:'ENOTFOUND'});
 if(global.easterPollMode==='newer')return {status:302,location:TAG};
 return {status:302,location:'https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/tag/launcher-v'+require('../../package.json').version};
};
const download=async url=>{
 global.easterPollDownloads+=1;
 if(url.endsWith('.json'))return Response.json(manifest);
 return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
};
const realPoll=updater.createLauncherPoll;
updater.createLauncherPoll=options=>{
 const poller=realPoll({...options,probe:poll,fetch:download,intervalMs:Number(process.env.EASTER_POLL_INTERVAL||400),jitterMs:0,random:()=>0,
  log:{poll:entry=>{if(entry.note==='staged')global.easterStages+=1;options.log?.poll?.(entry);}}});
 return poller;
};
// The startup gate's question, answered without a single request: this journey is the background
// apply path, and a gate that re-downloads would stage independently of the poll.
updater.update=async({current,notify})=>{notify({phase:'current',version:current,percent:null,message:null});return null;};
// Every window's `visible`, sampled across startup. This is the measurement the no-flash claim is
// made of: ten milliseconds between samples is far finer than the "frame or two" the rule is
// about, and it starts before any window exists.
// The relaunch itself, recorded rather than performed. Electron's own `app.relaunch` spawns the
// executable with these arguments and `app.quit` ends the process; a journey cannot follow the
// replacement process with Playwright, so the two calls are what is observed here and the
// arguments they were given are handed to the next launch instead. Nothing else about them is
// stubbed: this is the real main.cjs calling the real API, and the assertions are about exactly
// what it asked for. `easterRealQuit` is the escape hatch that lets a journey close the app.
const realRelaunch=app.relaunch.bind(app),realQuit=app.quit.bind(app);
global.easterRelaunch=null;
global.easterQuits=0;
global.easterRealQuit=false;
app.relaunch=options=>{global.easterRelaunch=options||{};};
app.quit=()=>{global.easterQuits+=1;if(global.easterRealQuit)realQuit();};
// A journey that is finished puts the real functions back so Playwright's own `close()` can end
// the process the ordinary way. Recording a call is only useful while somebody is still looking.
global.easterRestoreApp=()=>{app.quit=realQuit;app.relaunch=realRelaunch;};
global.easterQuitNow=()=>{global.easterRealQuit=true;app.quit();};
global.easterVisible=[];
setInterval(()=>{
 const {BrowserWindow}=require('electron'),window=BrowserWindow.getAllWindows()[0];
 if(window&&!window.isDestroyed())global.easterVisible.push(window.isVisible());
},10).unref();
// Every tray this process creates, so the journey can assert the icon exists rather than read the
// code that makes it. `electron.Tray` itself cannot be replaced — it is a non-configurable getter
// on Electron's module object (measured 2026-10-23) — but its prototype is writable, so the
// tooltip the launcher gives its icon is captured where the launcher sets it: a Tray that was
// constructed and configured with 'Easter Co. Launcher' is a tray icon this launcher made.
const electron=require('electron'),RealTray=electron.Tray;
global.easterTrays=[];
const realSetToolTip=RealTray.prototype.setToolTip;
RealTray.prototype.setToolTip=function(tooltip){global.easterTrays.push(tooltip);return realSetToolTip.call(this,tooltip);};
require('./deslop-harness.cjs');
// The one game this process starts is a real, detached, pipe-free process — spawned with the
// launcher's own `execOptions()`, so the options under test are the options used — because the
// survival the ticket asks about has to be measured and not simulated. The client is stubbed only
// in that this is a stand-in for java: it does nothing but keep living.
global.easterSpawnOptions=install.execOptions(null);
global.easterTestLaunch=()=>{
 const options=global.easterSpawnOptions;
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{...options,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 global.easterGamePid=child.pid;
 global.easterTestGame=child;
 return child;
};
