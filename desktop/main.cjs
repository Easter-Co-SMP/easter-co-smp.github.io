'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,shell,safeStorage,dialog,screen,Tray,Menu,nativeImage}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url'),{execFile}=require('node:child_process');
const {MicrosoftAuth,SignInLog,DEFAULT_CLIENT_ID}=require('./auth.cjs');
const {AccountClient,AccountError,publicAccount,companySession,storedSession,companyVaultName,MESSAGES:ACCOUNT_MESSAGES,USERNAME_PATTERN}=require('./accounts.cjs');
const {apiOrigin,clientOrigin,defaultInstallLocation,ensureLocation,resolveLocation}=require('./config.cjs');
// The game server's own half of the contract: the frozen status shape and the one
// wait rule. Its two routes live on the account client (accounts.cjs), because the
// game status is served from the account API's origin with the account's own session.
const {GameWaitError,gameStatusLine,wakeServer}=require('./game.cjs');
const vault=require('./vault.cjs');
const {providerSignIn}=require('./providers.cjs');
const {hydratePicture}=require('./profile.cjs');
const identity=require('./identity.cjs');
// The last known session answer, kept in its own file beside the settings so a restart can
// say what this launcher last knew before the account service answers. Presentation only: it
// is read where the state is published and nowhere a launch is decided (below).
const sessionAnswer=require('./session-cache.cjs');
const {localFile,trustedFrame,externalURL,publicProfile,cleanSettings,migrateLaunchPreferences,launchBehaviour,includeGraphicsValue}=require('./security.cjs');
const {APP_USER_MODEL_ID,ICON_FILE,wantsAutoStart,autoStartDecision,shortcutSupport,readGameShortcuts,applyGameShortcuts}=require('./shortcuts.cjs');
const install=require('./install.cjs');
// The identity of a game that outlives this launcher. Owen's design: an update applies behind a
// live Minecraft and the launcher comes back into it, so the client a launcher started is
// recorded (pid + the process's own start time) before anything can restart, and a restarted
// launcher reads that record back instead of offering Play.
const gameMarker=require('./game-marker.cjs');
const {configureVisuals,disableShaders}=require('./visuals.cjs');
const {atomicJSON,installClient,applyGraphics,checkForUpdates,clientStatus,canPlay,createControl,launchOptions,launch}=install;
const {renderOffload}=require('./hardware.cjs');
const {detectHardware,installedQuality,applyDisplayDefaults,displayGuiScale,displayPhysicalPixels}=require('./hardware.cjs');
const APP_VERSION=require('../package.json').version;
// The installed application is "Easter Co. Launcher". The per-user directory stays
// "Easter Company": renaming it would orphan the saved account and settings of anyone
// already signed in, so the name and the path are deliberately decoupled here.
app.setName('Easter Co. Launcher');
// Windows groups taskbar buttons and toast notifications under this identity, and the
// shortcut the player creates in Settings carries the same one, so a launcher started
// from that shortcut is the same application to the shell rather than a new one.
if(process.platform==='win32')app.setAppUserModelId(APP_USER_MODEL_ID);
app.setPath('userData',path.join(app.getPath('appData'),'Easter Company'));
protocol.registerSchemesAsPrivileged([{scheme:'easter',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
if(!app.isPackaged&&process.env.EASTER_TEST_HOME)app.setPath('userData',process.env.EASTER_TEST_HOME);
const instance=app.requestSingleInstanceLock();
if(!instance)app.quit();
let window,settings,session=null,working=false,game=null,controller,company=null,accessChecking=false,accountWorking=false;
// A Play press is in flight from the moment the button is pressed until it has either started a
// game or failed. It is what the launcher-update apply refuses to interrupt (updater.cjs
// `updateMayApplyNow`): a running game is *not* a reason to wait — the client outlives the
// launcher — but a press that has not settled into one is.
let launchPresses=0;
// Whether a staged update is waiting for the launcher to be free, and whether this process is
// already applying one. Both are transitions of the apply step below.
let applyWaiting=false,applyingUpdate=false;
// The game this launcher found already running rather than started: the marker a previous
// instance left behind. `adoptedGame` keeps the record (pid and start marker) so the launcher can
// watch the process it no longer owns a handle on.
let adoptedGame=null,adoptedWatch=null;
const siteRoot=path.resolve(__dirname,'../site');
const configRoot=()=>app.getPath('userData');
const defaultLocation=()=>defaultInstallLocation(configRoot());
const gameRoot=()=>settings?.location||defaultLocation();
const settingsFile=()=>path.join(configRoot(),'settings.json');
let savedAccounts=[],sessionWrite=Promise.resolve();
const accountsFile=()=>path.join(configRoot(),'accounts.enc');
const vaultFile=()=>path.join(configRoot(),'account.enc');
const companyFile=()=>path.join(configRoot(),companyVaultName());
const clientId=process.env.EASTER_MICROSOFT_CLIENT_ID||DEFAULT_CLIENT_ID;
// The sign-in log doc/launcher-states.md describes: one redacted line per step, in the
// per-user directory beside the settings and the vaults, so a failure the owner reports
// can be read back as which leg failed rather than guessed at. Nothing else writes it.
const auth=new MicrosoftAuth({clientId,logPath:path.join(configRoot(),'signin.log'),version:APP_VERSION});
const accounts=new AccountClient({baseUrl:apiOrigin(),client:'launcher/'+APP_VERSION});
// No server field: the one address the launcher uses is config.cjs serverAddress(), a
// fixed production target, and a settings file that still carries an older `server` value
// is accepted and ignored (doc/launcher-states.md, "The one server the launcher targets").
const defaultSettings={memoryMB:Math.min(4096,Math.max(2048,Math.floor(os.totalmem()/1024/1024/2048)*1024)),javaPath:'',location:'',includeGraphics:false,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false,trayOnLaunch:false,desktopShortcut:false,startMenuShortcut:false};
// The launcher state contract in doc/launcher-states.md. `phase` and `progress`
// are the live pipeline's; everything else is derived from the installed client,
// the account session and the saved settings on every broadcast, so no view has to
// guess. canPlay is computed here and nowhere else.
let state={message:'Download the game to get started.',error:null,device:null,progress:null,profile:null,remembered:false,account:null,activity:null};
// Activity is independent of installation progress. Only launcher-owned stage text
// crosses IPC; callbacks belonging to a finished/replaced operation are ignored.
const ACTIVITY_MESSAGES=Object.freeze({
 'microsoft-opening':'Opening Microsoft sign-in…',
 'microsoft-waiting':'Complete sign-in on Microsoft’s page.',
 'microsoft-verifying':'Verifying your Microsoft sign-in…',
 'java-checking':'Checking Minecraft Java access…',
 'company-signing-in':'Connecting your Easter Company account…',
 'company-waking':'The account service is waking up. We’ll keep trying…',
 'account-working':'Contacting the account service…'
});
let activityOwner=null;
function beginActivity(stage,{replace=true,scope='hero'}={}){
 // Optional profile reads never take over an interactive sign-in or mutation.
 // A read replaced by a newer operation cannot clear or revive that operation.
 if(!replace&&activityOwner)return {update:()=>{},end:()=>{}};
 const owner=Symbol('activity'),startedAt=Date.now();let currentStage=null;activityOwner=owner;
 // `scope` says which surface draws the words: the hero for the operations the player
 // starts there, `surface` for the ones they start in a menu or a dialog, which report in
 // that surface and may never paint the hero's line (doc/launcher-states.md, the `activity`
 // field and *Quiet activity feedback and cold-start patience*). The stage and its words do
 // not change with it: only the place they are read.
 const update=next=>{
  if(activityOwner!==owner||!Object.hasOwn(ACTIVITY_MESSAGES,next)||currentStage===next)return;
  currentStage=next;
  notify({activity:{stage:next,message:ACTIVITY_MESSAGES[next],startedAt,scope}});
 };
 const end=()=>{if(activityOwner===owner){activityOwner=null;notify({activity:null});}};
 update(stage);return {update,end};
}
async function withActivity(stage,action,options){const activity=beginActivity(stage,options);try{return await action(activity.update);}finally{activity.end();}}
// The two game-shortcut entries, as they really are on this computer: the file exists or
// it does not, which is not the same question as the saved preference. Filled before the
// first broadcast and refreshed whenever Settings is opened or saved.
let shortcutState={available:false,reason:null,message:null,desktop:{id:'desktop',wanted:false,exists:false,ours:false},startMenu:{id:'startMenu',wanted:false,exists:false,ours:false}};
let phase=null,progress=null,control=null,installStarted=false,backgroundUpdate=null;
let startupReady=!app.isPackaged,startupPromise=null;
const updater=require('./updater.cjs');
// Optional editorial content for the home screen: the latest dispatch and one store
// highlight, from the public document published with the site. Read-only, cached, and
// never part of the state broadcast (doc/launcher-discovery.md).
const {Discovery}=require('./discovery.cjs');
const discovery=new Discovery();
// Read the editorial document as soon as the process is up, rather than when the home
// screen first asks: the first ask can arrive before the renderer's frame is trusted, and
// the answer is then already in hand (doc/launcher-discovery.md).
app.whenReady().then(()=>{void discovery.content().catch(()=>{});});
// The install and update failures a player cannot act on from a number: the same bounded, redacted
// line log at the same rotation and under the same rules, in the same per-user directory
// (doc/launcher-states.md). install.cjs and updater.cjs each write one line per failure and the
// sentence they show carries no status; nothing reads this file back.
install.setFailureLog(new SignInLog({file:path.join(configRoot(),'install.log'),version:APP_VERSION}));
updater.setFailureLog(new SignInLog({file:path.join(configRoot(),'install.log'),version:APP_VERSION}));
// The record of what a launcher update cleared: one line per applied update, beside the
// other two logs and under the same rules. It has its own file because a decision line
// carries the from/to pair and the list of names it cleared, and neither signin.log's nor
// install.log's single-token vocabulary can hold that without losing the answer.
const updateLog=new updater.UpdateLog({file:path.join(configRoot(),'launcher-update.log'),version:APP_VERSION});
let client={installed:false,version:null,updatedAt:null,record:null};
// doc/launcher-states.md, "Home actions, Settings and enhanced graphics": the
// machine decides the default once, and the player's own choice wins from then on.
// `graphics` is always present in desktop mode, so no view has to wait for it.
let graphics=null,hardware=null,quality=null;
// A player who has never seen the control has no recorded choice; the launcher then
// answers for the machine. `chosen` is what makes "once" true across restarts: an
// explicit choice is never re-decided, and a fresh settings file is not a choice.
function chooseGraphicsDefault(stored,recommended){
 const state=stored&&typeof stored==='object'?stored:{};
 if(state.graphicsChosen===true)return {includeGraphics:Boolean(state.includeGraphics),chosen:true};
 if(typeof state.includeGraphics==='boolean')return {includeGraphics:state.includeGraphics,chosen:true};
 return {includeGraphics:Boolean(recommended),chosen:false};
}
// The variables that make the client render on the display GPU. Empty on a machine
// where the driver's own default already is that GPU, and on platforms that choose
// per application themselves; the contract says the launcher never pretends to
// override a choice it cannot make.
function launchEnvironment(){return renderOffload({platform:process.platform,target:hardware?.target||null,via:hardware?.via||null});}
function hardwareState(){
 if(hardware){
  // Only the contract's fields plus the descriptive extras the UI reads: the launch
  // target (a PCI bus id) stays in the main process where it is used.
  const {gpu,vendor,vramMB,tier,reason,software,adapters,via,offload}=hardware;
  return {gpu,vendor,vramMB,tier,reason,source:hardware.source||'none',recommended:hardware.recommended!==false,tunable:Boolean(hardware.tunable),software:Boolean(software),adapters,via:via||null,offload:Boolean(offload)};
 }
 if(graphics)return graphics;
 // Detection runs before the first broadcast; this is only reached if it failed.
 return {gpu:null,vendor:null,vramMB:null,tier:'unknown',reason:'The graphics adapter could not be identified, so enhanced graphics are left on.',source:'none',recommended:true,tunable:false};
}
function graphicsState(){
 const recommended=hardware?hardware.recommended:true;
 return {enabled:Boolean(settings?.includeGraphics),recommended,tunable:Boolean(hardware?.tunable),tuned:quality};
}
// ---- The game server, which may be asleep --------------------------------
// doc/launcher-states.md, "The game server, which may be asleep". This is game state,
// not account state: it has its own field, its own copy and its own failure sentence,
// and nothing in it can make the account, the client install or a download look wrong.
// `gameServer` is the last answer the status service gave, `gameChecked` says whether
// anybody has asked yet (so the launcher never calls a server offline it never asked
// about), and `gameWake` is the wake-and-poll run a Play press started.
let gameServer=null,gameChecked=false,gameCheckedAt=null,gameWake=null;
function gameState(){
 const status=gameServer;
 const waking=Boolean(gameWake&&!gameWake.settled);
 // One call decides both halves of the row the player sees: `message` is every word of the
 // status line and `tone` is what the LED dot repeats, so the view prints a sentence and
 // paints a dot without inventing or re-deriving either of them.
 const line=gameStatusLine(status||{state:'unknown',ready:false},{waking,checked:gameChecked});
 return {
  state:status?status.state:'unknown',
  ready:Boolean(status&&status.ready),
  endpoint:status?status.endpoint:null,
  since:status?status.since:null,
  players:status?status.players:null,
  detail:status?status.detail:null,
  message:line.message,
  tone:line.tone,
  waking,
  checkedAt:gameCheckedAt
 };
}
// The session token is read per call rather than captured, so the renewal or reissue
// that runs alongside a wake is used instead of failing the wait.
function gameToken(){return company?.token||null;}
// One route call, as the wait rule wants it: an answer it can respect, or the fact
// that nothing answered. A refusal of the account session is the one code that keeps
// its own sentence, because there the account really is the news; every other failure
// is 'no answer', which is never reported as a server being online.
async function gameAnswer(call){
 try{return {ok:true,status:await call()};}
 catch(error){
  if(error?.name==='AbortError')throw error;
  return {ok:false,code:String(error?.code||error?.name||'unreachable')};
 }
}
function gameRoutes(signal){
 const token=gameToken();
 if(!token)return null;
 return {
  read:()=>gameAnswer(()=>accounts.gameStatus(gameToken(),signal)),
  wake:()=>gameAnswer(()=>accounts.wakeGame(gameToken(),signal))
 };
}
// One Play press starts at most one wake. The wait begins before the account and
// client work in play(), so the cold start overlaps them instead of being paid after
// them, and play() cancels it when it does not reach a launch.
function beginGameWake(){
 if(gameWake&&!gameWake.settled)return gameWake;
 const controller=new AbortController();
 const routes=gameRoutes(controller.signal);
 if(!routes)throw new GameWaitError('game_session_expired','Your Easter Company session expired. Sign in again.');
 const run={settled:false,controller,outcome:null};
 gameWake=run;
 run.promise=wakeServer({...routes,signal:controller.signal,onUpdate:({status})=>{
  gameChecked=true;gameCheckedAt=new Date().toISOString();
  if(status)gameServer=status;
  notify({});
 }}).then(result=>{run.outcome=result.outcome;return result;}).finally(()=>{
  run.settled=true;
  if(gameWake===run)gameWake=null;
 });
 // play() is the only caller that waits, and it may return early before it does.
 run.promise.catch(()=>{});
 return run;
}
// One silent status read, so the hero can honestly say the server is offline (or that
// nobody has looked) before the player presses Play. It never wakes anything and never
// announces a failure: an unreachable service leaves the state at 'unknown'.
async function refreshGameStatus(){
 if(gameWake&&!gameWake.settled)return;
 const routes=gameRoutes();
 if(!routes)return;
 // This read can now take a while (the client retries it inside one budget), so it remembers
 // which account asked. An answer that lands after a sign-out or an account switch is thrown
 // away rather than published: it was proved with a session that is no longer this player's,
 // and the next account's own read is the one that may speak for it.
 const forAccount=company?.account.id||null;
 const answer=await gameAnswer(()=>accounts.gameStatus(gameToken()));
 if(!forAccount||!company||company.account.id!==forAccount)return;
 gameChecked=true;gameCheckedAt=new Date().toISOString();
 if(answer.ok&&answer.status)gameServer=answer.status;
 notify({});
}
// What still stands between the player and the game, in the order the launcher asks for
// it. One list, computed here: the UI renders it, and the game shortcut reads it to
// decide whether a launch may go ahead without stopping to ask the player anything.
function remainingActions(){
 const install=installInfo(),actions=[];
 if(!install.installed)actions.push('download');
 if(!company)actions.push('signin');
 else if(!companyReady())actions.push('setup-password');
 // An account with no Microsoft link at all cannot launch, and a linked account this machine
 // cannot make a session for needs the interactive flow. The two are different sentences, so
 // they are different actions: `link-microsoft` is "there is nothing to play with yet" and
 // `connect-microsoft` is "this account has a session, prove it here".
 else if(!company.account.microsoftSubject)actions.push('link-microsoft');
 else if(!minecraftPlayable())actions.push('connect-microsoft');
 else if(identity.access(session)==='missing'&&sessionSource()==='local')actions.push('buy');
 else if(identity.access(session)==='profile-required'&&sessionSource()==='local')actions.push('setup-profile');
 else if(identity.access(session)==='unknown'&&sessionSource()==='local')actions.push('check-access');
 return actions;
}
// A Minecraft session can be had: this machine's own, or one the account service mints.
function minecraftPlayable(){return sessionSource()!=='none';}
// The frozen Play gate. `canPlay` in the state is exactly this, and the game shortcut
// asks the same question before it starts anything.
function canPlayNow(){return !accountWorking&&companyReady()&&minecraftPlayable()&&sessionAccessOk()&&!accessChecking&&startupReady&&!backgroundUpdate&&!['downloading','paused','verifying','installing','updating','checking-client'].includes(phase)&&canPlay(installInfo(),launchProfile());}
async function readQuality(){quality=await installedQuality(gameRoot());return quality;}
function installInfo(){
 const installed=Boolean(client.installed);
 return {location:gameRoot(),defaultLocation:defaultLocation(),installed,includeGraphics:Boolean(settings?.includeGraphics),version:installed?client.version:null,updatedAt:installed?client.updatedAt:null};
}
function notify(patch={}){
 if(company&&company.expiresAt<=Date.now())company=null;
 // A cache that is not this account's answer is this account's to discard, not to show. Signing
 // out, switching account and an identity conflict all arrive here, because every one of them is
 // a broadcast, and the comparison is the one the mint makes for its own session.
 if(cachedAnswer&&!cacheIsThisAccount())forgetSessionCache();
 // A failure is announced once, by the broadcast that settles the operation that failed,
 // and every later broadcast drops it again. Anything else leaves a stale sentence in the
 // state for any unrelated update to repaint — which is how a long-finished failure kept
 // reappearing over a sign-in the player had just started. A new account action clears it
 // as it begins, because that also starts with a broadcast that carries no error.
 if(!('error' in patch))patch={...patch,error:null};
 if('progress' in patch)progress=patch.progress;
 if(typeof patch.phase==='string')phase=patch.phase;
 // No account list. Provider sign-in refuses to replace an active account ("Sign out before
 // signing in to a different account"), switch-account is gone from the preload and the IPC
 // surface, and the one signed-in account is already `account`, so a list here could only
 // repeat state.account to a UI that has nothing to do with a second entry.
 state={...state,...patch,profile:launchProfile(),account:publicAccount(company),minecraftSession:publishedMinecraftSession(),sessionExpiresAt:company?.expiresAt||null};
 const install=installInfo(),actions=remainingActions();
 const paused=Boolean(control&&control.paused&&!control.cancelled);
 state={...state,...{phase:paused?'paused':(phase||(install.installed?'ready':'uninstalled')),progress,paused,install,actions,accessChecking,accountWorking,companyReady:companyReady(),microsoftConnected:microsoftConnected(),minecraftSession:publishedMinecraftSession(),sessionCached:sessionCacheShowing(),minecraftAccess:sessionSource()==='server'?'owned':identity.access(session),microsoftAccount:identity.publicIdentity(session),minecraftHead:headState(),canPlay:canPlayNow(),startupReady,bar:{visible:install.installed||installStarted},hardware:hardwareState(),graphics:graphicsState(),game:gameState(),settings,shortcuts:shortcutState,launcherUpdate}};
 if(window&&!window.isDestroyed())window.webContents.send('launcher:state',state);
 // A head this session has to ask Mojang for is asked for after the broadcast, never before
 // it: the state the player sees is never held open for a face (doc/launcher-states.md).
 ensureMinecraftHead();
 // The last known answer is written from an answer only, after the broadcast that published it.
 rememberSession();
}
// Nothing is transferring after this: the bar falls back to PLAY NOW or the
// sign-in action through `actions`, and the phase returns to the resting value.
function settle(message,extra={}){phase=null;progress=null;control=null;notify({message,device:controller?state.device:null,...extra});}
// The sentence a running game has always had. It is said twice now — when Play starts the game
// and when a restarted launcher comes back into one — and a second copy would be a second
// author of the same words (doc/launcher-states.md, "The launcher comes back into the game it
// left running").
const GAME_RUNNING='Minecraft is running. Your map stays right here.';
// The sentence a game's ending has always had, in one place for the same reason: a clean exit, an
// adopted game that goes away, and an Exit Game press are all "the client closed", so they are all
// one sentence and Exit Game adds no copy of its own (Owen's rule for this ticket: the label, and
// nothing else new).
const GAME_CLOSED='Minecraft closed. Ready to play.';
// The launcher's resting state, in one place because there are two shapes of it now: the
// ordinary one (Play, Download, or the client being ready) and the in-game one, which is what a
// launcher that came back to a game it did not start must publish instead of Play.
function settleResting(){
 if(game)return notify({phase:'running',message:GAME_RUNNING,device:null,progress:null});
 return settle(client.installed?'Client ready.':'Download the game to get started.');
}
async function refreshClient(){client=await clientStatus(gameRoot());await install.loadDeployment(gameRoot());await readQuality();}
// The display the client will open on, in the pixels the player actually has. Electron
// reports a display's size in device-independent pixels, so a 2160p screen at 200%
// scaling reports 1920x1080 there; the client's interface is laid out in physical
// pixels, which is why the GUI scale table is read in them. The primary display is
// meant on purpose: the client opens fullscreen, and the primary display is what a
// fullscreen window opens on and what the player is looking at. The screen module
// only answers once the app is ready, so this is only ever called from the startup
// path and the pipeline, never at module load, and a display it cannot describe is
// passed on as unknown rather than guessed.
function clientDisplayPixels(){
 try{return displayPhysicalPixels(screen.getPrimaryDisplay());}
 catch{return {widthPx:null,heightPx:null};}
}
function clientGuiScale(){return displayGuiScale(clientDisplayPixels());}
// Owen asked for a first launch that is already fullscreen at a GUI scale suited to the
// screen, and a returning player never reaches the install pipeline: for a tree that is
// already installed and current, checkForUpdates reports "nothing changed" and never
// calls installClient, so the display defaults are seeded from the startup path too. It
// is once per client tree - a tree that carries the seed record is two file reads and
// nothing else - and it writes only inside the launcher's own marked tree. It never
// runs while a client process is up, because a running client rewrites options.txt on
// exit and would silently undo it; at startup there is no client process. It cannot
// throw and it never touches startupReady or the broadcast state, so no view waits on
// it and no status field describes it.
async function seedClientDisplay(){
 if(!client?.installed||game)return null;
 try{return await applyDisplayDefaults(gameRoot(),{guiScale:clientGuiScale()});}
 catch{return null;}
}
function secureStorageAvailable(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
const vaultOptions=()=>({safeStorage,platform:process.platform});
function saveSession(){
 // One saved Microsoft session, not a list: the multi-account store was removed with
 // provider sign-in (only the active credential survives a migration), so the vault keeps
 // the array shape old vaults were written in while holding at most this one entry.
 savedAccounts=session?[session]:[];
 const payload={active:identity.id(session),accounts:[...savedAccounts]};
 // Skin loading and sign-in can finish together. Serialize atomic vault writes.
 sessionWrite=sessionWrite.catch(()=>{}).then(async()=>{
  const remember=await vault.writeEncrypted(accountsFile(),payload,vaultOptions());
  if(!remember)await vault.remove(accountsFile());
  await vault.remove(vaultFile()); // Legacy single-account vault after migration.
  notify({remembered:remember&&Boolean(session)});
 });
 return sessionWrite;
}
// What a vault entry has to be for this launcher to restore it. identity.valid() is today's
// rule — a session with a refresh token this machine can renew. The second case is the one the
// hand-over creates: the refresh token is gone on purpose because the account service holds it,
// and what is left is still the player's Java profile, which is what the launcher shows and
// what the next mint is checked against.
function restorableSession(entry){
 if(identity.valid(entry))return true;
 return Boolean(entry&&entry.serverHeld===true&&identity.id(entry)&&/^[a-f0-9]{32}$/i.test(entry?.profile?.id||'')&&/^\w{1,16}$/.test(entry?.profile?.name||''));
}
// One Minecraft skin, read from Mojang's own public endpoints. Nothing here needs a
// credential: the profile answers for any uuid, and the texture it names is a public file.
// Both reads are bounded, the body is capped at the skin's own 128 KB, and every failure is
// "no skin" rather than an error, because a face is never a reason to fail at anything.
const SKIN_TEXTURE_URL=/^https?:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]+$/i,SKIN_MAX_BYTES=131072;
async function skinTextureUrl(id){
 try{
  const response=await net.fetch('https://sessionserver.mojang.com/session/minecraft/profile/'+id,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)return null;
  const data=await response.json(),property=data.properties?.find(p=>p.name==='textures');
  if(!property||typeof property.value!=='string')return null;
  return JSON.parse(Buffer.from(property.value,'base64').toString()).textures?.SKIN?.url||null;
 }catch{return null;}
}
async function skinDataUrl(url){
 if(!SKIN_TEXTURE_URL.test(url||''))return null;
 try{
  const response=await net.fetch(url.replace('http:','https:'),{signal:AbortSignal.timeout(5000)});
  if(!response.ok)return null;
  const reader=response.body.getReader(),chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>SKIN_MAX_BYTES){await reader.cancel();return null;}chunks.push(Buffer.from(value));}
  const png=Buffer.concat(chunks);
  return png.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'data:image/png;base64,'+png.toString('base64'):null;
 }catch{return null;}
}
async function loadSkin(target){
 if(!target?.profile)return;
 try{
  const skin=await skinDataUrl(target.profile.skinURL||await skinTextureUrl(target.profile.id));
  if(skin)target.profile.skin=skin;
 }catch{} // Skin service availability never blocks playing.
}
// ---- The head without a live Microsoft token -----------------------------
// doc/launcher-states.md, "A password sign-in still knows the account is linked". A Company
// sign-in with a username and password restores no Microsoft session, so `profile.skin` is
// null, yet the account document already carries the Minecraft identity it is linked to. That
// uuid answers on Mojang's own public endpoints with no credential, so the head is read here
// and cached beside the account vaults: once per account, not once per render, and never when
// the live session's own skin already answers for the same face.
let minecraftHead=null,minecraftHeadUuid=null,headAttempt=null;
const headTried=new Set(),HEAD_MAX_CHARS=200000;
const headFile=()=>path.join(configRoot(),'minecraft-head.json');
function accountHeadUuid(){
 const uuid=company?.account?.minecraftUuid;
 return typeof uuid==='string'&&uuid?uuid.toLowerCase():null;
}
// With a live Microsoft session the head comes through profile.skin, and one face has one
// source, so nothing is read from the uuid then.
function wantedHeadUuid(){
 const account=company?.account;
 if(!account||account.microsoftLinked!==true||microsoftConnected())return null;
 return accountHeadUuid();
}
// The signed-in account's own head or nothing: a head cached for a different account is never
// published, so a second player on this computer is never shown the first one's face.
function headState(){const uuid=accountHeadUuid();return uuid&&minecraftHeadUuid===uuid?minecraftHead:null;}
async function readCachedHead(){
 try{
  const stored=JSON.parse(await fs.readFile(headFile(),'utf8'));
  if(stored&&typeof stored.uuid==='string'&&typeof stored.head==='string'&&stored.head.length<=HEAD_MAX_CHARS&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(stored.head)){
   minecraftHead=stored.head;minecraftHeadUuid=stored.uuid.toLowerCase();
  }
 }catch{} // No cache, an unreadable cache and a damaged cache are all "nothing cached".
}
// One attempt per account per run, and it starts after a broadcast rather than before one: no
// view waits for a face. A successful read is written beside the vaults so a restart asks
// Mojang nothing; a failed read writes nothing, raises nothing and leaves the letter tile.
function ensureMinecraftHead(){
 const uuid=wantedHeadUuid();
 if(!uuid||headAttempt||headTried.has(uuid))return;
 if(minecraftHeadUuid===uuid&&minecraftHead)return;
 headTried.add(uuid);
 headAttempt=(async()=>{
  try{
   if(minecraftHeadUuid!==uuid)await readCachedHead();
   if(minecraftHeadUuid!==uuid){minecraftHead=null;minecraftHeadUuid=null;}
   if(minecraftHead)return;
   const head=await skinDataUrl(await skinTextureUrl(uuid.replace(/-/g,'')));
   if(!head)return;
   minecraftHead=head;minecraftHeadUuid=uuid;
   await atomicJSON(headFile(),{uuid,head});
  }catch{} // A face never fails an account, a launch or a render.
  finally{headAttempt=null;notify({});}
 })();
}
// The Easter Company session uses the same vault discipline as the Microsoft one:
// OS-backed safeStorage or nothing at all.
async function saveCompany(){
 const target=company,profile=target?.account;
 if(target){const hydrated=await hydratePicture(profile,{request:(...args)=>net.fetch(...args),nativeImage});if(company!==target)return;if(target.account===profile)target.account=hydrated;}
 const write=company?await vault.writeEncrypted(companyFile(),{token:company.token,expiresAt:company.expiresAt,account:company.account},vaultOptions()):false;
 if(!write)await vault.remove(companyFile());
}
async function forgetCompany(){
 const token=company?.token;company=null;
 // Everything this launcher knew about a stored session goes with the account it belonged to:
 // the minted session, the state word, and the sign-out-everywhere control with them. Any mint
 // still in flight was asked for on behalf of the account that has just gone, so it is ended
 // here rather than left to land on the next account's hero (mintMinecraftSession, "an answer
 // that is already out of date").
 mintedSession=null;mintedFor=null;minecraft={state:'unknown',serverHeld:false,checkedAt:null};minecraftProbe=null;cancelMints();
 // The last known answer belonged to the account that has just gone, so it goes with it — from
 // memory and from the disk, because nothing may be left for whoever signs in next.
 forgetSessionCache();
 // The account is gone as of the two lines above, so this broadcast is owed now, before the two
 // calls below. `accounts.logout` is a write to the account service - bounded only by its own
 // eight-second timeout (accounts.cjs) and measured at 544 ms against the launcher fixture - and
 // `vault.remove` is a second await on top of it. Held behind them, this broadcast left the
 // header naming the account that had just been signed out for as long as the service took: the
 // renderer keeps its own copy of the account and only ever updates it from a broadcast, so for
 // that whole window `if(!current?.account){signIn();return;}` could not see the sign-out and the
 // click reopened the profile menu for the account that was already gone. Nothing below can
 // change whether the account exists, so there is nothing for the view to wait for.
 notify({});
 if(token)await accounts.logout(token);
 await vault.remove(companyFile());
}
// A session the account service has refused, forgotten in one place for every caller: this
// file's own copy of the account, the Minecraft session that belonged to it, and the state word
// with them. Not a logout call — a token the service has refused cannot be logged out — and no
// cancelMints: the caller may be the mint that just met the refusal.
async function forgetRefusedCompany(){
 company=null;mintedSession=null;mintedFor=null;minecraft={state:'unknown',serverHeld:false,checkedAt:null};
 forgetSessionCache();
 await vault.remove(companyFile());notify({});
}
async function accountOperation(action){
 if(accountWorking||controller||game||(working&&!control))throw Error('Wait for the current operation to finish.');
 accountWorking=true;notify({});
 // The stage updater is passed down so a write that meets a waking account service can name
 // `company-waking` and the open dialog can say it (doc/launcher-states.md, *Every account
 // journey waits out a cold account service*). Handlers that ignore it are unaffected.
 try{return await withActivity('account-working',update=>control?action(update):exclusively(()=>action(update)));}
 finally{accountWorking=false;notify({});}
}
async function renewCompany(){
 const target=company;if(!target)return;
 try{const signed=await accounts.refreshSession(target.token);if(company!==target||accountWorking||controller)return;company=companySession(signed);await saveCompany();notify({});}
 catch(error){if(company!==target)return;if(error.code==='invalid_session'){company=null;await vault.remove(companyFile());notify({message:ACCOUNT_MESSAGES.invalid_session});}}
}
function companyReady(){return Boolean(company&&company.expiresAt>Date.now()&&company.account.passwordRequired===false);}
// What this process holds of its own: a Microsoft leg of this account. It keeps exactly the
// meaning it always had, and it is no longer the Play gate — the contract asks a question
// about the account, and this answers one about this computer
// (doc/launcher-states.md, "The Minecraft session the account service holds").
function microsoftConnected(){return Boolean(company&&session&&company.account.microsoftSubject&&session.companySubject===company.account.microsoftSubject);}

// ---- The Minecraft session the account service holds ------------------------
// doc/launcher-states.md, "The Minecraft session the account service holds". Three things
// live here: what this launcher knows about a stored session (`minecraft`), the Minecraft
// session the service minted for this launch window (`mintedSession`, never written to the
// vault), and the five questions the gate and the launch ask together so they can never
// disagree about which session a press would use.
let minecraft={state:'unknown',serverHeld:false,checkedAt:null},mintedSession=null,mintedFor=null,minecraftProbe=null;
// Every mint currently in flight, so signing out or switching accounts ends them instead of
// leaving each one to land on the wrong hero. A mint is asked for on behalf of one account and
// can be answered later than the player's next decision, so the request carries the account it
// was made for and this set is how that request is given up.
const mintRequests=new Set();
function cancelMints(){for(const abort of mintRequests)abort.abort();mintRequests.clear();}
const MINECRAFT_REVOKED='Signed Minecraft out everywhere. The next game on any computer needs a Microsoft sign-in.';
const MINECRAFT_NOT_REVOCABLE='The launcher cannot sign Minecraft out on other computers yet.';
const MINECRAFT_NOTHING_STORED='No Minecraft session was stored for your account, so there was nothing to sign out.';
// A saved session of this account, as this machine holds it. The subject match is what makes
// the session this account's rather than a leftover of another one.
function sessionOfAccount(){return Boolean(company&&session&&company.account.microsoftSubject&&session.companySubject===company.account.microsoftSubject);}
// Today's launch path: a saved refresh token can renew the session here, so nothing about this
// press changes for the player whose Microsoft session is live on this machine.
function localRefreshable(){return Boolean(sessionOfAccount()&&typeof session.refreshToken==='string'&&session.refreshToken);}
// The day after a hand-over: the access token the launcher already holds is still good.
function localTokenLive(){return Boolean(sessionOfAccount()&&session.accessToken&&Number.isFinite(session.expiresAt)&&session.expiresAt>Date.now()+60000);}
// A minted session belongs to the account it was minted for, and to no other. `mintedFor` is that
// account id, so signing out and in as someone else — or an older account's session still sitting
// in memory — can never be offered as this account's, and the hero can never name the previous
// player's Minecraft profile.
function mintedIsCurrent(){return Boolean(mintedSession&&company&&mintedFor===company.account.id);}
// Which way a press would get its session, in the contract's order. `local`, `server`, or
// `none` — and `server` is "the account service holds one for this account", which is a fact
// the launcher only states after an answer, never a hope.
function sessionSource(){
 if(!company||!company.account.microsoftSubject)return 'none';
 if(localRefreshable()||localTokenLive())return 'local';
 return minecraft.state==='server'&&mintedFor===company.account.id?'server':'none';
}
// Java access, per source. A local session is checked exactly as it always was; a minted one
// is proof in itself, because the service cannot mint a Minecraft profile for an account that
// does not own the game.
function sessionAccessOk(){
 const source=sessionSource();
 if(source==='local')return identity.access(session)==='owned';
 return source==='server';
}
// The Minecraft profile the launcher shows and launches with: this machine's own session
// first, then the one the service minted. Nothing here is invented from the Company account.
function launchProfile(){
 if(session?.profile)return publicProfile(session);
 const profile=mintedIsCurrent()?mintedSession.profile:null;
 return profile?{name:profile.name,id:profile.id,skin:null}:null;
}
function minecraftSessionState(){
 if(!company)return null;
 if(!company.account.microsoftSubject)return 'unlinked';
 // `local` is a claim about this machine, and this document's own sentence for the word is
 // "can make a launch out of it": a refresh token of this account, or an access token that
 // has not expired. Holding a matching Microsoft leg that can do neither — an expired access
 // token with no refresh token left, which is exactly what a machine keeps once the stored
 // session is gone — is not `local`. Said there, the word would keep claiming a session this
 // machine cannot make, and a dead session could never be offered the reconnect that is the
 // only way back (measured: the revoke answered `reauth`, the hero still read `local`).
 if(localRefreshable()||localTokenLive())return 'local';
 if(minecraft.state==='checking'||minecraft.state==='reauth'||minecraft.state==='busy')return minecraft.state;
 if(minecraft.state==='server'&&mintedFor===company.account.id)return 'server';
 // An answer this launcher could not read, or could not get at all, is published as `unknown`:
 // it is not evidence about the player's Microsoft session, and collapsing it into `required` is
 // what put a Microsoft prompt on Owen's screen for a session nobody had asked about. `required`
 // is kept for the one case it means — a linked account, nothing asked yet and nothing recorded
 // — and `minecraft.checkedAt` is what tells the two apart, because every answer sets it.
 if(minecraft.state==='unknown')return minecraft.checkedAt?'unknown':'required';
 return 'required';
}
function minecraftStateField(){
 const state=minecraftSessionState();
 return state===null?null:{state,serverHeld:Boolean(minecraft.serverHeld),checkedAt:minecraft.checkedAt||null};
}
// ---- The last known answer, while the launcher confirms it -------------------
// doc/launcher-states.md, "The last known answer, shown while it is confirmed". The file's own
// shape, whitelist and bound live in desktop/session-cache.cjs, and `tests/desktop/
// session-cache.test.cjs` proves that no secret-shaped value can reach it.
//
// THE CACHE NEVER AUTHORISES ANYTHING, and this comment is the place that says so: nothing
// below is read by canPlayNow(), sessionSource(), sessionAccessOk(), launchProfile() or
// launchSession(). The mint still runs at startup exactly as before, Play still goes through
// the same gate in this file, and a press still mints (or refreshes) a real session — so a
// cached `local` that has since become `reauth` can only change what the hero says, the moment
// the truth lands, and there is no window in which a launch happens on a cached fact. The one
// thing published from it is the session word the hero draws, the moment it was written, and
// the flag `sessionCached` that says the answer is not confirmed yet.
const sessionCacheFile=()=>path.join(configRoot(),'session-cache.json');
let cachedAnswer=null,cacheShowing=false,cacheKey=null,cacheWriting=Promise.resolve();
// The file describes one account's answer: this launcher's, or nobody's. `belongs` is the
// same comparison `mintMinecraftSession` makes for a minted session — the account, and the
// Minecraft identity the service is the authority on.
function cacheIsThisAccount(){
 return Boolean(cachedAnswer&&company&&sessionAnswer.belongs(cachedAnswer,company.account));
}
// The one place the cached answer stands in for a live one: exactly where the hero would
// otherwise print "Checking your Minecraft session…" (site/desktop.js, both branches) — the
// launcher is asking, or nothing has been asked yet. Any real answer, including a question
// nobody could answer, is the truth and is published as itself.
function sessionCacheShowing(){
 if(!cacheShowing||!cachedAnswer)return false;
 if(!cacheIsThisAccount())return false;
 return minecraft.state==='checking'||(minecraft.state==='unknown'&&!minecraft.checkedAt);
}
// The session field the views read: the live answer, or the last known one with the moment it
// was written beside it. The flag and `cachedAt` are the whole difference, so no view infers
// anything from a state word.
function publishedMinecraftSession(){
 const live=minecraftStateField();
 if(live===null||!sessionCacheShowing())return live;
 return sessionAnswer.published(cachedAnswer);
}
// Whatever the mint the launcher starts at startup answers — a session, a refusal, no route at
// all — the cached answer has been confirmed or contradicted, so it stops standing in for one.
// This is the answer's own moment, not a timer: it clears in the turn the promise settles,
// which is why a `route_absent` answer (an answer that leaves the unasked word behind) cannot
// leave a stale claim on the hero.
function disarmSessionCache(){
 if(!cacheShowing)return;
 cacheShowing=false;notify({});
}
async function readSessionCache(){
 const account=company?.account;
 // No account, no answer to show. A file left behind describes an account this launcher no
 // longer holds, so it is removed rather than kept for whoever signs in next.
 if(!account){cachedAnswer=null;cacheShowing=false;try{await fs.rm(sessionCacheFile(),{force:true});}catch{}return null;}
 let raw;
 try{raw=await fs.readFile(sessionCacheFile(),'utf8');}
 catch{return null;} // no cache at all is today's cold start, word for word
 const {cache}=sessionAnswer.parse(raw,{liveAccount:account});
 if(!cache){
  // A corrupt, unknown-version, stale or another-account file is deleted and ignored: never a
  // crash, never a blocked startup, and never a second chance for the same bad file.
  cachedAnswer=null;cacheShowing=false;
  try{await fs.rm(sessionCacheFile(),{force:true});}catch{}
  return null;
 }
 cachedAnswer=cache;cacheShowing=true;
 return cache;
}
// The file is written only from an answer, and only when the answer changes: `build` refuses a
// `checking` word and the unasked one, so a restart can never read a guess back as an answer,
// and a transfer's hundredth broadcast costs one string comparison.
function rememberSession(){
 const account=company?.account;
 if(!account)return;
 const field=minecraftStateField();
 const record=sessionAnswer.build({writtenAt:new Date().toISOString(),account,minecraftSession:field,minecraftAccess:sessionSource()==='server'?'owned':identity.access(session),install:installInfo()});
 if(!record)return;
 const key=JSON.stringify(record.account)+JSON.stringify(record.minecraftSession)+JSON.stringify(record.minecraftAccess)+JSON.stringify(record.install);
 if(key===cacheKey)return;
 cacheKey=key;
 cacheWriting=cacheWriting.catch(()=>{}).then(()=>atomicJSON(sessionCacheFile(),record)).catch(()=>{});
}
// Signing out, an account switch and an identity conflict all end the answer it described.
// Fire and forget on purpose: every caller of this is already inside a broadcast or a refusal,
// and no player waits on a file being removed.
function forgetSessionCache(){
 cachedAnswer=null;cacheShowing=false;cacheKey=null;
 void fs.rm(sessionCacheFile(),{force:true}).catch(()=>{});
}
// The two spellings of a Minecraft profile id: 32 hex characters, which is what the game is
// launched with, and the dashed form the account record holds. One helper each way, so the
// account the service describes and the session it mints can never disagree about the player.
function dashedUuid(id){const hex=String(id||'').replace(/-/g,'').toLowerCase();return /^[a-f0-9]{32}$/.test(hex)?[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'):null;}
function bareUuid(id){return String(id||'').replace(/-/g,'').toLowerCase();}
// The minted session in the shape a launch already uses, so nothing downstream has to know
// which of the three ways it came from. No refresh token and no Xbox token: this is a
// Minecraft access token and the profile it belongs to, and it is never persisted.
function sessionFromMint(minted){
 return {
  serverMinted:true,
  accessToken:minted.accessToken,
  expiresAt:minted.expiresAt,
  profile:{id:minted.profile.id,name:minted.profile.name,skin:session?.profile?.id===minted.profile.id?session.profile.skin:undefined},
  minecraftAccess:'owned',
  companySubject:company?.account.microsoftSubject||null,
  accountId:minted.profile.id
 };
}
// One request, three answers, and the state word each of them earns. `reauth_required` is the
// one refusal about the Microsoft session itself; everything else — no such route, no answer,
// a 5xx, a body this launcher cannot read — is no answer at all, and no answer never disables
// anything. This is the only place a session is asked for, so a machine can never end up with
// two different ideas of whether the account has one.
//
// AN ANSWER THAT IS ALREADY OUT OF DATE. The client retries this call for up to three minutes
// (desktop/accounts.cjs, OPERATIONS), which is long enough for the player to sign out, sign in
// as somebody else or switch accounts while the request is open. The account this answer belongs
// to is therefore fixed BEFORE the request goes out, and an answer that arrives after that
// account has gone is discarded: it never becomes `mintedSession`, never moves the hero out of
// `checking`, and never paints a state word on somebody else's account. `mintedFor` is what the
// rest of this file reads to decide whether a session belongs to the current account, and this
// is the one place that writes it.
async function mintMinecraftSession({announce=false}={}){
 if(!company||!company.account.microsoftSubject)return {outcome:'none'};
 // This machine's own check of this very account is fresher than a mint can be, and a service
 // answer may not be used to contradict it: an account the launcher has just found may not play
 // Minecraft is offered the Buy Now path, never a session minted from a stored token. A machine
 // with no session of its own (a password sign-in) asks, because then the service is the only
 // thing that knows.
 if(sessionOfAccount()&&identity.access(session)!=='owned')return {outcome:'none'};
 const forAccount=company.account.id,forSubject=company.account.microsoftSubject,token=company.token;
 // The account is compared, not the token: a Company session reissued while this request was
 // open is still the same account's request, so its answer is still this player's.
 const current=()=>Boolean(company&&company.account.id===forAccount&&company.account.microsoftSubject===forSubject);
 const abort=new AbortController();
 mintRequests.add(abort);
 minecraft={...minecraft,state:'checking'};
 if(announce)notify({});
 try{
  const minted=await accounts.gameSession(token,abort.signal);
  if(!current())return {outcome:'stale'};
  mintedSession=minted;mintedFor=forAccount;
  minecraft={state:'server',serverHeld:true,checkedAt:new Date().toISOString()};
  // The service named this account's own Java profile. If the account's record disagreed, the
  // service is the authority: it minted the session from the Microsoft account itself. The
  // record keeps the dashed spelling its own validation requires, and the comparison is made
  // on the bare one so the two can never disagree about punctuation.
  const minecraftUuid=dashedUuid(minted.profile.id);
  if(minecraftUuid&&(bareUuid(company.account.minecraftUuid)!==bareUuid(minecraftUuid)||company.account.minecraftName!==minted.profile.name)){
   company={...company,account:{...company.account,minecraftUuid,minecraftName:minted.profile.name}};
   await saveCompany();
  }
  notify({});
  return {outcome:'server',session:minted};
 }catch(error){
  // This launcher's own cancellation means the account it was asked for is gone: there is
  // nothing to say about the account that replaced it.
  if(error?.name==='AbortError'){if(abort.signal.aborted)return {outcome:'stale'};throw error;}
  if(!current())return {outcome:'stale'};
  const code=String(error?.code||'');
  // Four answers, four different owners (doc/launcher-states.md, "The four facts"):
  //  * reauth_required is the only one about the Microsoft session itself, so it is the only one
  //    answered with the interactive flow, and the stored session stops being something this
  //    launcher claims.
  //  * a dead Easter Company session is the ACCOUNT's news: the player signs in to their account
  //    again, never to Microsoft for it. The refused session is forgotten here, in the one
  //    function that already forgets a refused account session, so the state carries no account
  //    and the hero offers the account's own sign-in (kind `signin`, LOGIN_ACTION/LOGIN_NOTE)
  //    instead of a Microsoft prompt — and the chooser it opens has nothing left to refuse.
  //  * a rate limit or a service that cannot answer says nothing about the player's session: Play
  //    stays off for that press, the sentence names the service, and no prompt is opened. This is
  //    the POST-BUDGET verdict: only when the retries above are spent is "busy" true.
  //  * no such route, no answer, or a body this launcher cannot read is no answer at all: the
  //    state word is `unknown`, which the hero answers with the wait and then a retry.
  if(code==='reauth_required'){
   mintedSession=null;
   minecraft={state:'reauth',serverHeld:false,checkedAt:new Date().toISOString()};
   notify({});
   return {outcome:'reauth',error};
  }
  if(code==='invalid_session'){
   await forgetRefusedCompany();
   return {outcome:'account',error};
  }
  if(code==='rate_limited'||code==='identity_provider_unavailable'||code==='session_key_unconfigured'||code==='microsoft_not_configured'||code==='database_unavailable'||error?.status===429||Number(error?.status)>=500){
   minecraft={state:'busy',serverHeld:Boolean(minecraft.serverHeld),checkedAt:new Date().toISOString()};
   notify({});
   return {outcome:'busy',error};
  }
  // The service has no mint route at all: a launcher ahead of the cloud. Nothing was said about
  // this account's session, so nothing is recorded about it (`checkedAt` stays null) and the
  // state word stays the unasked one — which is `required`, and the interactive Microsoft
  // sign-in remains the only way to play. It is not `unknown`: a retry would ask a route that
  // does not exist, and the player would never be offered the press that works.
  if(code==='route_absent'){
   minecraft={state:'unknown',serverHeld:Boolean(minecraft.serverHeld),checkedAt:null};
   notify({});
   return {outcome:'absent',error};
  }
  // No answer, or a body this launcher cannot read. Nothing here is evidence about the player's
  // Microsoft session, so it is published as `unknown` with the moment it was tried, and the
  // hero answers it with the wait and then a retry — never a Microsoft prompt.
  minecraft={state:'unknown',serverHeld:Boolean(minecraft.serverHeld),checkedAt:new Date().toISOString()};
  notify({});
  return {outcome:'unknown',error};
 }finally{
  mintRequests.delete(abort);
 }
}
// The mint is asked for when the launcher has a reason to ask: after a sign-in that could have
// stored a session, at startup when the saved session cannot launch on its own, and inside a
// Play press. One at a time, and never by a page, a dialog or a view.
function probeMinecraftSession(){
 if(!company||!company.account.microsoftSubject)return null;
 // This machine's own check is fresher and more specific than a mint can be. When the saved
 // session of this very account already says it may not play — no Java ownership, no Java
 // profile — asking the service would only repeat that, so nothing is asked, nothing is
 // offered, and the access panel keeps saying exactly what it said before this feature existed.
 if(sessionOfAccount()&&identity.access(session)!=='owned')return null;
 if(minecraftProbe)return minecraftProbe;
 const run=mintMinecraftSession({announce:true});
 // Whatever this answers settles the cached answer too: it has been confirmed or contradicted,
 // and either way it may not go on standing in for a live one (disarmSessionCache).
 run.then(disarmSessionCache,disarmSessionCache);
 minecraftProbe=run.finally(()=>{minecraftProbe=null;});
 minecraftProbe.catch(()=>{});
 return minecraftProbe;
}
// The hand-over is proved before it is believed: only a mint the service answered justifies
// dropping this machine's own refresh token. From here on the local leg is the access token the
// launcher already holds, and after that every launch mints from the service — which is the
// point of the feature, and the honest cost of forgetting the token.
async function dropSurrenderedRefreshToken(){
 if(!session?.refreshToken)return;
 const {refreshToken,...rest}=session;
 session={...rest,serverHeld:true};
 await saveSession();
 notify({});
}
// Only a successful server-verified login replaces the current Company identity.
async function enrolAccount({announce=true,throwOnError=false,candidate=session,lockCompany=true,onStage}={}){
 if(!candidate)return;
 const activity=onStage?null:beginActivity('company-signing-in');
 const update=onStage||activity.update;update('company-signing-in');
 try{
  if(!candidate.xboxUserToken||candidate.xboxExpiresAt<Date.now()+300000)candidate=await auth.refresh(candidate,controller?.signal,false,true,update);
  const expected=lockCompany?company?.account.id:null;
  // The Microsoft Graph token is what lets the account service read the Microsoft
  // account's own email. It is optional: when it cannot be obtained the sign-in carries
  // on without it, and it is put in the first account request only.
  //
  // It also spends the refresh token it is given, so what it answers with is what this
  // machine now holds — the successor, never the spent copy (desktop/auth.cjs,
  // OFFLINE_ACCESS). A Graph leg that answered a token but no successor leaves this
  // launcher holding nothing it may present, so the spent token is dropped here rather
  // than vaulted and handed over as if it were live.
  update('company-signing-in');
  const graph=typeof auth.graphAccessToken==='function'?await auth.graphAccessToken(candidate.refreshToken,controller?.signal):null;
  const microsoftAccessToken=typeof graph?.accessToken==='string'&&graph.accessToken?graph.accessToken:null;
  if(graph){
   const {refreshToken,...rest}=candidate;
   candidate=graph.refreshToken?{...rest,refreshToken:graph.refreshToken}:rest;
  }
  // The hand-over (doc/launcher-states.md, "The hand-over, exactly once"): this machine's
  // refresh token goes to the account service on this request and no other, so the account —
  // not this computer — is what proves Microsoft from now on.
  const surrendered=typeof candidate.refreshToken==='string'&&candidate.refreshToken?candidate.refreshToken:null;
  const signed=await accounts.login(candidate.xboxUserToken,controller?.signal,lockCompany&&company?.expiresAt>Date.now()?company.token:undefined,microsoftAccessToken,update,surrendered);
  // The Microsoft identity the service answered with is not the one this launcher is signed
  // in to. The sentence is the account service's own, from the one table that words these
  // refusals (accounts.cjs MESSAGES), so the player reads the same copy whichever side
  // noticed the conflict — here, or in the service's own answer further up.
  if(expected&&signed.account.id!==expected){
   // The Microsoft identity on screen is not this account's, so the last known answer is not a
   // fact about whoever is signed in: it is discarded with the refusal (ticket 19e51885).
   forgetSessionCache();
   throw new AccountError('identity_conflict',ACCOUNT_MESSAGES.identity_conflict);
  }
  const next=companySession(signed),previous=company;
  session={...candidate,companyId:next.account.id,companyName:next.account.displayName||next.account.minecraftName||'Company member',companyUsername:next.account.username||null};
  company=next;
  // A different account is a different hero: a mint still running for the account that was here
  // is ended rather than left to answer for this one (mintMinecraftSession).
  if(!previous||previous.account.id!==next.account.id)cancelMints();
  await loadSkin(session);await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  // The hand-over is proved, never assumed: one mint, and only a session it answers justifies
  // dropping this launcher's own copy of the refresh token. No answer at all (the route is not
  // deployed, the service is unreachable) leaves this machine exactly as it was, which is why a
  // launcher can ship before the routes exist.
  if(surrendered){
   const proved=await mintMinecraftSession();
   if(proved?.outcome==='server')await dropSurrenderedRefreshToken();
  }
  // The account is announced only while this launcher still holds it: a mint inside that proof can
  // answer invalid_session and forget the session it was asked about (sessionLost), and a notice
  // claiming a sign-in the launcher has just dropped would be the one false sentence on screen.
  if(announce&&company)notify({message:signed.created?'Easter Company account created. Set a password to finish.':'Signed in to your Easter Company account.'});
  // An interactive sign-in is the first moment the launcher can ask the game server
  // anything at all (the status read is authenticated with this session). It is a read
  // and never a wake: pressing Play is the only thing that starts a server.
  if(announce)void refreshGameStatus();
  // The account service's answer about the Microsoft account's own email address travels
  // back on the sign-in answer, not in the state: it is one status word ('stored',
  // 'unavailable', 'none') with no address in it, and the sign-in dialog is the only thing
  // that needs it, for the one sentence it shows when Graph could not be read.
  return {...publicAccount(company),...(typeof signed?.emailStatus==='string'?{emailStatus:signed.emailStatus}:{})};
 }catch(error){
  if(error.name==='AbortError')throw error;
  if(throwOnError)throw error;
  notify({message:error.message||'The Easter Company account could not be signed in.'});
 }finally{activity?.end();}
}
function safeError(error){
 if(error.name==='AbortError')return 'Sign-in cancelled.';
 // Error causes, HTTP bodies and game output never cross into the renderer.
 // AccountError messages are fixed launcher wording chosen from the API error
 // code, so they are safe to show and carry no token or response body.
 if(error.name==='AccountError')return error.message;
 if(error.name==='CancelledError')return 'The download was cancelled.';
 if(error.code==='ENOSPC')return 'There is not enough disk space to install the client.';
 if(error.code==='EACCES')return 'The launcher cannot write to its client folder. Check its permissions.';
 if(error.name==='TypeError'||error.name==='TimeoutError')return 'The connection failed. Check your network and try again.';
 const message=String(error.message||'The operation could not finish.');
 return message.includes('token')||message.includes('Bearer')?'The session could not be refreshed. Please sign in again.':message.slice(0,350);
}
async function exclusively(action){
 if(working||game||controller)throw Error(game?'Minecraft is already running.':'Another launcher operation is still running.');
 working=true;state.error=null;
 try{return await action();}catch(error){
  const message=safeError(error);
  // An identity conflict has one home and it is not the page: the sign-in dialog comes back
  // for it carrying the account service's sentence itself. Settling that sentence on the
  // state channel as well painted it in the page notice for a single frame before the
  // dialog took it over, which reads as a flicker rather than as an answer. The operation
  // still settles — the device code goes with it, because the sign-in it belonged to is
  // replaced by the dialog's own question — and no sentence travels, so the call that
  // failed is the only thing that reports it.
  if(error.code==='identity_conflict')settle(null,{device:null,error:null});
  else if(error.name!=='CancelledError')settle(message,{device:null,error:error.name==='AbortError'?null:message});
  // The typed code decides what the dialog does next (a taken username sends the player
  // back to step 1), so it survives the rethrow as a safe error message does.
  throw Object.assign(Error(message),{code:error.code});
 }finally{
  working=false;
  // Whatever this operation was — an install, a sign-in, an update check — it was the reason a
  // staged launcher update was waiting, so the launcher asks again now that it is over.
  retryStagedUpdateApply();
 }
}
// One control per pipeline run: it is what pause, resume and cancel act on, and
// what makes the state report `paused` only while a paused transfer can continue.
async function withControl(action){
 control=createControl({onChange:()=>notify({})});
 installStarted=true;
 try{return await action();}
 catch(error){
  if(error&&error.name==='CancelledError'){
   await refreshClient();
   control=null;phase=null;progress=null;
   notify({message:'Download cancelled. Nothing already installed was changed.',device:controller?state.device:null});
   return null;
  }
  throw error;
 }finally{control=null;}
}
async function runInstall({includeGraphics=Boolean(settings.includeGraphics)}={}){
 return withControl(async()=>{
  const result=await installClient({root:gameRoot(),settings,notify,control,mode:'install',includeGraphics,hardware:hardwareState(),guiScale:clientGuiScale()});
  await refreshClient();
  if(!client.installed)throw Error('Installation did not complete. Retry to repair the missing client files.');
  settle(result.message||'Client ready.');
  return result;
 });
}
// The same pipeline and the same reporting as a first install. A check that finds
// nothing publishes nothing: withControl only sets the flag, and checkForUpdates
// does not notify at all unless it is going to do work.
async function runUpdate(){
 return withControl(async()=>{
  const result=await checkForUpdates({root:gameRoot(),settings,notify,control,includeGraphics:Boolean(settings.includeGraphics),hardware:hardwareState(),guiScale:clientGuiScale()});
  await refreshClient();
  if(result.applied)settle(result.result?.message||'Client updated.');
  return result;
 });
}
// The player's own choice, kept as their choice. Nothing here re-decides it: the
// machine's automatic answer is only ever the value a fresh settings file gets.
async function persistGraphics(enabled){
 settings={...settings,includeGraphics:Boolean(enabled)};
 await atomicJSON(settingsFile(),{...settings,graphicsChosen:true});
 return settings;
}
// One toggle, one pipeline. On: the optional graphics chunk is fetched through the
// checksum-verified pipeline and the client's quality settings are written inside
// the app-owned client tree. Off disables shaders and managed foliage locally;
// cached downloads and the base chunk are retained.
async function setGraphics(enabled){
 if(typeof enabled!=='boolean')throw Error('The enhanced graphics toggle must be on or off.');
 await persistGraphics(enabled);
 await refreshClient();
 if(!client.installed){
  notify({message:enabled?'Enhanced graphics will be installed with the game.':'Enhanced graphics are off.'});
  return installInfo();
 }
 return withControl(async()=>{
  let result;
  try{
   result=await applyGraphics({root:gameRoot(),settings,notify,control,includeGraphics:enabled,hardware:hardwareState(),guiScale:clientGuiScale()});
  }catch(error){
   // The toggle itself succeeded: the player's choice is saved and the next check
   // picks the chunk up. Only the transfer failed, and that is what is reported.
   settle(safeError(error));
   throw error;
  }
  await refreshClient();
  settle(result.message||(enabled?'Enhanced graphics installed.':'Enhanced graphics are off.'));
  return {...installInfo(),graphics:graphicsState(),graphicsMessage:result.graphicsMessage||null};
 });
}
// The interactive Microsoft flow itself: one device code, one browser action, one enrolment.
// It is one sequence of steps whether the player asked for it from the sign-in dialog or the
// launcher fell back to it because the stored session was dead (doc/launcher-states.md,
// "`reauth_required`: one sentence, one fallback, never a loop"), so both callers share it and
// only the dialog's caller adds the operation wrapper around it.
async function interactiveMicrosoft(options={}){
 controller=new AbortController();
 const activity=beginActivity('microsoft-opening');
 // `reason` is how a sign-in the launcher started says why it is on screen: it leads the one
 // sentence under the device code, and it is the main process's own copy, so no view words it.
 const instruction=(typeof options.reason==='string'&&options.reason?options.reason+' ':'')+'Enter this code on Microsoft’s sign-in page.';
 notify({message:'Opening Microsoft sign-in…',device:null,...(control?{}:{progress:null})});
 try{
  const signed=await auth.signIn(device=>{activity.update('microsoft-waiting');notify({device,message:instruction});},controller.signal,activity.update);
  const enrolled=await enrolAccount({candidate:signed,lockCompany:Boolean(company)||options.link===true,throwOnError:true,onStage:activity.update});
  notify({device:null,message:session.profile?'Signed in as '+session.profile.name+'.':'Microsoft sign-in complete.'});
  // The sign-in answer is the one place `emailStatus` leaves the main process, so the
  // sign-in dialog can say that Microsoft's address could not be read. No address, ever.
  return typeof enrolled?.emailStatus==='string'?{emailStatus:enrolled.emailStatus}:undefined;
 }finally{activity.end();controller=undefined;}
}
async function login(options={}){return interactiveMicrosoft(options);}
// Install or update before launch. Returns the prepared release, or null when the
// installed client is already current.
async function ensureClient(){
 await refreshClient();
 if(!client.installed)return runInstall();
 const checked=await runUpdate();
 return checked?.result||null;
}
// ---- System tray ------------------------------------------------------------
// The tray is not a second way to run the launcher: it exists for one moment, the one
// where the launcher has started the game and has stepped aside instead of closing.
// It is created when that happens, kept while the game runs, and destroyed when the
// window comes back, so the launcher never leaves an icon behind after the game.
let tray=null,trayHidden=false;
function destroyTray(){
 if(!tray)return;
 try{tray.destroy();}catch{}
 tray=null;
}
function showLauncher(){
 if(!window||window.isDestroyed()){createWindow();return;}
 // A launcher that stepped aside *for a game* keeps its tray icon until the game ends, so the
 // player always has the two actions that belong to a running game. A launcher that started in
 // the tray because an update replaced it while it was hidden has no game to look after: once
 // the player opens it, the icon has done its job and goes with it.
 if(trayHidden&&!game){trayHidden=false;destroyTray();}
 if(window.isMinimized())window.restore();
 window.show();window.focus();
}
function ensureTray(){
 if(tray)return true;
 try{
  tray=new Tray(path.join(__dirname,'launcher-icon.png'));
  tray.setToolTip('Easter Co. Launcher');
  // Quit closes the launcher and nothing else. The game it started keeps running,
  // exactly as the launcher quitting behind a game does with exitOnLaunch.
  tray.setContextMenu(Menu.buildFromTemplate([
   {label:'Open launcher',click:()=>showLauncher()},
   {type:'separator'},
   {label:'Quit',click:()=>app.quit()}
  ]));
  tray.on('click',()=>showLauncher());
  return true;
 }catch{try{tray?.destroy();}catch{}tray=null;return false;}
}
// Whether a tray icon would actually reach a panel. Electron creates the Tray object
// even where nothing will ever draw it, so on Linux the icon is only taken as real when
// a StatusNotifier host owns the watcher name: KDE, the GNOME appindicator extension and
// the XFCE/Cinnamon panels register it. A bare X server, a headless seat, a compositor
// with no panel, and the XEmbed tray Owen's i3/polybar session uses, do not — there the
// launcher steps aside without an icon and says how to come back. Windows and macOS
// always give the application a tray, so they need no probe. dbus-send is asked once, on
// the session bus, with every failure treated as "no host" rather than assumed.
function trayHostAvailable(){
 if(!app.isPackaged&&process.env.EASTER_TEST_TRAY==='0')return Promise.resolve(false);
 if(!app.isPackaged&&process.env.EASTER_TEST_TRAY==='1')return Promise.resolve(true);
 if(process.platform!=='linux')return Promise.resolve(true);
 if(!process.env.DBUS_SESSION_BUS_ADDRESS)return Promise.resolve(false);
 return new Promise(resolve=>{
  execFile('dbus-send',['--session','--print-reply','--dest=org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.NameHasOwner','string:org.kde.StatusNotifierWatcher'],{timeout:2000},(error,stdout)=>{
   resolve(!error&&/\btrue\b/.test(String(stdout)));
  });
 });
}
// The one place the launch-time preference is carried out. The decision itself is in
// security.cjs; this only does what it says. The launcher always steps aside when the
// setting is on: with a tray icon it offers Open launcher and Quit, and where no icon can
// be drawn it says, in one sentence, that starting the launcher again is the way back —
// which is the second-instance handler below, so the window is never lost.
async function leaveTheWay(){
 const planned=launchBehaviour(settings,{trayAvailable:true});
 if(planned.action==='quit'){if(game)app.quit();return;}
 if(planned.action!=='tray')return;
 const available=await trayHostAvailable();
 // The probe is not instant: if the game ended while the desktop was being asked, there
 // is nothing left to step aside for, and no icon is left behind.
 if(!game)return;
 const decision=launchBehaviour(settings,{trayAvailable:available&&ensureTray()});
 trayHidden=true;
 if(decision.message)notify({message:decision.message,error:decision.message});
 if(window&&!window.isDestroyed())window.hide();
}
// The game has ended, or never started: the launcher comes back and the tray goes away.
function returnToLauncher(){
 destroyTray();
 if(!trayHidden)return;
 trayHidden=false;
 showLauncher();
}
// ---- The game, and the launcher that may no longer own it --------------------------------
//
// Owen's design (2026-10-23): "the launcher can update while a game is open, in the background
// and resume — that was a big part of my design." Three things make that true, and this is all
// of them:
//
//   * the client is spawned detached with no inherited pipes (desktop/install.cjs
//     `execOptions`), so this launcher's own exit neither kills the game nor leaves a pipe
//     behind that someone would have to keep servicing;
//   * its identity is written down the moment it starts — pid plus the start time the operating
//     system reports for that pid — so a restarted launcher can tell Minecraft apart from an
//     unrelated process that later reused the number (desktop/game-marker.cjs);
//   * and this launcher reads that record at startup, so an instance that did not start the game
//     still publishes the in-game state instead of offering Play.
const ADOPTED_WATCH_MS=process.platform==='linux'?2000:5000;
async function rememberRunningGame(pid){
 try{return await gameMarker.remember(configRoot(),pid);}catch{return null;}
}
function stopWatchingAdoptedGame(){
 if(adoptedWatch){clearInterval(adoptedWatch);adoptedWatch=null;}
}
function forgetRunningGame(){
 stopWatchingAdoptedGame();
 adoptedGame=null;
 try{gameMarker.forget(configRoot());}catch{}
}
// An adopted game is published as `game`, so every gate that asks "is Minecraft running?" keeps
// the answer it always got, but there is no child process on this side of the relaunch: nothing
// to read, no pipe to service, and nothing this launcher may kill.
function adoptedChild(record){return {pid:record.pid,adopted:true,stdout:null,stderr:null,on(){return this;},once(){return this;},removeListener(){return this;}};}
// Asked before the first broadcast, so no frame can offer Play for a game that is still running.
// A marker that no longer matches its process is a game that has ended: it is removed and this
// launcher starts in its ordinary state, never on a dead screen.
async function adoptRunningGame(){
 let adopted=null;
 try{adopted=await gameMarker.adopt(configRoot());}catch{adopted=null;}
 if(!adopted)return null;
 adoptedGame=adopted.game;
 game=adoptedChild(adopted.game);
 watchAdoptedGame();
 return adopted.game;
}
// The game outlived the process that spawned it, so this launcher watches the process instead of
// a pipe: one liveness question every two seconds (one /proc read on Linux; five seconds
// elsewhere, where the answer costs a spawned probe). The timer is unref'd, so a watched game is
// never the reason this process stays alive.
function watchAdoptedGame(){
 if(adoptedWatch||!adoptedGame)return adoptedWatch;
 adoptedWatch=setInterval(()=>{
  const watched=adoptedGame;
  if(!watched)return;
  void gameMarker.stillRunning(watched).then(alive=>{
   // A newer game may have replaced the one this tick was asked about: only the record this
   // launcher is still watching may end the game state.
   if(alive||adoptedGame!==watched)return;
   forgetRunningGame();
   game=null;
   returnToLauncher();
   // The exit code belongs to a process this launcher did not parent, so none is invented: the
   // sentence is the one a clean exit has always had.
   settle(GAME_CLOSED);
  }).catch(()=>{});
 },ADOPTED_WATCH_MS);
 adoptedWatch.unref?.();
 return adoptedWatch;
}
// ---- Exit Game, Owen's backup force-quit ------------------------------------------------
//
// Owen named the control and said what it must do: **"Exit Game"**, and "backup force quit the
// client immediately". So the client is asked once, politely, and given `GAME_EXIT_GRACE_MS` to
// go; whatever is left of it after that bound is killed outright. The player has already asked,
// so nothing here confirms, nothing waits on a dialog and nothing asks a second time.
//
// **It never touches the account service.** This is local process control and nothing else: no
// token, no mint, no status read, no client check. A player whose account service is unreachable
// can still close the client they cannot otherwise get rid of, and that is a property of this
// path by design rather than by accident of where it sits — tests/desktop/exit-game.electron.mjs
// presses it with every account request failing.
//
// **Two shapes of game, one control.** A game this launcher started has a child handle. A game
// this launcher ADOPTED after its own update has only the pid in `running-game.json` and no
// handle to `kill()` at all — the case a naive `game.kill()` misses — so that branch signals the
// pid through the operating system, and re-proves the pid with the recorded start marker before
// it signals anything: a pid is not an identity, and this path must never kill a stranger.
//
// **A stale marker is answered honestly, never with a dead button.** If the process the marker
// names is already gone, this publishes the ordinary launcher state with the sentence a closed
// game has always had: the press learns what happened instead of pressing a control that does
// nothing. If the client somehow outlives even a hard kill, the in-game state is left standing,
// because it is still the truth and a second press is still a real option; no sentence is
// invented to explain a kill that did not land.
const GAME_EXIT_GRACE_MS=1500;    // how long a politely asked client is given to close
const GAME_EXIT_KILL_MS=1000;     // how long a hard-killed client is given to be gone
const GAME_EXIT_POLL_MS=100;      // how often a process that was asked to go is looked for
let gameExitRequested=false,gameExitRun=null;
// One signal, two ways of sending it: a child handle for a game this launcher started, the pid
// for one it adopted. Windows has no graceful signal — there `SIGTERM` is already a termination —
// so the grace phase on Windows is the hard kill, which is the same instruction Owen gave.
function signalGame(child,pid,signal){
 if(child){try{return child.kill(signal);}catch{return false;}}
 try{process.kill(pid,signal);return true;}catch{return false;}
}
async function gameGone(record){
 try{return !(await gameMarker.stillRunning(record));}catch{return false;}
}
async function waitForGameGone(record,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  if(await gameGone(record))return true;
  const left=deadline-Date.now();
  if(left<=0)return false;
  await new Promise(resolve=>setTimeout(resolve,Math.min(GAME_EXIT_POLL_MS,left)));
 }
}
// The child's own 'exit' is what Node reports; `game` is cleared by the exit handler. Both are
// asked, so an exit nobody's handler has run for yet is still an exit. A child that reports
// neither (nothing here is a real process) is never taken as gone: an absent answer is not an exit.
function childGone(child){return child.exitCode!=null||child.signalCode!=null||game!==child;}
async function waitForChildGone(child,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  if(childGone(child))return true;
  const left=deadline-Date.now();
  if(left<=0)return false;
  await new Promise(resolve=>setTimeout(resolve,Math.min(GAME_EXIT_POLL_MS,left)));
 }
}
// The one Exit Game path. It answers `{exited:true}` when the client is gone, and `{exited:false}`
// with a reason when there was nothing to end (`none`, `gone`) or when the client outlived even the
// hard kill (`alive`). One press at a time: a second press while the first is running joins it.
async function exitGame(){
 if(gameExitRun)return gameExitRun;
 const run=performGameExit();
 gameExitRun=run;
 try{return await run;}finally{gameExitRun=null;}
}
async function performGameExit(){
 // ---- A game this launcher adopted: only the marker's pid, and no handle to kill -------------
 if(adoptedGame){
  const record=adoptedGame;
  // The launcher's own watch would settle this game too, and two settlers of one ending are one
  // too many: this press owns the sentence from here.
  stopWatchingAdoptedGame();
  if(!(await gameMarker.stillRunning(record))){
   forgetRunningGame();game=null;returnToLauncher();settle(GAME_CLOSED);
   return {exited:false,reason:'gone'};
  }
  signalGame(null,record.pid,'SIGTERM');
  let gone=await waitForGameGone(record,GAME_EXIT_GRACE_MS);
  if(!gone){
   signalGame(null,record.pid,'SIGKILL');
   gone=await waitForGameGone(record,GAME_EXIT_KILL_MS);
  }
  if(!gone){
   // It is still playing, so the in-game state is still the truth: the marker and the state stay
   // exactly as they were, and the watch resumes so the ordinary ending is still noticed.
   watchAdoptedGame();
   return {exited:false,reason:'alive'};
  }
  forgetRunningGame();game=null;returnToLauncher();settle(GAME_CLOSED);
  return {exited:true};
 }
 // ---- A game this launcher started: there is a child handle, so its own exit is the proof ----
 if(game){
  const child=game;
  // The exit handler publishes `GAME_CLOSED` for this ending rather than inventing an exit code
  // for a process the player asked to end, so the flag tells it who is settling.
  gameExitRequested=true;
  try{
   signalGame(child,null,'SIGTERM');
   if(!(await waitForChildGone(child,GAME_EXIT_GRACE_MS))){
    signalGame(child,null,'SIGKILL');
    if(!(await waitForChildGone(child,GAME_EXIT_KILL_MS)))return {exited:false,reason:'alive'};
   }
  }finally{
   // A client still playing is owed its ordinary ending after this press gives up, so the flag is
   // only ever cleared here for a child that is not gone: a gone one has run (or is about to run)
   // its own exit handler, and clearing the flag for it would take its last settle away.
   if(!childGone(child))gameExitRequested=false;
  }
  // The exit handler has already returned the UI and destroyed the tray; these are idempotent and
  // keep the settle below true even if it has not run yet when the process really is gone.
  forgetRunningGame();game=null;returnToLauncher();settle(GAME_CLOSED);
  return {exited:true};
 }
 return {exited:false,reason:'none'};
}
// Play and the game shortcut reach this one function. The wake a Play press may start
// belongs to that press, so it is cancelled if the press does not end in a launch:
// nothing is left polling behind a sign-in the player has to redo.
async function play(){
 try{return await launchThrough();}
 finally{if(gameWake&&!gameWake.settled&&gameWake.controller)gameWake.controller.abort();}
}
// This press's own Microsoft session, re-checked exactly as it always was: the refresh, the
// Java access check and the re-post of the Mojang token. Returns `{session}` when the launch
// can go ahead with this machine's session, `{settled:true}` when the press has already been
// settled with its own sentence, and null when this machine's copy could not be renewed at all
// — which is not a dead end any more, because the account service may hold one instead.
async function localLaunchSession(){
 try{session=await withActivity('java-checking',update=>auth.refresh(session,undefined,true,false,update));}
 catch(error){
  if(error?.name==='AbortError')throw error;
  if(!['invalid_grant','invalid_request','unauthorized_client','expired_token'].includes(error.code))throw error;
  session=null;await saveSession();return null;
 }
 await saveSession();
 if(identity.access(session)!=='owned'||!session.profile){
  settle('Minecraft Java Edition access is required to play.');return {settled:true};
 }
 // The Mojang token is the enrolment credential: every sign-in re-posts it, so a
 // session the API has forgotten or revoked is reissued here instead of on launch.
 await enrolAccount({announce:false,throwOnError:true});
 if(!companyReady()){settle('Create your Easter Company password to finish setup.');return {settled:true};}
 return {session};
}
// One Play press, three ways a session can come, in the contract's order
// (doc/launcher-states.md, "One Play press, three ways a session can come").
async function launchSession(){
 if(localRefreshable()){
  const local=await localLaunchSession();
  if(local)return local;
 }
 // The day after a hand-over: the access token this machine already holds is still good, so it
 // is used as it is, with no refresh and no re-post.
 if(localTokenLive())return {session};
 const minted=await mintMinecraftSession({announce:true});
 // The account this press was making a session for is gone: the player signed out or signed in
 // as somebody else while the service was being asked. There is no honest sentence to settle the
 // press with — the hero now belongs to another account and says its own state — so the press
 // simply stops, exactly as it would if it had never been able to start.
 if(minted?.outcome==='stale')return {settled:true};
 if(minted?.outcome==='server')return {session:sessionFromMint(minted.session)};
 if(minted?.outcome==='reauth'){
  // One honest sentence, then the interactive flow — once. If the fresh sign-in does not end
  // in a session this press stops there: a second prompt for the same press would be a loop.
  settle(ACCOUNT_MESSAGES.reauth_required,{device:null});
  await interactiveMicrosoft({link:true,reason:ACCOUNT_MESSAGES.reauth_required});
  if(!companyReady()){settle('Create your Easter Company password to finish setup.');return {settled:true};}
  if(identity.access(session)!=='owned'||!session.profile){settle('Minecraft Java Edition access is required to play.');return {settled:true};}
  return {session};
 }
 if(minted?.outcome==='account'){
  // The Easter Company session is not live any more. That is the account's own news, and the
  // account's own sentence: signing in to Microsoft would not fix it.
  settle(ACCOUNT_MESSAGES.invalid_session,{device:null,error:ACCOUNT_MESSAGES.invalid_session});
  return {settled:true};
 }
 if(minted?.outcome==='busy'){
  // The service is rate-limiting mints or cannot make one at all. The player's stored session is
  // fine, so there is nothing to approve and nothing to sign in to: Play stays off for this press
  // and the sentence says what the launcher can actually see.
  const sentence=String(minted.error?.message||ACCOUNT_MESSAGES.rate_limited);
  settle(sentence,{device:null,error:sentence});
  return {settled:true};
 }
 // No session is available on this machine or from the account service. Today's sentence,
 // unchanged, and the press stops here rather than guessing.
 settle('Sign in with the Microsoft account linked to '+(company.account.username||'your Easter Company account')+'.');
 return {requiresMicrosoft:true};
}
async function launchThrough(){
 if(!companyReady()){settle(company?'Create your Easter Company password to finish setup.':'Sign in to your Easter Company account first.');return {requiresAccount:true};}
 // A genuinely unlinked account is a different fact from a linked one this machine cannot make
 // a session for, and it says so rather than asking for a sign-in that could not link anything.
 if(!company.account.microsoftSubject){
  settle('Link the Microsoft account you play Minecraft with to '+(company.account.username||'your Easter Company account')+'.');
  return {requiresMicrosoft:true};
 }
 // The client and the server are prepared before the session is, exactly as they were before
 // this section existed: a press that has to wait for a cold start waits for it while the
 // account work runs, and a press that cannot launch never wakes anything it will not join.
 const prepared=await ensureClient();
 const waiting=beginGameWake();
 notify({phase:'launching',message:'Checking your Minecraft session…',device:null,progress:null});
 const obtained=await launchSession();
 if(!obtained?.session)return obtained;
 const sessionForLaunch=obtained.session;
 const record=client.record;
 const version=prepared?.version||record?.version;
 const javaPath=settings.javaPath||prepared?.javaPath||record?.java;
 if(!version||!javaPath)throw Error('The game client is not installed yet.');
 if(!settings.includeGraphics)await disableShaders(gameRoot());
 await configureVisuals(gameRoot(),{record,includeGraphics:Boolean(settings.includeGraphics)});
 // Everything the account and the client needed is ready; the server is the only thing
 // left. The cold start began when Play was pressed, so this normally finds it already
 // running — but if it is still coming up, the state says so in its own phase and its
 // own sentence, and the launch follows the moment it answers ready. The player is never
 // asked to press Play a second time, and `starting-game` is never an account state.
 if(!waiting.settled)notify({phase:'starting-game',message:gameState().message,progress:null});
 await waiting.promise;
 notify({phase:'launching',message:'Starting Minecraft…',progress:null});
 const child=await launch(launchOptions({root:gameRoot(),version,javaPath,session:sessionForLaunch,settings,launchEnv:launchEnvironment()}));
 game=child;
 // Do not store launch arguments or raw stdout; Minecraft writes its own latest.log.
 child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
 // The handlers go on first, so a client that dies while its identity is still being written is
 // seen: an 'exit' nobody was listening for would leave `game` set and Play refused forever.
 child.once('error',()=>{game=null;forgetRunningGame();returnToLauncher();const message='Minecraft could not start. Check Java and try again.';settle(message,{error:message});});
 // An Exit Game press has already published this ending, and a signalled exit has no code at all:
 // saying "code null" would be the launcher's own words for something the player asked for. So the
 // press settles it, and no exit code is invented for either.
 child.once('exit',(code,signal)=>{const requested=gameExitRequested;gameExitRequested=false;game=null;forgetRunningGame();returnToLauncher();if(requested)return;const message=code===0?GAME_CLOSED:'Minecraft closed with code '+code+'. Its log is in the client folder.';settle(message,{error:code===0?null:message});});
 // The game is written down before anything can restart the launcher: its pid and the start
 // time the operating system reports for that pid (desktop/game-marker.cjs). The client is
 // spawned detached with no inherited pipes, so this record is the only thing that carries the
 // game across a launcher update — and its start marker is what stops a recycled pid from being
 // mistaken for Minecraft later. Nothing can relaunch in the meantime: an apply is refused for
 // as long as this press is in flight (`launchPresses`), and the press ends after this line.
 await rememberRunningGame(child.pid);
 notify({phase:'running',message:GAME_RUNNING,progress:null});
 // Owen's setting: the launcher is a doorway, so it closes behind the game it started.
 if(settings.exitOnLaunch===true)setTimeout(()=>{ if(game){ app.quit(); } },800);
 // The linked alternative: it steps into the system tray instead of closing, and comes
 // back when the game ends. Never both — cleanSettings has already resolved the pair.
 else if(settings.trayOnLaunch===true)setTimeout(()=>{ if(game)void leaveTheWay(); },800);
}
// ---- Game shortcuts ---------------------------------------------------------
// Owen's ask, and his own correction to it: a shortcut for the game that starts the
// LAUNCHER and lets the launcher start the game, because a shortcut that ran Minecraft
// itself would skip the mandatory updater. So both entries this launcher writes run the
// launcher binary with one explicit argument, and everything below is about where those
// two files live and what happens when one is clicked.
//
// An AppImage runs from a temporary mount, so the running binary is not a path the
// desktop could launch later; APPIMAGE is the file the player actually has.
function shortcutExecutable(){return process.env.APPIMAGE||process.execPath;}
function shortcutOptions(){
 return {platform:process.platform,home:os.homedir(),env:process.env,executable:shortcutExecutable(),
  // Windows keeps its desktop and Start menu folders somewhere only the shell knows.
  desktopDir:process.platform==='win32'?app.getPath('desktop'):null,
  desktop:settings?.desktopShortcut===true,startMenu:settings?.startMenuShortcut===true,
  icon:{source:path.join(__dirname,'launcher-icon.png'),target:path.join(configRoot(),ICON_FILE)},
  writeShortcutLink:(...args)=>shell.writeShortcutLink(...args)};
}
async function refreshShortcuts(){
 try{shortcutState=await readGameShortcuts(shortcutOptions());}
 catch{shortcutState={available:false,reason:'The game shortcuts could not be read on this computer.',desktop:{id:'desktop',wanted:false,exists:false},startMenu:{id:'startMenu',wanted:false,exists:false}};}
 return shortcutState;
}
// Only the contract's own shape is ever published: what a save reports about its own
// successes and failures stays in this process.
function publishedShortcuts(report,message){
 return {available:report.available,reason:report.reason,message:message||null,desktop:report.desktop,startMenu:report.startMenu};
}
// A settings save creates and removes both entries. Each one is independent, and a file
// this computer will not let the launcher write is reported plainly and the preference is
// turned back off, so the saved setting and the file on disk never disagree.
async function saveShortcuts(){
 const before=JSON.stringify(shortcutState);
 const report=await applyGameShortcuts(shortcutOptions());
 const failed=(report.failures||[])[0];
 if(failed){
  // The entry could not be written, so its own preference goes back off: the saved setting
  // and the file on disk never disagree, and the sentence the dialog shows is carried in
  // the shortcut state rather than hidden in a failed request.
  settings={...settings,[failed.setting]:false};
  await atomicJSON(settingsFile(),settings);
 }
 const next=publishedShortcuts(await readGameShortcuts(shortcutOptions()),failed?failed.message:null);
 shortcutState=next;
 // A save that changed neither entry publishes nothing: the dialog already has the answer
 // it asked for, and a broadcast for an unchanged state would only disturb the view.
 if(JSON.stringify(next)!==before)notify({});
 return failed?failed.message:null;
}
// ---- The one way a game starts -------------------------------------------------
// Play and the game shortcut are the same path, so the shortcut cannot start a game the
// Play button would not offer, cannot skip the launcher update and cannot mean something
// different for the launch-behaviour settings.
async function startGame(){
 launchPresses+=1;
 try{
  if(backgroundUpdate)await backgroundUpdate.catch(()=>{});
  if(game||working||controller)throw Error('Wait for the current operation to finish.');
  if(app.isPackaged)await checkLauncherUpdate();
  if(!startupReady)throw Error('Update the launcher before playing.');
  return await exclusively(play);
 }finally{
  launchPresses-=1;
  // The press has settled one way or the other, so a staged update that was waiting for it may
  // go now — including the case where the press started a game, which a launcher update is
  // allowed to run behind.
  retryStagedUpdateApply();
 }
}
// A shortcut launch waits for the mandatory update gate rather than racing it, and then
// asks the one decision in shortcuts.cjs. A launch that may not start a game does nothing
// at all beyond the window it has already opened: the normal state says what needs
// attention, so no second, vaguer sentence is printed at the player.
async function startupSettled(){
 const deadline=Date.now()+300000;
 while(startupPromise&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,120));
 return startupReady;
}
let autoStarting=false;
async function autoStart(){
 if(autoStarting)return null;
 autoStarting=true;
 try{
  await startupSettled();
  if(backgroundUpdate)await backgroundUpdate.catch(()=>{});
  const decision=autoStartDecision({startupReady,installed:Boolean(client.installed),running:Boolean(game),busy:Boolean(working||controller||accountWorking||accessChecking),updating:Boolean(backgroundUpdate),actions:remainingActions(),canPlay:canPlayNow()});
  if(!decision.start)return decision;
  await startGame();
  return decision;
 }catch(error){
  // The play path has already settled a safe message for anything that failed, exactly as
  // it does when the player presses Play.
  return {start:false,reason:'failed',error:safeError(error)};
 }finally{autoStarting=false;}
}
// What may answer while the mandatory-update gate is still closed. Three kinds and no
// more: the read that reports on the gate (`status`), the four commands that resolve or
// pause it, and the home screen's own editorial read (`home-content`).
//
// That last one belongs here because it protects nothing the gate protects. The document
// is public, read-only, downloaded rather than applied, and already being read by the warm
// call at whenReady; its bounds are 8 s and 64 KiB in desktop/discovery.cjs, and nothing it
// returns can install, play or sign in. Holding it behind the gate is how a returning
// player, whose installed client is being verified on that launch, was told
// "News unavailable" over a document that was in hand the whole time: the gate threw the
// warm answer away and the cards had already spent their one retry (measured on 1.0.36,
// 1.0.37 and 1.0.38; doc/launcher-discovery.md, "The startup gate").
const REACHABLE_BEFORE_STARTUP=Object.freeze(['status','retry-updates','pause-install','resume-install','cancel-install','home-content']);
function registerIPC(){
 const handle=(name,fn)=>ipcMain.handle('launcher:'+name,async(event,...args)=>{
  if(!trustedFrame(event))throw Error('Untrusted launcher request.');
  try{
   if(!startupReady&&!REACHABLE_BEFORE_STARTUP.includes(name))throw Error('Updates must finish before this launcher can be used.');
   return {ok:true,value:await fn(...args)};
  }catch(error){return {ok:false,error:safeError(error),code:['invalid_grant','invalid_session','invalid_microsoft_token','identity_conflict','reauthentication_required','password_policy','username_taken','username_policy','rate_limited'].includes(error.code)?error.code:undefined};}
 });
 handle('status',async()=>{
  // Settings asks this whenever it opens, and the answer carries the two shortcut
  // entries as they are on this computer right now rather than as last saved.
  await refreshShortcuts();
  return {...state,shortcuts:shortcutState,profile:launchProfile(),account:publicAccount(company),minecraftSession:publishedMinecraftSession(),sessionCached:sessionCacheShowing(),minecraftHead:headState(),sessionExpiresAt:company?.expiresAt||null,settings,totalMemoryMB:Math.floor(os.totalmem()/1024/1024),version:APP_VERSION,hardware:hardwareState(),graphics:graphicsState(),game:gameState(),launcherUpdate,authName:clientId===DEFAULT_CLIENT_ID?'Prism Launcher':'Easter Company'};
 });
 handle('sign-in',async(options={})=>{
  if(controller||accountWorking)throw Error('Account sign-in is already running.');
  // Authentication can overlap the install pipeline, but never starts a second
  // pipeline or clears its progress when authentication fails or is cancelled.
  if(control){
   try{return await login({link:options?.link===true});}
   catch(error){const message=safeError(error);notify({message,error:error.name==='AbortError'?null:message,device:null});throw error;}
  }
  return exclusively(()=>login({link:options?.link===true}));
 });
 // The home screen's editorial content. It answers with the validated document or with a
 // refusal, and the renderer shows its own unavailable state; nothing here is stored, and
 // no URL, token or identifier from it is ever asked for by the renderer.
 handle('home-content',()=>discovery.content());
 handle('account-providers',()=>withActivity('account-working',()=>accounts.providers(),{replace:false,scope:'surface'}));
 handle('provider-sign-in',(provider,link=false)=>accountOperation(async(update)=>{
  if(company&&!link)throw Error('Sign out before signing in to a different account.');
  const abort=new AbortController();controller=abort;
  try{
   const signed=await providerSignIn(accounts,provider,{token:link?company?.token:undefined,signal:abort.signal,openExternal:url=>shell.openExternal(url),onWait:update});
   const next=companySession(signed);
   if(link&&company&&next.account.id!==company.account.id){
    // A linked provider that names another account is an identity conflict, and the answer the
    // cache holds is about the account that is still signed in: it goes (ticket 19e51885).
    forgetSessionCache();
    throw new AccountError('identity_conflict',ACCOUNT_MESSAGES.identity_conflict);
   }
   const previous=company;company=next;
   if(!previous||previous.account.id!==next.account.id)cancelMints();
   session=savedAccounts.find(entry=>entry.companyId===next.account.id&&entry.companySubject===next.account.microsoftSubject)||null;
   await saveSession();await saveCompany();
   if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
   notify({message:signed.created?'Account created. Choose your username and password.':'Provider connected.'});
   // A provider sign-in can be the moment a stored Microsoft session becomes reachable, so the
   // hero learns whether Play is available without waiting for a press. It is asked for AFTER
   // this sign-in has settled, so a slow account service can never hold the sign-in open or
   // leave its busy state behind: the account is already written and published by then.
   setImmediate(()=>{void probeMinecraftSession();});
   return publicAccount(company);
  }finally{if(controller===abort)controller=null;}
 }));
 handle('profile-update',(displayName)=>accountOperation(async(update)=>{
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  company.account=await accounts.updateProfile(company.token,{displayName},update);await saveCompany();notify({});return publicAccount(company);
 }));
 handle('profile-picture',(remove=false)=>accountOperation(async(update)=>{
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  let picture=null;
  if(!remove){
   const chosen=await dialog.showOpenDialog(window,{title:'Choose profile picture',properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]});
   if(chosen.canceled)return {cancelled:true};
   const file=chosen.filePaths[0],info=await fs.stat(file);
   if(info.size>5*1024*1024)throw Error('Choose an image smaller than 5 MB.');
   let image=nativeImage.createFromBuffer(await fs.readFile(file));
   if(image.isEmpty())throw Error('This picture could not be opened.');
   const size=image.getSize(),edge=Math.min(size.width,size.height);
   image=image.crop({x:Math.floor((size.width-edge)/2),y:Math.floor((size.height-edge)/2),width:edge,height:edge}).resize({width:256,height:256});
   picture='data:image/png;base64,'+image.toPNG().toString('base64');
  }
  company.account=await accounts.updateProfile(company.token,{picture},update);await saveCompany();notify({});return publicAccount(company);
 }));
 handle('continue-microsoft',()=>accountOperation(async()=>{
  if(!session)throw Error('Sign in with Microsoft to continue.');
  await enrolAccount({throwOnError:true});
  notify({message:'Signed in to your Easter Company account.'});
 }));
 // Direct Company login. The identifier is the Easter Company username or the email the
 // account was created with; neither a Company ID nor anything else is accepted here.
 handle('company-login',(identifier,password)=>accountOperation(async(update)=>{
  if(company)throw Error('Sign out before signing in to a different account.');
  const login=typeof identifier==='string'?identifier.trim():'';
  if(!login||login.length>254||typeof password!=='string'||password.length>128)throw Error('Enter your username or email and your password.');
  const signed=await accounts.loginPassword(login,password,undefined,update);
  const next=companySession(signed),previous=company;
  company=next;
  cancelMints();
  session=savedAccounts.find(entry=>entry.companyId===next.account.id&&entry.companySubject===next.account.microsoftSubject)||null;
  await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  notify({message:'Signed in to '+(next.account.username||'your Easter Company account')+'.'});
  // A password sign-in never has a Microsoft refresh token of its own, so the account service is
  // the only place a session can come from. One mint tells the hero whether Play is available
  // before the player presses anything, and leaves today's behaviour in place when the service
  // holds nothing for this account. Asked for AFTER this sign-in has settled, for the same
  // reason as above: the sign-in's own busy state belongs to the sign-in, not to the mint.
  setImmediate(()=>{void probeMinecraftSession();});
  return publicAccount(company);
 }));
 // "Sign out of Minecraft everywhere": the one stored session every machine mints from, ended by
 // the player who owns it. The three answers are the contract's own, and each one is said as it
 // is — the launcher never claims a machine was signed out on evidence it does not have.
 async function revokeMinecraftEverywhere(){
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  let answer;
  try{answer=await accounts.revokeGameSession(company.token);}
  catch(error){
   // A service with no such route revoked nothing, and saying anything else would be a claim
   // about other machines that this launcher cannot see.
   if(error?.code==='route_absent')return {revoked:false,message:MINECRAFT_NOT_REVOCABLE};
   throw error;
  }
  if(!answer?.revoked){
   // The service's own honest "there was nothing stored": nothing was signed out on any machine,
   // because there was nothing to sign out.
   minecraft={...minecraft,serverHeld:false,checkedAt:new Date().toISOString()};
   notify({message:MINECRAFT_NOTHING_STORED});
   return {revoked:false,message:MINECRAFT_NOTHING_STORED};
  }
  // The stored session is gone, so nothing can be minted until the player signs in with
  // Microsoft again: that is what the next press will ask for, and the state says so now.
  mintedSession=null;
  minecraft={state:'reauth',serverHeld:false,checkedAt:new Date().toISOString()};
  notify({message:MINECRAFT_REVOKED});
  return {revoked:true,message:MINECRAFT_REVOKED};
 }
 handle('sign-out-minecraft',()=>accountOperation(revokeMinecraftEverywhere));
 // The hero's own retry for a launcher that could not make a session just now (the service was
 // rate-limiting mints or could not answer). It is a read: one mint, no launch, and the state it
 // leaves is the truth about whether Play can be offered.
 handle('minecraft-session',()=>withActivity('account-working',()=>probeMinecraftSession()??Promise.resolve(minecraftStateField()),{replace:false}));
 // One boolean and one reason code, asked before the password step so the player learns a
 // A username is one canonical value: lowercase, surrounding whitespace dropped. Capitals
// are folded here rather than refused, because typing them is a habit and the account
// service stores the lowercase form anyway. Everything else is left to the pattern, so a
// name that really is illegal is still refused with its own sentence.
function foldUsername(value){
  return typeof value==='string'?value.trim().toLowerCase():'';
}
// username is taken before typing a password. No account data and no email come back.
 handle('company-username-check',async username=>{
  // Capitals are folded, never refused: a username is stored and matched in lowercase,
  // and typing Owen is a keyboard habit rather than a mistake worth an error.
  const folded=foldUsername(username);
  if(!folded||!USERNAME_PATTERN.test(folded))return {available:false,reason:'username_policy',message:ACCOUNT_MESSAGES.username_policy};
  // The username step owns this wait: the dialog it was typed into says "Checking your
  // username…" while it runs, so the hero stays quiet (doc/launcher-states.md, `scope`).
  const found=await withActivity('account-working',()=>accounts.usernameAvailable(folded),{replace:false,scope:'surface'});
  return found.available?{available:true,reason:null,message:null}:{available:false,reason:found.reason||'username_taken',message:ACCOUNT_MESSAGES[found.reason]||ACCOUNT_MESSAGES.username_taken};
 });
 // The username is claimed with the first password and never travels again.
 handle('company-password',(password,replace=false,username)=>accountOperation(async(update)=>{
  if(!company)throw Error('Sign in with a provider first.');
  if(typeof password!=='string'||[...password].length<8||[...password].length>128)throw Error('Use a password or passphrase of 8 to 128 characters.');
  let claim=null;
  if(username!==undefined&&username!==null&&username!==''){
   if(company.account.username)throw Error('Your Easter Company username cannot be changed.');
   const folded=foldUsername(username);
   if(!folded||!USERNAME_PATTERN.test(folded))throw Error(ACCOUNT_MESSAGES.username_policy);
   claim=folded;
  }
  if(!company.account.username&&!claim)throw Error('Choose your Easter Company username first.');
  const signed=await accounts.setPassword(company.token,password,replace===true,claim,update);
  company=companySession(signed);await saveCompany();notify({message:signed.created?'Your Easter Company username and password are saved.':'Your Easter Company password is saved.'});
  return publicAccount(company);
 }));
 // ---- Verified emails ---------------------------------------------------------
 // The one place an address is read, and the one place an address is chosen. Both are
 // owner-only: the session comes from this process, the renderer names no account, and
 // nothing here is broadcast, stored, logged or carried in an error message. The profile
 // section asks for the list when it opens, so a choice survives a restart by being read
 // back from the account service rather than by being cached in the vault.
 // A session the service has refused is forgotten here, without a logout call it could
 // not honour anyway, and the renderer is told as it is on the next broadcast.
 //
 // Everything this launcher knew about that account's Minecraft session goes with it: a minted
 // session whose account has just been refused is not this launcher's to offer the next player,
 // and the state word returns to the unasked one so nothing is claimed about a session nobody
 // has. The hero then has no account to ask Microsoft about, which is the whole point: a dead
 // Easter Company session is answered with the account's own sign-in.
 async function sessionLost(error){
  if(error?.code!=='invalid_session'||!company)return;
  await forgetRefusedCompany();
 }
 async function verifiedEmails(){
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  try{return await accounts.emails(company.token);}
  catch(error){await sessionLost(error);throw error;}
 }
 async function selectLoginEmail(email,onWait){
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  if(email!==null&&typeof email!=='string')throw Error('Choose one of your verified emails.');
  try{
   const listed=await accounts.selectLoginEmail(company.token,email,undefined,onWait);
   // The sentence names what changed and nothing else: no address appears in a message,
   // in the page notice or in any state a view other than the profile renders.
   //
   // One event, one sentence. Clearing the login email is one action and it used to read two
   // ways: this notice named Microsoft, while the verified-emails dialog the player clicked in
   // (site/company-auth.mjs, saveLoginEmail) said "a linked provider". Both are shown for the
   // same click - the dialog line at once, this notice on close, when the held page notice is
   // released (doc/launcher-states.md, *One failure, one visible home*) - so a player could
   // read both wordings for one action. The renderer's wording is the true one for the same
   // reason the signed-out hero stopped naming Microsoft (5c9c853): the chooser the cleared
   // email leads back to offers Microsoft, Google, Steam and Discord. This string and the
   // renderer's must stay identical; there is no shared module across the process boundary
   // (main is CommonJS, site/ is browser ESM), so the contract records the decided sentence
   // and both files carry it.
   notify({message:email===null?'Your login email is cleared. Sign in with a linked provider or with your username.':'Your login email is saved.'});
   return listed;
  }
  catch(error){await sessionLost(error);throw error;}
 }
 handle('profile-emails',()=>withActivity('account-working',verifiedEmails,{replace:false,scope:'surface'}));
 handle('login-email',email=>withActivity('account-working',update=>selectLoginEmail(email,update),{replace:false,scope:'surface'}));
 handle('open-minecraft-store',()=>shell.openExternal('https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc'));
 handle('open-minecraft-profile',()=>shell.openExternal('https://www.minecraft.net/en-us/msaprofile'));
 handle('recheck-access',async()=>{
  if(!session)throw Error('Sign in with Microsoft first.');
  if(controller||accountWorking||game||(working&&!control))throw Error('Wait for the current operation to finish.');
  const run=async()=>{
   accessChecking=true;controller=new AbortController();const activity=beginActivity('java-checking');notify({message:'Checking Minecraft Java access…'});
   try{
    const refreshed=await auth.refresh(session,controller.signal,true,false,activity.update);
    session=refreshed;
    await loadSkin(session);await saveSession();await enrolAccount({announce:false,onStage:activity.update});
    notify({message:'Minecraft Java access checked.'});
   }catch(error){session={...session,minecraftAccess:'unknown'};notify({});throw error;}
   finally{activity.end();accessChecking=false;controller=undefined;notify({});}
  };
  return control?run():exclusively(run);
 });
 handle('cancel-sign-in',()=>controller?.abort());
 handle('sign-out',async()=>{if(working||controller||accountWorking)throw Error('Wait for the current operation to finish.');const id=identity.id(session);session=null;savedAccounts=savedAccounts.filter(entry=>identity.id(entry)!==id);await forgetCompany();await saveSession();notify({remembered:false,device:null,message:'Logged out.'});});
 // Re-issues the account session from the Mojang token the launcher already has.
 handle('account-refresh',()=>exclusively(async()=>{if(!session)throw Error('Sign in first.');await enrolAccount({throwOnError:true});return publicAccount(company);}));
 // Company account only: the Microsoft session on this device is kept.
 handle('account-sign-out',async()=>{if(working||controller||accountWorking)throw Error('Wait for the current operation to finish.');await forgetCompany();notify({message:'Signed out of your Easter Company account.'});});
 // A retry while Minecraft is running is allowed: the launcher updates in the background and the
 // game is not interrupted (Owen, 2026-10-23). The sentence that used to refuse here — "Close
 // Minecraft before updating the launcher." — described a rule the design no longer has, so it is
 // gone rather than reworded; the generic busy guard inside startupUpdates is what still stops a
 // retry landing in the middle of another operation.
 handle('retry-updates',()=>startupUpdates());
 handle('play',()=>startGame());
 // Exit Game. A write, so it is not reachable before the startup gate (REACHABLE_BEFORE_STARTUP is
 // reads and cancellations only), and it takes no lock: it is the panic button, and an operation
 // this launcher happens to be running is not a reason to leave a game nobody can close.
 handle('exit-game',()=>exitGame());
 handle('settings',async input=>{
  if(working||controller)throw Error('Wait for the current operation before changing settings.');
  // A running game already owns its launch configuration. Saved preferences apply
  // on the next launch and do not mutate the running process.
  // The location is never taken from this handler: it comes from the folder
  // picker or the saved setting, nowhere else.
  settings={...cleanSettings(input,Math.floor(os.totalmem()/1024/1024)),location:settings.location,includeGraphics:includeGraphicsValue(input,settings.includeGraphics)};
  // Where the launcher cannot write a shortcut at all, the pair is saved off: the dialog
  // hides the rows and says why, and a settings file never claims an entry that this
  // computer cannot have.
  if(!shortcutSupport({platform:process.platform}).available)settings={...settings,desktopShortcut:false,startMenuShortcut:false};
  await atomicJSON(settingsFile(),settings);
  // The save is what creates and removes the two files, and a file that could not be
  // written turns its own preference back off before the dialog is told.
  await saveShortcuts();
  return settings;
 });
 handle('choose-java',async()=>{const selected=await dialog.showOpenDialog(window,{title:'Choose Java 25 executable',properties:['openFile'],filters:process.platform==='win32'?[{name:'Java',extensions:['exe']}]:[]});return selected.canceled?null:selected.filePaths[0];});
 // The picker is the only source of a new installation folder.
 handle('choose-location',async()=>{
  if(working||game||controller)throw Error(game?'Minecraft is already running.':'Wait for the current operation to finish.');
  const selected=await dialog.showOpenDialog(window,{title:'Choose where to install the game',buttonLabel:'Install here',properties:['openDirectory','createDirectory']});
  if(selected.canceled||!selected.filePaths[0])return null;
  const target=await ensureLocation(selected.filePaths[0],{defaultLocation:defaultLocation(),configRoot:configRoot(),home:os.homedir()});
  settings={...settings,location:target===defaultLocation()?'':target};
  await atomicJSON(settingsFile(),settings);
  await refreshClient();
  notify({message:'The game will be installed in '+target+'.'});
  return {location:target,defaultLocation:defaultLocation()};
 });
 // Switching back to the default needs no picker, and no other path is accepted.
 handle('set-location',async input=>{
  if(working||game||controller)throw Error('Wait for the current operation to finish.');
  const requested=input&&typeof input==='object'?input.location:input;
  const target=await ensureLocation(resolveLocation(requested,{saved:settings.location,defaultLocation:defaultLocation()}),{defaultLocation:defaultLocation(),configRoot:configRoot(),home:os.homedir()});
  settings={...settings,location:target===defaultLocation()?'':target};
  await atomicJSON(settingsFile(),settings);
  await refreshClient();
  notify({message:'The game will be installed in '+target+'.'});
  return {location:target,defaultLocation:defaultLocation()};
 });
 handle('start-install',input=>exclusively(async()=>{
  const options=input&&typeof input==='object'?input:{};
  const target=await ensureLocation(resolveLocation(options.location,{saved:settings.location,defaultLocation:defaultLocation()}),{defaultLocation:defaultLocation(),configRoot:configRoot(),home:os.homedir()});
  settings={...settings,location:target===defaultLocation()?'':target,includeGraphics:'includeGraphics' in options?Boolean(options.includeGraphics):settings.includeGraphics};
  await atomicJSON(settingsFile(),settings);
  await runInstall({includeGraphics:settings.includeGraphics});
  return installInfo();
 }));
 handle('pause-install',async()=>{
  if(!control)throw Error('There is no download to pause.');
  control.pause();
  notify({message:'Download paused. Resume when you are ready.'});
  return {paused:true};
 });
 handle('resume-install',async()=>{
  if(!control||!control.paused)throw Error('Nothing is paused.');
  control.resume();
  notify({message:'Download resumed.'});
  return {paused:false};
 });
 handle('cancel-install',async()=>{
  if(!control)throw Error('There is no download to cancel.');
  control.cancel();
  return {cancelled:true};
 });
 handle('check-updates',()=>exclusively(runUpdate));
 // The enhanced graphics toggle. It takes a boolean and nothing else; the path it
 // writes to is the saved client location, never a renderer-supplied one.
 handle('set-graphics',enabled=>setGraphics(enabled));
 handle('open-folder',async()=>{const root=gameRoot();await fs.mkdir(root,{recursive:true});const error=await shell.openPath(root);if(error)throw Error('Could not open the client folder.');});
 handle('open-microsoft',()=>shell.openExternal('https://www.microsoft.com/link'));
}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'";
async function resource(request){
 try{
  const url=new URL(request.url);
  let file=localFile(request.url,siteRoot);
  if(url.pathname.endsWith('/'))file=path.join(file,'index.html');
  if(/^\/data\/(?:world\.json|client\.json|tiles\/[-\d]+\/[-\d]+\.png)$/.test(url.pathname)){
   try{
    const response=await net.fetch(new URL(url.pathname+url.search,clientOrigin()).href,{cache:'no-cache',signal:AbortSignal.timeout(12000)});
    if(response.ok)return new Response(response.body,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream','Content-Security-Policy':CSP}});
   }catch{}
  }
  const response=await net.fetch(pathToFileURL(file).href);
  return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream','Content-Security-Policy':CSP}});
 }catch{return new Response('This page is unavailable.',{status:404});}
}
// ---- a relaunch that was in the tray -----------------------------------------------------
//
// Owen's rule of 2026-10-23: "if the launcher was minimized to system tray it should open in
// the system tray, not as a regular window and pop up on the screen for a frame or two." The
// switch is explicit (`--hidden-to-tray`, written by `updater.relaunchOptions` and read here by
// `updater.wantsHiddenToTray`), it is honoured for exactly one window — the first one of this
// process — and only where a tray icon can actually exist.
//
// The decision is made *before* the window exists, and the answer is what the first
// `ready-to-show` obeys, so there is no path where the window is shown and then hidden again:
// that would be the frame Owen is describing. In an unpackaged run the probe can be overridden
// by `EASTER_TEST_TRAY=0|1`, which is how a seat with no panel proves both answers.
let startHiddenToTray=false;
async function decideStartHiddenToTray(){
 if(!updater.wantsHiddenToTray(process.argv))return false;
 const available=await trayHostAvailable();
 const decision=launchBehaviour(settings,{trayAvailable:available,hiddenToTray:true});
 if(decision.action!=='tray'||!ensureTray()){
  // No tray host, or no icon could be created. The window comes up as an ordinary window: an
  // invisible launcher with no icon is one nobody can reach, which is worse than the single
  // frame this switch exists to avoid.
  startHiddenToTray=false;
  return false;
 }
 startHiddenToTray=true;
 trayHidden=true;
 return true;
}
function createWindow(){
 // Consumed by the first window: a window created later (macOS `activate`, or a second
 // instance arriving with no window) belongs to a player who is asking to see it.
 const hiddenInTray=startHiddenToTray;
 startHiddenToTray=false;
 window=new BrowserWindow({width:1360,height:920,minWidth:800,minHeight:600,backgroundColor:'#10232b',title:'Easter Co. Launcher',icon:path.join(__dirname,'launcher-icon.png'),show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 // A tray relaunch does not show the window at all: the tray icon the decision above already
 // created is the way back, and it is in the tray when the player looks for it.
 window.once('ready-to-show',()=>{if(!hiddenInTray)window.show();});
 window.webContents.setWindowOpenHandler(({url})=>{try{void shell.openExternal(externalURL(url));}catch{}return {action:'deny'};});
 window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('easter://easter/')){event.preventDefault();try{void shell.openExternal(externalURL(url));}catch{}}});
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.session.setPermissionCheckHandler(()=>false);
 window.loadURL('easter://easter/');
 window.on('closed',()=>{window=null;});
}
// An existing install checks for updates on launch, in the background, through the
// same pipeline. A check that finds nothing changes no state at all.
function updateOnLaunch(){
 if(!client.installed)return;
 backgroundUpdate=exclusively(runUpdate).finally(()=>{backgroundUpdate=null;notify({});});
 return backgroundUpdate;
}
// Launcher updates precede every game update and gate all privileged operations.
let launcherUpdate={phase:app.isPackaged?'checking':'current',version:null,percent:null,message:null};
// A downloaded payload is code, so its identity is checked before it is accepted: the bundle
// must say it is this launcher, at exactly the version the manifest claimed. One function, so
// the startup gate and the background check cannot disagree about what an acceptable payload is.
function launcherIdentity(file,manifest){
 const pkg=require(file+'/package.json');
 if(pkg.name!=='easter-company-launcher'||pkg.version!==manifest.version)throw Error('The downloaded launcher identity is invalid.');
}
async function checkLauncherUpdate(openGate=true){
 if(!app.isPackaged)return;
 startupReady=false;
 try{
  const target=await updater.update({current:APP_VERSION,runtime:process.versions.electron,
   root:path.join(configRoot(),'launcher-updates'),fetch:net.fetch.bind(net),
   notify:value=>{launcherUpdate=value;notify({});},
   inspect:launcherIdentity});
  if(target){
   // The apply step is the relaunch below, so this is the one moment a version change is
   // allowed to clear anything (doc/launcher-states.md, "What a version change clears"):
   // the level comes from the two versions and nothing else. It is skipped, not forced,
   // while the game is running, because a client tree removed under a live Minecraft is a
   // broken game while an update that waits for one restart is not.
   try{
    if(game)updateLog.append({from:APP_VERSION,to:launcherUpdate.version,level:updater.classify(APP_VERSION,launcherUpdate.version),cleared:[],outcome:'failed',note:'game-running'});
    else await updater.applyVersionPolicy({from:APP_VERSION,to:launcherUpdate.version,dataRoot:configRoot(),log:updateLog});
   }catch{
    // The policy writes its own failed line; a clear that did not finish costs the player
    // nothing but a stale cache, so the update still applies and the next start retries.
   }
   // The relaunch says where the window was. A launcher that is on screen comes back on screen;
   // one that had stepped aside into the tray comes back into the tray, which is what
   // `launchBehaviour` reads the switch for (Owen, 2026-10-23: no window popping up "for a
   // frame or two"). Nothing else about this gate changes.
   app.relaunch(updater.relaunchOptions({hiddenToTray:steppedAsideToTray()}));app.quit();return;
  }
  startupReady=openGate;notify({});
 }catch(error){
  launcherUpdate={phase:'blocked',percent:null,message:'Launcher update required. '+safeError(error)};
  notify({});throw error;
 }
}
function startupUpdates(){
 if(startupPromise)return startupPromise;
 startupReady=false;
 startupPromise=(async()=>{
  try{
   await checkLauncherUpdate(false);
   if(launcherUpdate.phase!=='current')return;
   startupReady=false;notify({});
   if(client.installed){
    notify({phase:'checking-client',message:'Checking game updates…'});
    const result=await updateOnLaunch();
    if(result===null)throw Error('The game update was cancelled. Retry to finish updating.');
   }
   // The resting state, which is the in-game one when this launcher came back to a game it did
   // not start (see `settleResting`): a gate that settles must not talk a running game down to
   // Play.
   startupReady=true;settleResting();
  }catch(error){
   startupReady=false;launcherUpdate={phase:'blocked',percent:null,message:'Updates must finish before playing. '+safeError(error)};notify({});
  }finally{startupPromise=null;}
 })();
 return startupPromise;
}
// ---- applying what the background check staged -------------------------------------------
//
// Owen's design, and the whole of this section: a launcher that is out of date applies the
// update, restarts and comes back — while a game is running, in the background, without
// interrupting it (updater.cjs `updateMayApplyNow` is the rule, and a running game is explicitly
// NOT a reason to wait; the client is detached and already written down by
// `rememberRunningGame` above, so the new instance re-adopts it).
//
// Where the payload comes from is the poll's own record and nothing else:
// `launcher-updates/staged.json` beside `<sha256>.asar`, the same two files
// `createLauncherPoll` writes (updater.cjs `stagedState`). This never re-downloads and never
// invents a second format. It DOES run the version policy's clear itself, because a stage that
// activated without its clear is exactly what the staging ticket refused to allow: the level
// comes from `classify(from, to)` and nothing else, and the clear runs before `current.json` is
// written — the same order the startup gate uses, so a crash between the two leaves an
// unactivated launcher rather than an uncleared one.
const launcherStash=()=>path.join(configRoot(),'launcher-updates');
// Whether the window stepped aside into the tray. This is the fact the relaunch switch is
// decided on, and it is why `trayHidden` is read as well as the window's own visibility: a
// launcher that was *born* hidden (a relaunch like this one) never stepped aside, and nobody is
// looking for it in a tray that already holds an icon for it.
function steppedAsideToTray(){
 return trayHidden===true&&Boolean(window)&&!window.isDestroyed()&&!window.isVisible();
}
// What the apply refuses to interrupt, asked of the launcher's own state: a press that has not
// settled into a game, a transfer, a sign-in, an install, or the startup gate. A game is not in
// that list on purpose.
function launcherBusyForUpdate(){
 return Boolean(working||controller||accountWorking||backgroundUpdate||startupPromise||!startupReady);
}
async function applyStagedLauncherUpdate(reason){
 if(applyingUpdate)return 'applying';
 if(!updater.updateMayApplyNow({pressInFlight:launchPresses>0,busy:launcherBusyForUpdate(),phase})){
  applyWaiting=true;
  return 'deferred';
 }
 const root=launcherStash();
 const pending=updater.stagedState(root,{current:APP_VERSION,runtime:process.versions.electron});
 if(pending.outcome==='none'){applyWaiting=false;return 'none';}
 // A record that cannot be applied is discarded rather than left for another try: a version
 // this launcher already runs or has passed, a manifest that no longer matches this device or
 // this runtime, or a payload that is not the length it claims. The payload itself stays in the
 // stash — the minor clear owns payloads — and one line says which answer this was.
 if(pending.outcome!=='ready'){
  applyWaiting=false;
  await updater.discardStaged({root});
  updateLog.apply({outcome:'failed',version:pending.manifest?.version||null,from:APP_VERSION,note:pending.outcome});
  return pending.outcome;
 }
 applyingUpdate=true;applyWaiting=false;
 const record=pending.record;
 try{await updater.applyVersionPolicy({from:APP_VERSION,to:record.version,dataRoot:configRoot(),log:updateLog});}catch{}
 let activated=null;
 try{activated=await updater.activateStaged({root,current:APP_VERSION,runtime:process.versions.electron,inspect:launcherIdentity});}catch{activated=null;}
 if(!activated){
  // The stash changed shape between the question and the activation: nothing was activated, so
  // this launcher keeps running the version it has and says so in one line.
  applyingUpdate=false;
  updateLog.apply({outcome:'failed',version:record.version,from:APP_VERSION,note:'changed'});
  return 'invalid';
 }
 updateLog.apply({outcome:'ok',version:activated.version,from:APP_VERSION,note:'applied'});
 // The player is told where they can see it, and nowhere else: the mandatory-update surface the
 // startup gate already owns (`phase:'restarting'` and its own sentence), never a second dialog
 // and never a new string. A launcher in the tray gets no window and no broadcast at all — the
 // point of the whole choreography is that the player notices nothing until they come back.
 launcherUpdate={phase:'restarting',percent:100,version:activated.version,message:'Restarting launcher…'};
 startupReady=false;
 const inTray=steppedAsideToTray();
 if(!inTray)notify({});
 app.relaunch(updater.relaunchOptions({hiddenToTray:inTray}));
 app.quit();
 return 'relaunched';
}
// A stage that landed while the launcher was busy is not lost: the press, transfer or gate that
// was in the way calls this as it settles.
function retryStagedUpdateApply(){
 if(!applyWaiting)return;
 void applyStagedLauncherUpdate('idle').catch(()=>{});
}
// A staged record that could never be applied — a version this launcher already runs or has
// passed, a manifest that no longer matches this device or this runtime, a payload that is not
// what the record claims — is discarded once, at startup, instead of being left in the stash for
// the apply step to refuse again on every trigger. A READY record is left exactly where it is: it
// is a verified payload waiting for the apply step, and on a packaged build the startup gate above
// supersedes it by finding the same release itself.
async function discardUnusableStaged(){
 const root=launcherStash();
 let pending;
 try{pending=updater.stagedState(root,{current:APP_VERSION,runtime:process.versions.electron});}catch{return 'none';}
 if(pending.outcome==='none'||pending.outcome==='ready')return pending.outcome;
 try{await updater.discardStaged({root});}catch{}
 updateLog.apply({outcome:'failed',version:pending.manifest?.version||null,from:APP_VERSION,note:pending.outcome});
 return pending.outcome;
}

// ---- asking again while the launcher is open -------------------------------------------
//
// Owen's rule of 2026-10-23: a running launcher asks its server "am I still on the latest
// version?" every so often and, when it is not, stages the update. Every number is named in
// updater.cjs beside the reason for it (POLL_INTERVAL_MS = 15 minutes, 90 s of jitter, a
// one-hour backoff cap, a 15 s answer-by bound).
//
// What this must never do, and does not: paint anything. There is no `notify` here, no dialog,
// no spinner and no page notice — a failed ask writes one line to launcher-update.log and
// returns, and a stage writes one line and one field. It cannot delay a Play press either:
// nothing in the launch path waits on it, and it defers itself while a press is in flight or an
// install is transferring. It never restarts anything by itself: the stage it writes is what the
// apply step above (`applyStagedLauncherUpdate`) picks up.
let launcherPoll=null;
// The redirect question, asked the one way Electron can answer it without following the
// redirect: `net.fetch` refuses `redirect:'manual'` outright ("Redirect was cancelled",
// measured 2026-10-23) and follows it otherwise, while net.request reports the hop through its
// `redirect` event and can be cancelled before any body is read. The timeout is the poller's
// named bound, and the request is aborted on it and on the poller's own cancellation.
function latestHop({url,signal}={}){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=outcome=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   try{signal?.removeEventListener?.('abort',cancel);}catch{}
   try{request.abort();}catch{}
   outcome();
  };
  const request=net.request({url,redirect:'manual',method:'GET'});
  const cancel=()=>finish(()=>{const aborted=Error('The launcher update check was cancelled.');aborted.name='AbortError';reject(aborted);});
  const timer=setTimeout(()=>finish(()=>{const timedOut=Error('The launcher update check timed out.');timedOut.name='TimeoutError';timedOut.code='timeout';reject(timedOut);}),updater.POLL_TIMEOUT_MS);
  timer.unref?.();
  if(signal?.aborted)return cancel();
  signal?.addEventListener?.('abort',cancel,{once:true});
  request.on('redirect',(status,_method,location)=>finish(()=>resolve({status,location})));
  // A 2xx here means GitHub answered the page itself rather than redirecting; it carries no
  // tag, so it is an unanswered question and `latestVersion` refuses it rather than guessing.
  request.on('response',response=>finish(()=>resolve({status:response.statusCode,location:''})));
  request.on('error',error=>finish(()=>reject(error)));
  request.end();
 });
}
// One poll per process, started once the startup gate has begun so the two never race the
// same question. `busy` is what defers a check: the gate, a press in flight, a transfer or
// another launcher operation owns the network and the disk while any of them is live.
//
// A game is deliberately NOT one of those any more (Owen, 2026-10-23: "the launcher can update
// while a game is open, in the background and resume"). A launcher sitting in the tray behind a
// running Minecraft is exactly the launcher this question was asked for, so asking it while the
// game plays is the point rather than an interference: the question is one header-only request,
// and the stage it may write is applied by the section above, which knows how to do that
// without touching the game.
function startLauncherPoll(){
 if(launcherPoll)return launcherPoll;
 launcherPoll=updater.createLauncherPoll({
  current:APP_VERSION,
  root:path.join(configRoot(),'launcher-updates'),
  runtime:process.versions.electron,
  probe:latestHop,
  fetch:net.fetch.bind(net),
  inspect:launcherIdentity,
  enabled:settings?.autoUpdateLauncher!==false,
  busy:()=>Boolean(!startupReady||startupPromise||backgroundUpdate||working||controller||accountWorking||launchPresses>0),
  log:updateLog,
  // The stage is published as a field and nothing else: no phase moves, no dialog opens, and
  // no broadcast is sent for it. `notify({})` would repaint a state the player is looking at
  // and, because every broadcast drops `error`, could take a page notice away mid-read — a
  // background check must not touch the state channel at all. The field sits on the launcher's
  // state object, so it is in the answer to `status` and in the next broadcast the launcher
  // makes for its own reasons.
  //
  // The stage is also the whole trigger for the apply step: this is the moment the launcher has
  // a verified payload on disk and is out of date, which is what "if it's not then it
  // automatically updates and restarts" describes. The apply decides for itself whether it may
  // go now (it may, behind a running game) or has to wait for a press or a transfer to settle.
  onStaged:staged=>{
   launcherUpdate={...launcherUpdate,staged:{version:staged.version,from:staged.from,stagedAt:staged.at}};
   void applyStagedLauncherUpdate('staged').catch(()=>{});
  }
 });
 // An unpackaged run has no published release to compare itself against, so it never asks.
 if(app.isPackaged)launcherPoll.start();
 return launcherPoll;
}
// What this machine says about its own graphics, asked once at startup. Electron
// answers only after the app is ready, and it never reports video memory, so the
// system probe is what supplies that number. A failure here is not fatal: the tier
// is `unknown`, which is the same "on unless clearly weak" answer as any other
// machine the launcher cannot see into.
async function detectGraphicsHardware(){
 const fallback={gpu:null,vendor:null,vramMB:null,tier:'unknown',reason:'The graphics adapter could not be identified, so enhanced graphics are left on.',source:'none',software:false};
 // Tests only, and only in an unpackaged run: an explicit GPU profile instead of the
 // host's, so a suite can prove what the launcher does with a weak adapter without
 // owning one. Packaged builds ignore it entirely.
 if(!app.isPackaged&&typeof process.env.EASTER_TEST_GPU==='string'&&process.env.EASTER_TEST_GPU){
  try{
   const fixture=JSON.parse(process.env.EASTER_TEST_GPU);
   hardware=await detectHardware({gpuInfo:fixture.gpuInfo??null,featureStatus:fixture.featureStatus??null,platform:process.platform,env:process.env,adapters:fixture.adapters??[]});
   graphics={recommended:hardware.recommended,tunable:hardware.tunable};
   return hardware;
  }catch{}
 }
 try{
  const [gpuInfo,featureStatus]=await Promise.all([
   app.getGPUInfo('complete').catch(()=>null),
   Promise.resolve().then(()=>app.getGPUFeatureStatus()).catch(()=>null)
  ]);
  hardware=await detectHardware({gpuInfo,featureStatus});
 }catch{hardware=fallback;}
 hardware={...fallback,...hardware,recommended:hardware?.recommended!==false,tunable:Boolean(hardware?.tunable)};
 graphics={recommended:hardware.recommended,tunable:hardware.tunable};
 return hardware;
}
if(instance){
 app.on('second-instance',(_event,argv)=>{
  // Starting the launcher again is the way back to a window that stepped aside,
  // whether it is behind a tray icon or hidden on a desktop that has none. The game
  // shortcut uses this same path.
  if(!window||window.isDestroyed())createWindow();
  else{
   if(window.isMinimized())window.restore();
   window.show();window.focus();
  }
  // The shortcut clicked while the launcher is already running arrives here carrying its
  // own command line, so the flag is read from that line rather than from the first
  // launch's arguments: the click then starts the game once everything is ready instead
  // of being a plain window focus.
  if(wantsAutoStart(argv))void autoStart();
 });
 app.whenReady().then(async()=>{
  await fs.mkdir(configRoot(),{recursive:true});
  // The machine's answer is needed before anything reads the saved settings, and
  // before the first state is broadcast, so no view ever sees a missing default.
  await detectGraphicsHardware();
  let stored={},savedFile=false;
  try{stored=JSON.parse(await fs.readFile(settingsFile(),'utf8'));savedFile=true;}catch{}
  try{settings={...defaultSettings,...cleanSettings(stored,Math.floor(os.totalmem()/1024/1024))};}catch{settings={...defaultSettings};}
  // The saved location is a path this launcher wrote itself after the picker
  // validated it. It is never taken from anywhere else.
  if(typeof stored.location==='string'&&path.isAbsolute(stored.location))settings.location=path.resolve(stored.location);
  // Owen's one-time launch-behaviour migration, and the only rewrite of a saved settings
  // file this launcher does on its own. A file written before trayOnLaunch existed came
  // from a build whose default was to close the launcher behind the game, so it cannot say
  // whether that was ever chosen — both household machines carry the old default
  // verbatim. The pair resolves to today's defaults, both off, and the file is written
  // back once with the field present: that write is what makes this happen once. After
  // it, the file is the player's own record and is never rewritten here again.
  const migration=migrateLaunchPreferences(savedFile?stored:null);
  if(migration.migrated){
   settings={...settings,exitOnLaunch:migration.exitOnLaunch,trayOnLaunch:migration.trayOnLaunch};
   await atomicJSON(settingsFile(),stored&&stored.graphicsChosen===true?{...settings,graphicsChosen:true}:settings);
  }
  // First run: the machine decides, and the decision is persisted immediately.
  // Afterwards the saved choice is the player's and is never re-decided — not even
  // on a machine where the GPU has changed since.
  const choice=chooseGraphicsDefault(stored,graphics.recommended);
  if(settings.includeGraphics!==choice.includeGraphics||!choice.chosen){
   settings.includeGraphics=choice.includeGraphics;
   await atomicJSON(settingsFile(),{...settings,graphicsChosen:true});
  }
  const saved=await vault.readEncrypted(accountsFile(),vaultOptions());
  if(saved&&Array.isArray(saved.accounts)){
   savedAccounts=saved.accounts.filter(restorableSession);
   session=savedAccounts.find(entry=>identity.id(entry)===saved.active)||null;
   savedAccounts=session?[session]:[];await saveSession();
   state.remembered=Boolean(session);
  }else if(secureStorageAvailable())try{
   session=JSON.parse(safeStorage.decryptString(await fs.readFile(vaultFile())));
   if(!session?.refreshToken||!session?.profile)session=null;
   else{savedAccounts=[session];await saveSession();}
  }catch{}
  // Restore the Easter Company session from the vault without a network call, so
  // launch never waits on the account API. Sign-in and play re-issue it.
  company=storedSession(await vault.readEncrypted(companyFile(),vaultOptions()));
  if(company&&company.expiresAt<=Date.now())company=null;
  // The head a password sign-in shows, read back from its cache before the first broadcast so
  // a restart paints the face immediately, and any read that has to ask Mojang happens after
  // it (doc/launcher-states.md, "A password sign-in still knows the account is linked").
  await readCachedHead();
  // The last known Minecraft-session answer, read from its own file beside the vaults and
  // before the first broadcast, so a restart paints the answer it had instead of
  // "Checking your Minecraft session…" (doc/launcher-states.md, "The last known answer,
  // shown while it is confirmed"). It says nothing about whether a launch is allowed: this
  // call cannot change `canPlay`, and the mint below still runs exactly as it always did.
  await readSessionCache();
  await refreshClient();
  // Before the window exists, so the first launch a player sees is already configured
  // and no view can observe a half-seeded tree. A no-op for a tree that has already
  // been seeded, and awaited only for the two reads it costs. It also declines to touch a
  // client tree while a game is running, so the adoption below happens first.
  //
  // The game this launcher may have left running is settled before that read and before any
  // window or broadcast exists: an update applied behind a live Minecraft ends in this process
  // starting while the game is still in the world, and the first thing the player may see when
  // they come back is a launcher that says so instead of offering Play. A marker that no longer
  // matches its process is removed here and this launcher starts in its ordinary state.
  await adoptRunningGame();
  await discardUnusableStaged();
  await seedClientDisplay();
  // A relaunch that replaced a launcher sitting in the tray comes up in the tray, decided before
  // the window is created so the first `ready-to-show` already knows not to show it.
  await decideStartHiddenToTray();
  protocol.handle('easter',resource);registerIPC();createWindow();
  // Before the first broadcast, so the dialog's own render already knows whether the two
  // entries exist and the window never shows a shortcut state it has to correct.
  await refreshShortcuts();
  // One mint at startup when this machine's saved Microsoft session cannot launch on its own:
  // an account whose session lives on the service is ready to play without a prompt, and the
  // hero can only say that after asking. Never asked when nothing is saved, and never a
  // failure the player sees when the service has no such route.
  //
  // Asked BEFORE the first broadcast, because the ask is what decides the hero's first word: a
  // linked account whose session has not been asked about yet publishes `unknown`, and a first
  // frame painted before this call would be the one frame that shows a session word with nothing
  // behind it (Owen restarted 1.0.39 at 08:01:53Z against a paused Aurora and read the Microsoft
  // demand before anything had been asked — ticket 24c8c6dc). This call sets `checking` before
  // it awaits, so the first state the player's window ever receives says the launcher is asking.
  if(company&&company.account.microsoftSubject&&!localRefreshable()&&!localTokenLive())void probeMinecraftSession();
  // The first state the player's window receives is the resting one, and while a game this
  // launcher came back to is still running that state is the in-game one.
  settleResting();
  if(app.isPackaged)void startupUpdates();
  else void updateOnLaunch()?.catch(()=>{});
  // The same question, asked again while the launcher stays open (updater.cjs
  // `createLauncherPoll`): fifteen minutes, quiet, and it only ever stages.
  startLauncherPoll();
  // The game shortcut's own launch. Scheduled after the startup update gates so the
  // auto-start waits for them rather than racing them.
  if(wantsAutoStart(process.argv))void autoStart();
  if(company)void renewCompany();
  // One silent status read, so the hero can say honestly that the server is offline
  // before anyone presses Play. Never a wake, and a failure leaves 'unknown' alone.
  if(company)void refreshGameStatus();
  const renewal=setInterval(()=>{if(company&&!accountWorking&&!controller)void renewCompany();},6*60*60*1000);renewal.unref();
  if(session?.profile&&!session.profile.skin){const target=session;void loadSkin(target).then(async()=>{if(session===target)await saveSession();});}
 });
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',()=>{launcherPoll?.stop();controller?.abort();control?.cancel();destroyTray();stopWatchingAdoptedGame();});
}
