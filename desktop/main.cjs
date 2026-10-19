'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,shell,safeStorage,dialog,screen,Tray,Menu,nativeImage}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url'),{execFile}=require('node:child_process');
const {MicrosoftAuth,SignInLog,DEFAULT_CLIENT_ID}=require('./auth.cjs');
const {AccountClient,AccountError,publicAccount,companySession,storedSession,companyVaultName,MESSAGES:ACCOUNT_MESSAGES,USERNAME_PATTERN}=require('./accounts.cjs');
const {apiOrigin,clientOrigin,defaultInstallLocation,ensureLocation,resolveLocation}=require('./config.cjs');
// The game server's own half of the contract: the frozen status shape and the one
// wait rule. Its two routes live on the account client (accounts.cjs), because the
// game status is served from the account API's origin with the account's own session.
const {GameWaitError,gameMessage,wakeServer}=require('./game.cjs');
const vault=require('./vault.cjs');
const {providerSignIn}=require('./providers.cjs');
const {hydratePicture}=require('./profile.cjs');
const identity=require('./identity.cjs');
const {localFile,trustedFrame,externalURL,publicProfile,cleanSettings,migrateLaunchPreferences,launchBehaviour,includeGraphicsValue}=require('./security.cjs');
const {APP_USER_MODEL_ID,ICON_FILE,wantsAutoStart,autoStartDecision,shortcutSupport,readGameShortcuts,applyGameShortcuts}=require('./shortcuts.cjs');
const install=require('./install.cjs');
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
function beginActivity(stage,{replace=true}={}){
 // Optional profile reads never take over an interactive sign-in or mutation.
 // A read replaced by a newer operation cannot clear or revive that operation.
 if(!replace&&activityOwner)return {update:()=>{},end:()=>{}};
 const owner=Symbol('activity'),startedAt=Date.now();let currentStage=null;activityOwner=owner;
 const update=next=>{
  if(activityOwner!==owner||!Object.hasOwn(ACTIVITY_MESSAGES,next)||currentStage===next)return;
  currentStage=next;
  notify({activity:{stage:next,message:ACTIVITY_MESSAGES[next],startedAt}});
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
 return {
  state:status?status.state:'unknown',
  ready:Boolean(status&&status.ready),
  endpoint:status?status.endpoint:null,
  since:status?status.since:null,
  players:status?status.players:null,
  detail:status?status.detail:null,
  message:gameMessage(status||{state:'unknown',ready:false},{waking,checked:gameChecked}),
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
 const routes=gameRoutes();
 if(!routes)return {settled:true,controller:null,promise:Promise.resolve({outcome:'unknown',status:null,woke:false})};
 const controller=new AbortController(),run={settled:false,controller,outcome:null};
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
 const answer=await gameAnswer(()=>accounts.gameStatus(gameToken()));
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
 else if(!microsoftConnected())actions.push('connect-microsoft');
 else if(identity.access(session)==='missing')actions.push('buy');
 else if(identity.access(session)==='profile-required')actions.push('setup-profile');
 else if(identity.access(session)==='unknown')actions.push('check-access');
 return actions;
}
// The frozen Play gate. `canPlay` in the state is exactly this, and the game shortcut
// asks the same question before it starts anything.
function canPlayNow(){return !accountWorking&&companyReady()&&microsoftConnected()&&!accessChecking&&identity.access(session)==='owned'&&startupReady&&!backgroundUpdate&&!['downloading','paused','verifying','installing','updating','checking-client'].includes(phase)&&canPlay(installInfo(),publicProfile(session));}
async function readQuality(){quality=await installedQuality(gameRoot());return quality;}
function installInfo(){
 const installed=Boolean(client.installed);
 return {location:gameRoot(),defaultLocation:defaultLocation(),installed,includeGraphics:Boolean(settings?.includeGraphics),version:installed?client.version:null,updatedAt:installed?client.updatedAt:null};
}
function notify(patch={}){
 if(company&&company.expiresAt<=Date.now())company=null;
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
 state={...state,...patch,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null};
 const install=installInfo(),actions=remainingActions();
 const paused=Boolean(control&&control.paused&&!control.cancelled);
 state={...state,...{phase:paused?'paused':(phase||(install.installed?'ready':'uninstalled')),progress,paused,install,actions,accessChecking,accountWorking,companyReady:companyReady(),microsoftConnected:microsoftConnected(),minecraftAccess:identity.access(session),microsoftAccount:identity.publicIdentity(session),minecraftHead:headState(),canPlay:canPlayNow(),startupReady,bar:{visible:install.installed||installStarted},hardware:hardwareState(),graphics:graphicsState(),game:gameState(),settings,shortcuts:shortcutState,launcherUpdate}};
 if(window&&!window.isDestroyed())window.webContents.send('launcher:state',state);
 // A head this session has to ask Mojang for is asked for after the broadcast, never before
 // it: the state the player sees is never held open for a face (doc/launcher-states.md).
 ensureMinecraftHead();
}
// Nothing is transferring after this: the bar falls back to PLAY NOW or the
// sign-in action through `actions`, and the phase returns to the resting value.
function settle(message,extra={}){phase=null;progress=null;control=null;notify({message,device:controller?state.device:null,...extra});}
async function refreshClient(){client=await clientStatus(gameRoot());await readQuality();}
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
 if(token)await accounts.logout(token);
 await vault.remove(companyFile());
}
async function accountOperation(action){
 if(accountWorking||controller||game||(working&&!control))throw Error('Wait for the current operation to finish.');
 accountWorking=true;notify({});
 try{return await withActivity('account-working',()=>control?action():exclusively(action));}
 finally{accountWorking=false;notify({});}
}
async function renewCompany(){
 const target=company;if(!target)return;
 try{const signed=await accounts.refreshSession(target.token);if(company!==target||accountWorking||controller)return;company=companySession(signed);await saveCompany();notify({});}
 catch(error){if(company!==target)return;if(error.code==='invalid_session'){company=null;await vault.remove(companyFile());notify({message:ACCOUNT_MESSAGES.invalid_session});}}
}
function companyReady(){return Boolean(company&&company.expiresAt>Date.now()&&company.account.passwordRequired===false);}
function microsoftConnected(){return Boolean(company&&session&&company.account.microsoftSubject&&session.companySubject===company.account.microsoftSubject);}
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
  update('company-signing-in');
  const microsoftAccessToken=typeof auth.graphAccessToken==='function'?await auth.graphAccessToken(candidate.refreshToken,controller?.signal):null;
  const signed=await accounts.login(candidate.xboxUserToken,controller?.signal,lockCompany&&company?.expiresAt>Date.now()?company.token:undefined,microsoftAccessToken,update);
  // The Microsoft identity the service answered with is not the one this launcher is signed
  // in to. The sentence is the account service's own, from the one table that words these
  // refusals (accounts.cjs MESSAGES), so the player reads the same copy whichever side
  // noticed the conflict — here, or in the service's own answer further up.
  if(expected&&signed.account.id!==expected)throw new AccountError('identity_conflict',ACCOUNT_MESSAGES.identity_conflict);
  const next=companySession(signed),previous=company;
  session={...candidate,companyId:next.account.id,companyName:next.account.displayName||next.account.minecraftName||'Company member',companyUsername:next.account.username||null};
  company=next;
  await loadSkin(session);await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  if(announce)notify({message:signed.created?'Easter Company account created. Set a password to finish.':'Signed in to your Easter Company account.'});
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
 }finally{working=false;}
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
async function login(options={}){
 controller=new AbortController();
 const activity=beginActivity('microsoft-opening');
 notify({message:'Opening Microsoft sign-in…',device:null,...(control?{}:{progress:null})});
 try{
  const signed=await auth.signIn(device=>{activity.update('microsoft-waiting');notify({device,message:'Enter this code on Microsoft’s sign-in page.'});},controller.signal,activity.update);
  const enrolled=await enrolAccount({candidate:signed,lockCompany:Boolean(company)||options.link===true,throwOnError:true,onStage:activity.update});
  notify({device:null,message:session.profile?'Signed in as '+session.profile.name+'.':'Microsoft sign-in complete.'});
  // The sign-in answer is the one place `emailStatus` leaves the main process, so the
  // sign-in dialog can say that Microsoft's address could not be read. No address, ever.
  return typeof enrolled?.emailStatus==='string'?{emailStatus:enrolled.emailStatus}:undefined;
 }finally{activity.end();controller=undefined;}
}
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
// Play and the game shortcut reach this one function. The wake a Play press may start
// belongs to that press, so it is cancelled if the press does not end in a launch:
// nothing is left polling behind a sign-in the player has to redo.
async function play(){
 try{return await launchThrough();}
 finally{if(gameWake&&!gameWake.settled&&gameWake.controller)gameWake.controller.abort();}
}
async function launchThrough(){
 if(!companyReady()){settle(company?'Create your Easter Company password to finish setup.':'Sign in to your Easter Company account first.');return {requiresAccount:true};}
 if(!microsoftConnected()){settle('Sign in with the Microsoft account linked to '+(company.account.username||'your Easter Company account')+'.');return {requiresMicrosoft:true};}
 // Only now, with a real launch possible, does the press start a server: a press that
 // stops at the account checks must never wake anything.
 const waiting=beginGameWake();
 notify({phase:'launching',message:'Checking your Minecraft session…',device:null,progress:null});
 try{session=await withActivity('java-checking',update=>auth.refresh(session,undefined,true,false,update));}catch(error){
  if(!['invalid_grant','invalid_request','unauthorized_client'].includes(error.code))throw error;
  session=null;await saveSession();settle('Sign in with your linked Microsoft account to play.');return {requiresMicrosoft:true};
 }
 await saveSession();
 if(identity.access(session)!=='owned'||!session.profile){
  settle('Minecraft Java Edition access is required to play.');return {requiresAccess:true};
 }
 // The Mojang token is the enrolment credential: every sign-in re-posts it, so a
 // session the API has forgotten or revoked is reissued here instead of on launch.
 await enrolAccount({announce:false,throwOnError:true});
 if(!companyReady()){settle('Create your Easter Company password to finish setup.');return {requiresAccount:true};}
 const prepared=await ensureClient();
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
 const child=await launch(launchOptions({root:gameRoot(),version,javaPath,session,settings,launchEnv:launchEnvironment()}));
 game=child;
 // Do not store launch arguments or raw stdout; Minecraft writes its own latest.log.
 child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
 child.once('error',()=>{game=null;returnToLauncher();const message='Minecraft could not start. Check Java and try again.';settle(message,{error:message});});
 child.once('exit',code=>{game=null;returnToLauncher();const message=code===0?'Minecraft closed. Ready to play.':'Minecraft closed with code '+code+'. Its log is in the client folder.';settle(message,{error:code===0?null:message});});
 notify({phase:'running',message:'Minecraft is running. Your map stays right here.',progress:null});
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
 if(backgroundUpdate)await backgroundUpdate.catch(()=>{});
 if(game||working||controller)throw Error('Wait for the current operation to finish.');
 if(app.isPackaged)await checkLauncherUpdate();
 if(!startupReady)throw Error('Update the launcher before playing.');
 return exclusively(play);
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
function registerIPC(){
 const handle=(name,fn)=>ipcMain.handle('launcher:'+name,async(event,...args)=>{
  if(!trustedFrame(event))throw Error('Untrusted launcher request.');
  try{
   if(!startupReady&&!['status','retry-updates','pause-install','resume-install','cancel-install'].includes(name))throw Error('Updates must finish before this launcher can be used.');
   return {ok:true,value:await fn(...args)};
  }catch(error){return {ok:false,error:safeError(error),code:['invalid_grant','invalid_session','invalid_microsoft_token','identity_conflict','reauthentication_required','password_policy','username_taken','username_policy','rate_limited'].includes(error.code)?error.code:undefined};}
 });
 handle('status',async()=>{
  // Settings asks this whenever it opens, and the answer carries the two shortcut
  // entries as they are on this computer right now rather than as last saved.
  await refreshShortcuts();
  return {...state,shortcuts:shortcutState,profile:publicProfile(session),account:publicAccount(company),minecraftHead:headState(),sessionExpiresAt:company?.expiresAt||null,settings,totalMemoryMB:Math.floor(os.totalmem()/1024/1024),version:APP_VERSION,hardware:hardwareState(),graphics:graphicsState(),game:gameState(),launcherUpdate,authName:clientId===DEFAULT_CLIENT_ID?'Prism Launcher':'Easter Company'};
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
 handle('account-providers',()=>withActivity('account-working',()=>accounts.providers(),{replace:false}));
 handle('provider-sign-in',(provider,link=false)=>accountOperation(async()=>{
  if(company&&!link)throw Error('Sign out before signing in to a different account.');
  const abort=new AbortController();controller=abort;
  try{
   const signed=await providerSignIn(accounts,provider,{token:link?company?.token:undefined,signal:abort.signal,openExternal:url=>shell.openExternal(url)});
   const next=companySession(signed);
   if(link&&company&&next.account.id!==company.account.id)throw new AccountError('identity_conflict',ACCOUNT_MESSAGES.identity_conflict);
   const previous=company;company=next;
   session=savedAccounts.find(entry=>entry.companyId===next.account.id&&entry.companySubject===next.account.microsoftSubject)||null;
   await saveSession();await saveCompany();
   if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
   notify({message:signed.created?'Account created. Choose your username and password.':'Provider connected.'});
   return publicAccount(company);
  }finally{if(controller===abort)controller=null;}
 }));
 handle('profile-update',(displayName)=>accountOperation(async()=>{
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  company.account=await accounts.updateProfile(company.token,{displayName});await saveCompany();notify({});return publicAccount(company);
 }));
 handle('profile-picture',(remove=false)=>accountOperation(async()=>{
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
  company.account=await accounts.updateProfile(company.token,{picture});await saveCompany();notify({});return publicAccount(company);
 }));
 handle('continue-microsoft',()=>accountOperation(async()=>{
  if(!session)throw Error('Sign in with Microsoft to continue.');
  await enrolAccount({throwOnError:true});
  notify({message:'Signed in to your Easter Company account.'});
 }));
 // Direct Company login. The identifier is the Easter Company username or the email the
 // account was created with; neither a Company ID nor anything else is accepted here.
 handle('company-login',(identifier,password)=>accountOperation(async()=>{
  if(company)throw Error('Sign out before signing in to a different account.');
  const login=typeof identifier==='string'?identifier.trim():'';
  if(!login||login.length>254||typeof password!=='string'||password.length>128)throw Error('Enter your username or email and your password.');
  const signed=await accounts.loginPassword(login,password);
  const next=companySession(signed),previous=company;
  company=next;
  session=savedAccounts.find(entry=>entry.companyId===next.account.id&&entry.companySubject===next.account.microsoftSubject)||null;
  await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  notify({message:'Signed in to '+(next.account.username||'your Easter Company account')+'.'});
  return publicAccount(company);
 }));
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
  const found=await withActivity('account-working',()=>accounts.usernameAvailable(folded),{replace:false});
  return found.available?{available:true,reason:null,message:null}:{available:false,reason:found.reason||'username_taken',message:ACCOUNT_MESSAGES[found.reason]||ACCOUNT_MESSAGES.username_taken};
 });
 // The username is claimed with the first password and never travels again.
 handle('company-password',(password,replace=false,username)=>accountOperation(async()=>{
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
  const signed=await accounts.setPassword(company.token,password,replace===true,claim);
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
 async function sessionLost(error){
  if(error?.code!=='invalid_session'||!company)return;
  company=null;await vault.remove(companyFile());notify({});
 }
 async function verifiedEmails(){
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  try{return await accounts.emails(company.token);}
  catch(error){await sessionLost(error);throw error;}
 }
 async function selectLoginEmail(email){
  if(!company)throw new AccountError('invalid_session',ACCOUNT_MESSAGES.invalid_session);
  if(email!==null&&typeof email!=='string')throw Error('Choose one of your verified emails.');
  try{
   const listed=await accounts.selectLoginEmail(company.token,email);
   // The sentence names what changed and nothing else: no address appears in a message,
   // in the page notice or in any state a view other than the profile renders.
   notify({message:email===null?'Your login email is cleared. Sign in with Microsoft or with your username.':'Your login email is saved.'});
   return listed;
  }
  catch(error){await sessionLost(error);throw error;}
 }
 handle('profile-emails',()=>withActivity('account-working',verifiedEmails,{replace:false}));
 handle('login-email',email=>withActivity('account-working',()=>selectLoginEmail(email),{replace:false}));
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
 handle('retry-updates',()=>{if(game)throw Error('Close Minecraft before updating the launcher.');return startupUpdates();});
 handle('play',()=>startGame());
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
function createWindow(){
 window=new BrowserWindow({width:1360,height:920,minWidth:800,minHeight:600,backgroundColor:'#10232b',title:'Easter Co. Launcher',icon:path.join(__dirname,'launcher-icon.png'),show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 window.once('ready-to-show',()=>window.show());
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
async function checkLauncherUpdate(openGate=true){
 if(!app.isPackaged)return;
 startupReady=false;
 try{
  const target=await updater.update({current:APP_VERSION,runtime:process.versions.electron,
   root:path.join(configRoot(),'launcher-updates'),fetch:net.fetch.bind(net),
   notify:value=>{launcherUpdate=value;notify({});},
   inspect:(file,manifest)=>{const pkg=require(file+'/package.json');if(pkg.name!=='easter-company-launcher'||pkg.version!==manifest.version)throw Error('The downloaded launcher identity is invalid.');}});
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
   app.relaunch(updater.relaunchOptions());app.quit();return;
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
   startupReady=true;settle(client.installed?'Client ready.':'Download the game to get started.');
  }catch(error){
   startupReady=false;launcherUpdate={phase:'blocked',percent:null,message:'Updates must finish before playing. '+safeError(error)};notify({});
  }finally{startupPromise=null;}
 })();
 return startupPromise;
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
   savedAccounts=saved.accounts.filter(identity.valid);
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
  await refreshClient();
  // Before the window exists, so the first launch a player sees is already configured
  // and no view can observe a half-seeded tree. A no-op for a tree that has already
  // been seeded, and awaited only for the two reads it costs.
  await seedClientDisplay();
  protocol.handle('easter',resource);registerIPC();createWindow();
  // Before the first broadcast, so the dialog's own render already knows whether the two
  // entries exist and the window never shows a shortcut state it has to correct.
  await refreshShortcuts();
  notify({message:client.installed?'Client ready.':'Download the game to get started.'});
  if(app.isPackaged)void startupUpdates();
  else void updateOnLaunch()?.catch(()=>{});
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
 app.on('before-quit',()=>{controller?.abort();control?.cancel();destroyTray();});
}
