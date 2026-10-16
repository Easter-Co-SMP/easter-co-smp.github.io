'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,shell,safeStorage,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {MicrosoftAuth,DEFAULT_CLIENT_ID}=require('./auth.cjs');
const {AccountClient,publicAccount,companySession,storedSession,companyVaultName}=require('./accounts.cjs');
const {apiOrigin}=require('./config.cjs');
const vault=require('./vault.cjs');
const {localFile,trustedFrame,externalURL,publicProfile,cleanSettings}=require('./security.cjs');
const {ORIGIN,atomicJSON,prepare,launchOptions,launch}=require('./install.cjs');
const APP_VERSION=require('../package.json').version;
app.setName('Easter Company');
protocol.registerSchemesAsPrivileged([{scheme:'easter',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
if(!app.isPackaged&&process.env.EASTER_TEST_HOME)app.setPath('userData',process.env.EASTER_TEST_HOME);
const instance=app.requestSingleInstanceLock();
if(!instance)app.quit();
let window,settings,session=null,working=false,game=null,controller,company=null;
const siteRoot=path.resolve(__dirname,'../site');
const configRoot=()=>app.getPath('userData');
const gameRoot=()=>path.join(configRoot(),'minecraft');
const settingsFile=()=>path.join(configRoot(),'settings.json');
const vaultFile=()=>path.join(configRoot(),'account.enc');
const companyFile=()=>path.join(configRoot(),companyVaultName());
const clientId=process.env.EASTER_MICROSOFT_CLIENT_ID||DEFAULT_CLIENT_ID;
const auth=new MicrosoftAuth({clientId});
const accounts=new AccountClient({baseUrl:apiOrigin(),client:'launcher/'+APP_VERSION});
const defaultSettings={memoryMB:Math.min(4096,Math.max(2048,Math.floor(os.totalmem()/1024/1024/2048)*1024)),javaPath:'',server:'100.100.1.0:25565'};
let state={phase:'idle',message:'Your crew is waiting.',progress:null,profile:null,remembered:false,account:null};
function notify(patch){state={...state,...patch,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null};if(window&&!window.isDestroyed())window.webContents.send('launcher:state',state);}
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
 if(error.code==='ENOSPC')return 'There is not enough disk space to install the client.';
 if(error.code==='EACCES')return 'The launcher cannot write to its client folder. Check its permissions.';
 if(error.name==='TypeError'||error.name==='TimeoutError')return 'The connection failed. Check your network and try again.';
 const message=String(error.message||'The operation could not finish.');
 return message.includes('token')||message.includes('Bearer')?'The session could not be refreshed. Please sign in again.':message.slice(0,350);
}
async function exclusively(action){
 if(working||game)throw Error(game?'Minecraft is already running.':'Another launcher operation is still running.');
 working=true;
 try{return await action();}catch(error){notify({phase:'error',message:safeError(error),progress:null,device:null});throw Error(safeError(error));}finally{working=false;}
}
async function login(){
 controller=new AbortController();
 notify({phase:'signing-in',message:'Opening Microsoft sign-in…',device:null,progress:null});
 try{
  session=await auth.signIn(device=>notify({device,message:'Enter this code on Microsoft’s sign-in page.'}),controller.signal);
  await saveSession();await enrolAccount();
  notify({phase:'idle',device:null,message:'Welcome aboard, '+session.profile.name+'.'});
 }finally{controller=undefined;}
}
async function play(){
 if(!session)await login();
 notify({phase:'refreshing',message:'Checking your Minecraft session…',device:null,progress:null});
 try{session=await auth.refresh(session);}catch(error){
  if(!['invalid_grant','invalid_request','unauthorized_client'].includes(error.code))throw error;
  session=null;company=null;await fs.rm(vaultFile(),{force:true});await vault.remove(companyFile());await login();
 }
 await saveSession();
 // The Mojang token is the enrolment credential: every sign-in re-posts it, so a
 // session the API has forgotten or revoked is reissued here instead of on launch.
 await enrolAccount({announce:false});
 const prepared=await prepare(gameRoot(),settings,notify);
 notify({phase:'launching',message:'Setting sail…',progress:null});
 const child=await launch(launchOptions({root:gameRoot(),...prepared,session,settings}));
 game=child;
 // Do not store launch arguments or raw stdout; Minecraft writes its own latest.log.
 child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
 child.once('error',()=>{game=null;notify({phase:'error',message:'Minecraft could not start. Check Java and try again.',progress:null});});
 child.once('exit',code=>{game=null;notify({phase:code===0?'idle':'error',message:code===0?'Welcome back. Ready for another voyage?':'Minecraft closed with code '+code+'. Its log is in the client folder.',progress:null});});
 notify({phase:'running',message:'Minecraft is running. Your map stays right here.',progress:null});
}
function registerIPC(){
 const handle=(name,fn)=>ipcMain.handle('launcher:'+name,async(event,...args)=>{
  if(!trustedFrame(event))throw Error('Untrusted launcher request.');
  try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:safeError(error)};}
 });
 handle('status',()=>({...state,profile:publicProfile(session),account:publicAccount(company),sessionExpiresAt:company?.expiresAt||null,settings,totalMemoryMB:Math.floor(os.totalmem()/1024/1024),version:APP_VERSION,authName:clientId===DEFAULT_CLIENT_ID?'Prism Launcher':'Easter Company'}));
 handle('sign-in',()=>exclusively(login));
 handle('cancel-sign-in',()=>controller?.abort());
 handle('sign-out',async()=>{if(working)throw Error('Wait for the current operation to finish.');session=null;await forgetCompany();await fs.rm(vaultFile(),{force:true});notify({phase:game?'running':'idle',remembered:false,device:null,message:'Signed out on this device.'});});
 // Re-issues the account session from the Mojang token the launcher already has.
 handle('account-refresh',()=>exclusively(async()=>{if(!session)throw Error('Sign in first.');await enrolAccount({throwOnError:true});return publicAccount(company);}));
 // Company account only: the Microsoft session on this device is kept.
 handle('account-sign-out',async()=>{if(working)throw Error('Wait for the current operation to finish.');await forgetCompany();notify({message:'Signed out of your Easter Company account.'});});
 handle('play',()=>exclusively(play));
 handle('settings',async input=>{if(working||game)throw Error('Close Minecraft and wait for the current operation before changing settings.');settings=cleanSettings(input,Math.floor(os.totalmem()/1024/1024));await atomicJSON(settingsFile(),settings);return settings;});
 handle('choose-java',async()=>{const selected=await dialog.showOpenDialog(window,{title:'Choose Java 25 executable',properties:['openFile'],filters:process.platform==='win32'?[{name:'Java',extensions:['exe']}]:[]});return selected.canceled?null:selected.filePaths[0];});
 handle('open-folder',async()=>{await fs.mkdir(gameRoot(),{recursive:true});const error=await shell.openPath(gameRoot());if(error)throw Error('Could not open the client folder.');});
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
    const response=await net.fetch(new URL(url.pathname+url.search,ORIGIN).href,{cache:'no-cache',signal:AbortSignal.timeout(12000)});
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
if(instance){
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
 app.whenReady().then(async()=>{
  await fs.mkdir(configRoot(),{recursive:true});
  try{settings=cleanSettings(JSON.parse(await fs.readFile(settingsFile(),'utf8')),Math.floor(os.totalmem()/1024/1024));}catch{settings=defaultSettings;}
  if(secureStorageAvailable())try{session=JSON.parse(safeStorage.decryptString(await fs.readFile(vaultFile())));if(!session?.refreshToken||!session?.profile)session=null;else state.remembered=true;}catch{}
  // Restore the Easter Company session from the vault without a network call, so
  // launch never waits on the account API. Sign-in and play re-issue it.
  company=storedSession(await vault.readEncrypted(companyFile(),vaultOptions()));
  if(company&&company.expiresAt<=Date.now())company=null;
  protocol.handle('easter',resource);registerIPC();createWindow();
 });
 app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',()=>controller?.abort());
}
