'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,shell,safeStorage,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {MicrosoftAuth,DEFAULT_CLIENT_ID}=require('./auth.cjs');
const {AccountClient,AccountError,publicAccount,companySession,storedSession,companyVaultName}=require('./accounts.cjs');
const {apiOrigin,clientOrigin,defaultInstallLocation,ensureLocation,resolveLocation,serverList}=require('./config.cjs');
const vault=require('./vault.cjs');
const identity=require('./identity.cjs');
const {localFile,trustedFrame,externalURL,publicProfile,cleanSettings,includeGraphicsValue}=require('./security.cjs');
const {atomicJSON,installClient,applyGraphics,checkForUpdates,clientStatus,canPlay,createControl,launchOptions,launch}=require('./install.cjs');
const {renderOffload}=require('./hardware.cjs');
const {detectHardware,installedQuality}=require('./hardware.cjs');
const APP_VERSION=require('../package.json').version;
// The installed application is "Easter Co. Launcher". The per-user directory stays
// "Easter Company": renaming it would orphan the saved account and settings of anyone
// already signed in, so the name and the path are deliberately decoupled here.
app.setName('Easter Co. Launcher');
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
const auth=new MicrosoftAuth({clientId});
const accounts=new AccountClient({baseUrl:apiOrigin(),client:'launcher/'+APP_VERSION});
const defaultSettings={memoryMB:Math.min(4096,Math.max(2048,Math.floor(os.totalmem()/1024/1024/2048)*1024)),javaPath:'',server:'100.100.1.0:25565',location:'',includeGraphics:false,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true};
// The launcher state contract in doc/launcher-states.md. `phase` and `progress`
// are the live pipeline's; everything else is derived from the installed client,
// the account session and the saved settings on every broadcast, so no view has to
// guess. canPlay is computed here and nowhere else.
let state={message:'Download the game to get started.',error:null,device:null,progress:null,profile:null,remembered:false,account:null};
let phase=null,progress=null,control=null,installStarted=false,backgroundUpdate=null;
let startupReady=!app.isPackaged,startupPromise=null;
const updater=require('./updater.cjs');
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
function serversState(){return serverList();}
async function readQuality(){quality=await installedQuality(gameRoot());return quality;}
function installInfo(){
 const installed=Boolean(client.installed);
 return {location:gameRoot(),defaultLocation:defaultLocation(),installed,includeGraphics:Boolean(settings?.includeGraphics),version:installed?client.version:null,updatedAt:installed?client.updatedAt:null};
}
function notify(patch={}){
 if(company&&company.expiresAt<=Date.now())company=null;
 if('message' in patch && !('error' in patch))patch={...patch,error:null};
 if('progress' in patch)progress=patch.progress;
 if(typeof patch.phase==='string')phase=patch.phase;
 state={...state,...patch,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null,accounts:savedCompanyAccounts()};
 const install=installInfo(),profile=publicProfile(session),actions=[];
 if(!install.installed)actions.push('download');
 if(!company)actions.push('signin');
 else if(!companyReady())actions.push('setup-password');
 else if(!microsoftConnected())actions.push('connect-microsoft');
 else if(identity.access(session)==='missing')actions.push('buy');
 else if(identity.access(session)==='profile-required')actions.push('setup-profile');
 else if(identity.access(session)==='unknown')actions.push('check-access');
 const paused=Boolean(control&&control.paused&&!control.cancelled);
 state={...state,...{phase:paused?'paused':(phase||(install.installed?'ready':'uninstalled')),progress,paused,install,actions,accessChecking,accountWorking,companyReady:companyReady(),microsoftConnected:microsoftConnected(),minecraftAccess:identity.access(session),microsoftAccount:identity.publicIdentity(session),canPlay:!accountWorking&&companyReady()&&microsoftConnected()&&!accessChecking&&identity.access(session)==='owned'&&startupReady&&!backgroundUpdate&&!['downloading','paused','verifying','installing','updating','checking-client'].includes(phase)&&canPlay(install,profile),startupReady,bar:{visible:install.installed||installStarted},hardware:hardwareState(),graphics:graphicsState(),servers:serversState(),launcherUpdate}};
 if(window&&!window.isDestroyed())window.webContents.send('launcher:state',state);
}
// Nothing is transferring after this: the bar falls back to PLAY NOW or the
// sign-in action through `actions`, and the phase returns to the resting value.
function settle(message,extra={}){phase=null;progress=null;control=null;notify({message,device:controller?state.device:null,...extra});}
async function refreshClient(){client=await clientStatus(gameRoot());await readQuality();}
function secureStorageAvailable(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
const vaultOptions=()=>({safeStorage,platform:process.platform});
function saveSession(){
 if(session){savedAccounts=savedAccounts.filter(entry=>identity.id(entry)!==identity.id(session)&&!(session.microsoftId&&entry.microsoftId===session.microsoftId)&&!(session.xuid&&session.xuid!=='0'&&entry.xuid===session.xuid)&&!(session.profile&&entry.profile?.id===session.profile.id));savedAccounts.push(session);}
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
async function loadSkin(target){
 if(!target?.profile)return;
 try{
  let url=target.profile.skinURL;
  if(!url){
   const response=await net.fetch('https://sessionserver.mojang.com/session/minecraft/profile/'+target.profile.id,{signal:AbortSignal.timeout(5000)});
   if(!response.ok)return;
   const data=await response.json(),property=data.properties?.find(p=>p.name==='textures');
   url=JSON.parse(Buffer.from(property.value,'base64').toString()).textures?.SKIN?.url;
  }
  if(!/^https?:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]+$/i.test(url||''))return;
  const response=await net.fetch(url.replace('http:','https:'),{signal:AbortSignal.timeout(5000)});
  if(!response.ok)return;
  const reader=response.body.getReader(),chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>131072){await reader.cancel();return;}chunks.push(Buffer.from(value));}
  const png=Buffer.concat(chunks);
  if(png.subarray(0,8).toString('hex')==='89504e470d0a1a0a')target.profile.skin='data:image/png;base64,'+png.toString('base64');
 }catch{} // Skin service availability never blocks playing.
}
// The Easter Company session uses the same vault discipline as the Microsoft one:
// OS-backed safeStorage or nothing at all.
async function saveCompany(){
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
 try{return control?await action():await exclusively(action);}
 finally{accountWorking=false;notify({});}
}
function companyReady(){return Boolean(company&&company.expiresAt>Date.now()&&company.account.passwordRequired===false);}
function microsoftConnected(){return Boolean(company&&session&&company.account.microsoftSubject&&session.companySubject===company.account.microsoftSubject);}
function savedCompanyAccounts(){
 const seen=new Set();
 return savedAccounts.filter(entry=>Number.isSafeInteger(entry.companyId)&&!seen.has(entry.companyId)&&seen.add(entry.companyId)).map(entry=>({id:'EC-'+entry.companyId,name:entry.companyName||entry.profile?.name||'Company member'}));
}
// Only a successful server-verified login replaces the current Company identity.
async function enrolAccount({announce=true,throwOnError=false,candidate=session,lockCompany=true}={}){
 if(!candidate)return;
 try{
  if(!candidate.xboxUserToken||candidate.xboxExpiresAt<Date.now()+300000)candidate=await auth.refresh(candidate,controller?.signal,false,true);
  const expected=lockCompany?company?.account.id:null;
  let signed;
  try{signed=await accounts.login(candidate.xboxUserToken,controller?.signal,lockCompany&&company?.expiresAt>Date.now()?company.token:undefined);}
  catch(error){if(error.code!=='invalid_session'||!lockCompany||!company)throw error;signed=await accounts.login(candidate.xboxUserToken,controller?.signal);}
  if(expected&&signed.account.id!==expected)throw new AccountError('identity_conflict','Use the Microsoft account linked to your Easter Company account.');
  const next=companySession(signed),previous=company;
  session={...candidate,companyId:next.account.id,companyName:next.account.displayName||next.account.minecraftName||'Company member'};
  company=next;
  await loadSkin(session);await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  if(announce)notify({message:signed.created?'Easter Company account created. Set a password to finish.':'Signed in to your Easter Company account.'});
  return publicAccount(company);
 }catch(error){
  if(error.name==='AbortError')throw error;
  if(throwOnError)throw error;
  notify({message:error.message||'The Easter Company account could not be signed in.'});
 }
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
  if(error.name!=='CancelledError')settle(message,{device:null,error:error.name==='AbortError'?null:message});
  throw Error(message);
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
  const result=await installClient({root:gameRoot(),settings,notify,control,mode:'install',includeGraphics,hardware:hardwareState()});
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
  const result=await checkForUpdates({root:gameRoot(),settings,notify,control,includeGraphics:Boolean(settings.includeGraphics),hardware:hardwareState()});
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
// the app-owned client tree. Off: nothing is fetched, nothing already installed is
// removed, and the base chunk is never invalidated.
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
   result=await applyGraphics({root:gameRoot(),settings,notify,control,includeGraphics:enabled,hardware:hardwareState()});
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
 notify({message:'Opening Microsoft sign-in…',device:null,...(control?{}:{progress:null})});
 try{
  const signed=await auth.signIn(device=>notify({device,message:'Enter this code on Microsoft’s sign-in page.'}),controller.signal);
  await enrolAccount({candidate:signed,lockCompany:options.link===true,throwOnError:true});
  notify({device:null,message:session.profile?'Signed in as '+session.profile.name+'.':'Microsoft sign-in complete.'});
 }finally{controller=undefined;}
}
// Install or update before launch. Returns the prepared release, or null when the
// installed client is already current.
async function ensureClient(){
 await refreshClient();
 if(!client.installed)return runInstall();
 const checked=await runUpdate();
 return checked?.result||null;
}
async function play(){
 if(!companyReady()){settle(company?'Create your Easter Company password to finish setup.':'Sign in to your Easter Company account first.');return {requiresAccount:true};}
 if(!microsoftConnected()){settle('Sign in with the Microsoft account linked to '+company.account.companyId+'.');return {requiresMicrosoft:true};}
 notify({phase:'launching',message:'Checking your Minecraft session…',device:null,progress:null});
 try{session=await auth.refresh(session,undefined,true);}catch(error){
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
 notify({phase:'launching',message:'Starting Minecraft…',progress:null});
 const child=await launch(launchOptions({root:gameRoot(),version,javaPath,session,settings,launchEnv:launchEnvironment()}));
 game=child;
 // Do not store launch arguments or raw stdout; Minecraft writes its own latest.log.
 child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
 child.once('error',()=>{game=null;const message='Minecraft could not start. Check Java and try again.';settle(message,{error:message});});
 child.once('exit',code=>{game=null;const message=code===0?'Minecraft closed. Ready to play.':'Minecraft closed with code '+code+'. Its log is in the client folder.';settle(message,{error:code===0?null:message});});
 notify({phase:'running',message:'Minecraft is running. Your map stays right here.',progress:null});
 // Owen's setting: the launcher is a doorway, so it closes behind the game it started.
 if(settings.exitOnLaunch!==false)setTimeout(()=>{ if(game){ app.quit(); } },800);
}
function registerIPC(){
 const handle=(name,fn)=>ipcMain.handle('launcher:'+name,async(event,...args)=>{
  if(!trustedFrame(event))throw Error('Untrusted launcher request.');
  try{
   if(!startupReady&&!['status','retry-updates','pause-install','resume-install','cancel-install'].includes(name))throw Error('Updates must finish before this launcher can be used.');
   return {ok:true,value:await fn(...args)};
  }catch(error){return {ok:false,error:safeError(error),code:['invalid_grant','invalid_session','invalid_microsoft_token','identity_conflict','reauthentication_required','password_policy','rate_limited'].includes(error.code)?error.code:undefined};}
 });
 handle('status',()=>({...state,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null,accounts:savedCompanyAccounts(),settings,totalMemoryMB:Math.floor(os.totalmem()/1024/1024),version:APP_VERSION,hardware:hardwareState(),graphics:graphicsState(),servers:serversState(),launcherUpdate,authName:clientId===DEFAULT_CLIENT_ID?'Prism Launcher':'Easter Company'}));
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
 handle('switch-account',id=>exclusively(async()=>{
  if(typeof id!=='string'||!/^EC-[1-9][0-9]{0,17}$/.test(id))throw Error('Choose a saved Company account.');
  const selected=savedAccounts.find(entry=>'EC-'+entry.companyId===id);
  if(!selected)throw Error('That account is no longer saved. Use Add account.');
  let refreshed;
  try{refreshed=await auth.refresh(selected,undefined,true);}catch{throw Error('This account needs to sign in again. Use Add account.');}
  await enrolAccount({candidate:refreshed,lockCompany:false,announce:false,throwOnError:true});
  notify({message:session.profile?'Signed in as '+session.profile.name+'.':'Microsoft sign-in complete.'});
 }));
 handle('continue-microsoft',()=>accountOperation(async()=>{
  if(!session)throw Error('Sign in with Microsoft to continue.');
  await enrolAccount({throwOnError:true});
  notify({message:'Signed in to your Easter Company account.'});
 }));
 handle('company-login',(companyId,password)=>accountOperation(async()=>{
  if(typeof companyId!=='string'||companyId.length>64||typeof password!=='string'||password.length>128)throw Error('Enter your Company ID and password.');
  const signed=await accounts.loginPassword(companyId,password);
  const next=companySession(signed),previous=company;
  company=next;
  session=savedAccounts.find(entry=>entry.companyId===next.account.id&&entry.companySubject===next.account.microsoftSubject)||null;
  await saveSession();await saveCompany();
  if(previous?.token&&previous.token!==next.token)await accounts.logout(previous.token);
  notify({message:'Signed in to '+next.account.companyId+'.'});
  return publicAccount(company);
 }));
 handle('company-password',(password,replace=false)=>accountOperation(async()=>{
  if(!company)throw Error('Sign in with Microsoft first.');
  if(typeof password!=='string'||[...password].length<15||[...password].length>128)throw Error('Use a password or passphrase of 15 to 128 characters.');
  const signed=await accounts.setPassword(company.token,password,replace===true);
  company=companySession(signed);await saveCompany();notify({message:'Your Easter Company password is saved.'});
  return publicAccount(company);
 }));
 handle('open-minecraft-store',()=>shell.openExternal('https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc'));
 handle('open-minecraft-profile',()=>shell.openExternal('https://www.minecraft.net/en-us/msaprofile'));
 handle('recheck-access',async()=>{
  if(!session)throw Error('Sign in with Microsoft first.');
  if(controller||accountWorking||game||(working&&!control))throw Error('Wait for the current operation to finish.');
  const run=async()=>{
   accessChecking=true;controller=new AbortController();notify({message:'Checking Minecraft Java access…'});
   try{
    const refreshed=await auth.refresh(session,controller.signal,true);
    session=refreshed;
    await loadSkin(session);await saveSession();await enrolAccount({announce:false});
    notify({message:'Minecraft Java access checked.'});
   }catch(error){session={...session,minecraftAccess:'unknown'};notify({});throw error;}
   finally{accessChecking=false;controller=undefined;notify({});}
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
 handle('play',async()=>{if(backgroundUpdate)await backgroundUpdate;if(game||working||controller)throw Error('Wait for the current operation to finish.');if(app.isPackaged)await checkLauncherUpdate();if(!startupReady)throw Error('Update the launcher before playing.');return exclusively(play);});
 handle('settings',async input=>{
  if(working||controller)throw Error('Wait for the current operation before changing settings.');
  // A running game already owns its launch configuration. Saved preferences apply
  // on the next launch and do not mutate the running process.
  // The location is never taken from this handler: it comes from the folder
  // picker or the saved setting, nowhere else.
  settings={...cleanSettings(input,Math.floor(os.totalmem()/1024/1024)),location:settings.location,includeGraphics:includeGraphicsValue(input,settings.includeGraphics)};
  await atomicJSON(settingsFile(),settings);return settings;
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
  if(target){app.relaunch(updater.relaunchOptions());app.quit();return;}
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
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
 app.whenReady().then(async()=>{
  await fs.mkdir(configRoot(),{recursive:true});
  // The machine's answer is needed before anything reads the saved settings, and
  // before the first state is broadcast, so no view ever sees a missing default.
  await detectGraphicsHardware();
  let stored={};
  try{stored=JSON.parse(await fs.readFile(settingsFile(),'utf8'));}catch{}
  try{settings={...defaultSettings,...cleanSettings(stored,Math.floor(os.totalmem()/1024/1024))};}catch{settings={...defaultSettings};}
  // The saved location is a path this launcher wrote itself after the picker
  // validated it. It is never taken from anywhere else.
  if(typeof stored.location==='string'&&path.isAbsolute(stored.location))settings.location=path.resolve(stored.location);
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
  await refreshClient();
  protocol.handle('easter',resource);registerIPC();createWindow();
  notify({message:client.installed?'Client ready.':'Download the game to get started.'});
  if(app.isPackaged)void startupUpdates();
  else void updateOnLaunch()?.catch(()=>{});
  if(session?.profile&&!session.profile.skin){const target=session;void loadSkin(target).then(async()=>{if(session===target)await saveSession();});}
 });
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',()=>{controller?.abort();control?.cancel();});
}
