'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,shell,safeStorage,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {MicrosoftAuth,DEFAULT_CLIENT_ID}=require('./auth.cjs');
const {AccountClient,publicAccount,companySession,storedSession,companyVaultName}=require('./accounts.cjs');
const {apiOrigin,clientOrigin,defaultInstallLocation,ensureLocation,resolveLocation}=require('./config.cjs');
const vault=require('./vault.cjs');
const {localFile,trustedFrame,externalURL,publicProfile,cleanSettings}=require('./security.cjs');
const {atomicJSON,installClient,checkForUpdates,clientStatus,canPlay,createControl,launchOptions,launch}=require('./install.cjs');
const APP_VERSION=require('../package.json').version;
app.setName('Easter Company');
protocol.registerSchemesAsPrivileged([{scheme:'easter',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
if(!app.isPackaged&&process.env.EASTER_TEST_HOME)app.setPath('userData',process.env.EASTER_TEST_HOME);
const instance=app.requestSingleInstanceLock();
if(!instance)app.quit();
let window,settings,session=null,working=false,game=null,controller,company=null;
const siteRoot=path.resolve(__dirname,'../site');
const configRoot=()=>app.getPath('userData');
const defaultLocation=()=>defaultInstallLocation(configRoot());
const gameRoot=()=>settings?.location||defaultLocation();
const settingsFile=()=>path.join(configRoot(),'settings.json');
const vaultFile=()=>path.join(configRoot(),'account.enc');
const companyFile=()=>path.join(configRoot(),companyVaultName());
const clientId=process.env.EASTER_MICROSOFT_CLIENT_ID||DEFAULT_CLIENT_ID;
const auth=new MicrosoftAuth({clientId});
const accounts=new AccountClient({baseUrl:apiOrigin(),client:'launcher/'+APP_VERSION});
const defaultSettings={memoryMB:Math.min(4096,Math.max(2048,Math.floor(os.totalmem()/1024/1024/2048)*1024)),javaPath:'',server:'100.100.1.0:25565',location:'',includeGraphics:true};
// The launcher state contract in doc/launcher-states.md. `phase` and `progress`
// are the live pipeline's; everything else is derived from the installed client,
// the account session and the saved settings on every broadcast, so no view has to
// guess. canPlay is computed here and nowhere else.
let state={message:'Your crew is waiting.',device:null,progress:null,profile:null,remembered:false,account:null};
let phase=null,progress=null,control=null,installStarted=false,backgroundUpdate=null;
let client={installed:false,version:null,updatedAt:null,record:null};
function installInfo(){
 const installed=Boolean(client.installed);
 return {location:gameRoot(),defaultLocation:defaultLocation(),installed,includeGraphics:Boolean(settings?.includeGraphics),version:installed?client.version:null,updatedAt:installed?client.updatedAt:null};
}
function notify(patch={}){
 if('progress' in patch)progress=patch.progress;
 if(typeof patch.phase==='string')phase=patch.phase;
 state={...state,...patch,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null};
 const install=installInfo(),profile=publicProfile(session),actions=[];
 if(!install.installed)actions.push('download');
 if(!profile)actions.push('signin');
 const paused=Boolean(control&&control.paused&&!control.cancelled);
 state={...state,...{phase:paused?'paused':(phase||(install.installed?'ready':'uninstalled')),progress,paused,install,actions,canPlay:canPlay(install,profile),bar:{visible:install.installed||installStarted}}};
 if(window&&!window.isDestroyed())window.webContents.send('launcher:state',state);
}
// Nothing is transferring after this: the bar falls back to PLAY NOW or the
// sign-in action through `actions`, and the phase returns to the resting value.
function settle(message,extra={}){phase=null;progress=null;control=null;notify({message,device:null,...extra});}
async function refreshClient(){client=await clientStatus(gameRoot());}
function secureStorageAvailable(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
const vaultOptions=()=>({safeStorage,platform:process.platform});
async function saveSession(){
 if(!session)return;
 const remember=secureStorageAvailable();
 if(remember){
  await fs.mkdir(configRoot(),{recursive:true});
  const temp=vaultFile()+'.tmp';
  await fs.writeFile(temp,safeStorage.encryptString(JSON.stringify(session)),{mode:0o600});
  await fs.rename(temp,vaultFile());
 }else await fs.rm(vaultFile(),{force:true});
 notify({remembered:remember});
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
// Enrol or sign in with the Mojang access token the launcher already holds.
async function enrolAccount({announce=true,throwOnError=false}={}){
 try{
  const signed=await accounts.login(session.accessToken);
  company=companySession(signed);
  if(signed.created)notify({message:'Easter Company account created.'});
  else if(announce)notify({message:'Signed in to your Easter Company account.'});
 }catch(error){
  if(error.name==='AbortError')throw error;
  // The Microsoft session stays usable; only the account step failed.
  notify({message:error.message||'The Easter Company account could not be signed in.'});
  if(throwOnError)throw error;
 }finally{await saveCompany();}
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
 working=true;
 try{return await action();}catch(error){
  const message=safeError(error);
  if(error.name!=='CancelledError')settle(message,{device:null});
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
   notify({message:'Download cancelled. Nothing already installed was changed.',device:null});
   return null;
  }
  throw error;
 }finally{control=null;}
}
async function runInstall({includeGraphics=Boolean(settings.includeGraphics)}={}){
 return withControl(async()=>{
  const result=await installClient({root:gameRoot(),settings,notify,control,mode:'install',includeGraphics});
  await refreshClient();
  settle(result.message||'Client ready.');
  return result;
 });
}
// The same pipeline and the same reporting as a first install. A check that finds
// nothing publishes nothing: withControl only sets the flag, and checkForUpdates
// does not notify at all unless it is going to do work.
async function runUpdate(){
 return withControl(async()=>{
  const result=await checkForUpdates({root:gameRoot(),settings,notify,control,includeGraphics:Boolean(settings.includeGraphics)});
  await refreshClient();
  if(result.applied)settle(result.result?.message||'Client updated.');
  return result;
 });
}
async function login(){
 controller=new AbortController();
 notify({message:'Opening Microsoft sign-in…',device:null,...(control?{}:{progress:null})});
 try{
  session=await auth.signIn(device=>notify({device,message:'Enter this code on Microsoft’s sign-in page.'}),controller.signal);
  await saveSession();await enrolAccount();
  notify({device:null,message:'Welcome aboard, '+session.profile.name+'.'});
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
 if(!session)await login();
 notify({phase:'launching',message:'Checking your Minecraft session…',device:null,progress:null});
 try{session=await auth.refresh(session);}catch(error){
  if(!['invalid_grant','invalid_request','unauthorized_client'].includes(error.code))throw error;
  session=null;company=null;await fs.rm(vaultFile(),{force:true});await vault.remove(companyFile());await login();
 }
 await saveSession();
 // The Mojang token is the enrolment credential: every sign-in re-posts it, so a
 // session the API has forgotten or revoked is reissued here instead of on launch.
 await enrolAccount({announce:false});
 const prepared=await ensureClient();
 const record=client.record;
 const version=prepared?.version||record?.version;
 const javaPath=settings.javaPath||prepared?.javaPath||record?.java;
 if(!version||!javaPath)throw Error('The game client is not installed yet.');
 notify({phase:'launching',message:'Setting sail…',progress:null});
 const child=await launch(launchOptions({root:gameRoot(),version,javaPath,session,settings}));
 game=child;
 // Do not store launch arguments or raw stdout; Minecraft writes its own latest.log.
 child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
 child.once('error',()=>{game=null;notify({message:'Minecraft could not start. Check Java and try again.',progress:null});});
 child.once('exit',code=>{game=null;notify({message:code===0?'Welcome back. Ready for another voyage?':'Minecraft closed with code '+code+'. Its log is in the client folder.',progress:null});});
 notify({phase:'running',message:'Minecraft is running. Your map stays right here.',progress:null});
}
function registerIPC(){
 const handle=(name,fn)=>ipcMain.handle('launcher:'+name,async(event,...args)=>{
  if(!trustedFrame(event))throw Error('Untrusted launcher request.');
  try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:safeError(error)};}
 });
 handle('status',()=>({...state,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null,settings,totalMemoryMB:Math.floor(os.totalmem()/1024/1024),version:APP_VERSION,authName:clientId===DEFAULT_CLIENT_ID?'Prism Launcher':'Easter Company'}));
 handle('sign-in',async()=>{
  if(controller)throw Error('Microsoft sign-in is already running.');
  // Authentication can overlap the install pipeline, but never starts a second
  // pipeline or clears its progress when authentication fails or is cancelled.
  if(control){
   try{return await login();}
   catch(error){notify({message:safeError(error),device:null});throw error;}
  }
  return exclusively(login);
 });
 handle('cancel-sign-in',()=>controller?.abort());
 handle('sign-out',async()=>{if(working)throw Error('Wait for the current operation to finish.');session=null;await forgetCompany();await fs.rm(vaultFile(),{force:true});notify({remembered:false,device:null,message:'Signed out on this device.'});});
 // Re-issues the account session from the Mojang token the launcher already has.
 handle('account-refresh',()=>exclusively(async()=>{if(!session)throw Error('Sign in first.');await enrolAccount({throwOnError:true});return publicAccount(company);}));
 // Company account only: the Microsoft session on this device is kept.
 handle('account-sign-out',async()=>{if(working)throw Error('Wait for the current operation to finish.');await forgetCompany();notify({message:'Signed out of your Easter Company account.'});});
 handle('play',async()=>{if(backgroundUpdate)await backgroundUpdate;return exclusively(play);});
 handle('settings',async input=>{
  if(working||game)throw Error('Close Minecraft and wait for the current operation before changing settings.');
  // The location is never taken from this handler: it comes from the folder
  // picker or the saved setting, nowhere else.
  settings={...cleanSettings(input,Math.floor(os.totalmem()/1024/1024)),location:settings.location,includeGraphics:'includeGraphics' in input?Boolean(input.includeGraphics):settings.includeGraphics};
  await atomicJSON(settingsFile(),settings);return settings;
 });
 handle('choose-java',async()=>{const selected=await dialog.showOpenDialog(window,{title:'Choose Java 25 executable',properties:['openFile'],filters:process.platform==='win32'?[{name:'Java',extensions:['exe']}]:[]});return selected.canceled?null:selected.filePaths[0];});
 // The picker is the only source of a new installation folder.
 handle('choose-location',async()=>{
  if(working||game)throw Error(game?'Minecraft is already running.':'Wait for the current operation to finish.');
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
  if(working||game)throw Error('Wait for the current operation to finish.');
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
 window=new BrowserWindow({width:1360,height:920,minWidth:800,minHeight:600,backgroundColor:'#10232b',title:'Easter Company',icon:path.join(siteRoot,'assets/favicon.png'),show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
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
 backgroundUpdate=exclusively(runUpdate).catch(()=>{}).finally(()=>{backgroundUpdate=null;});
}
if(instance){
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
 app.whenReady().then(async()=>{
  await fs.mkdir(configRoot(),{recursive:true});
  let stored={};
  try{stored=JSON.parse(await fs.readFile(settingsFile(),'utf8'));}catch{}
  try{settings={...defaultSettings,...cleanSettings(stored,Math.floor(os.totalmem()/1024/1024))};}catch{settings={...defaultSettings};}
  // The saved location is a path this launcher wrote itself after the picker
  // validated it. It is never taken from anywhere else.
  if(typeof stored.location==='string'&&path.isAbsolute(stored.location))settings.location=path.resolve(stored.location);
  settings.includeGraphics='includeGraphics' in stored?Boolean(stored.includeGraphics):defaultSettings.includeGraphics;
  if(secureStorageAvailable())try{session=JSON.parse(safeStorage.decryptString(await fs.readFile(vaultFile())));if(!session?.refreshToken||!session?.profile)session=null;else state.remembered=true;}catch{}
  // Restore the Easter Company session from the vault without a network call, so
  // launch never waits on the account API. Sign-in and play re-issue it.
  company=storedSession(await vault.readEncrypted(companyFile(),vaultOptions()));
  if(company&&company.expiresAt<=Date.now())company=null;
  await refreshClient();
  protocol.handle('easter',resource);registerIPC();createWindow();
  notify({message:client.installed?'Client ready.':'Your crew is waiting.'});
  updateOnLaunch();
 });
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',()=>{controller?.abort();control?.cancel();});
}
