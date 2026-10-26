'use strict';
// A journey entry point for the store snapshot the launcher fetches at startup (ticket 9f6d7b16,
// doc/launcher-store.md "Opening the store instantly"). It is a fixture of the same kind the other
// journeys use: the Microsoft legs are answered in-process, the game install and the game process
// are stubs, and the account service is a real loopback HTTP stub the journey starts itself through
// EASTER_API_BASE_URL — so the launcher's real AccountClient, its HTTPS-only origin rule and its
// real retry rules are what runs, not a pretend one. The store routes are part of that stub, so the
// catalogue and the orders the launcher caches are read over the same client the store page uses.
//
// EASTER_VAULT_FIXTURE_KEY installs an explicit test-only AES-GCM safeStorage, because the isolated
// X session has no OS keyring and a journey that starts the launcher twice needs the Company
// session restored from its vault on the second start. Production refusal of basic_text is
// untouched.
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {safeStorage}=require('electron');
if(process.env.EASTER_VAULT_FIXTURE_KEY){
 const crypto=require('node:crypto'),key=Buffer.from(process.env.EASTER_VAULT_FIXTURE_KEY,'hex');
 safeStorage.isEncryptionAvailable=()=>true;
 safeStorage.getSelectedStorageBackend=()=>'fixture-encrypted';
 safeStorage.encryptString=value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);};
 safeStorage.decryptString=value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');};
}
// One Microsoft identity, approved by hand in the journey. Every token below is a fixture string;
// nothing reaches Microsoft.
global.easterStoreSignIns=0;
const auth=require('../../desktop/auth.cjs'),Original=auth.MicrosoftAuth;
const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
const uhs='fixture-uhs-0123456789abcdef0123456789abcdef';
auth.MicrosoftAuth=class extends Original{
 constructor(options){
  super({...options,request:async url=>{
  // The redirect check (desktop/auth.cjs, checkRedirectAccepted): the measured answer for a
  // registered loopback address is Microsoft's own sign-in page, which proves nothing and must
  // never stop a sign-in.
  if(url.includes('/oauth2/v2.0/authorize?')||String(url).startsWith('https://login.live.com/'))return {ok:true,status:200,json:async()=>({}),text:async()=>'<html>Microsoft account requires JavaScript to sign in.</html>',headers:{get:()=>null}};
    if(url.endsWith('/token'))return json({access_token:'fixture-private-ms-'+uhs,refresh_token:'fixture-private-refresh-'+uhs});
   if(url.includes('/user/authenticate'))return json({Token:'fixture-xbox:'+uhs,NotAfter:new Date(Date.now()+86400000).toISOString()});
   if(url.includes('/xsts/authorize'))return json({Token:'fixture-private-xsts',DisplayClaims:{xui:[{uhs}]}});
   if(url.includes('/authentication/login_with_xbox'))return json({access_token:'fixture-private-minecraft-token',expires_in:86400});
   if(url.includes('/entitlements/license'))return json({items:[{name:'game_minecraft'}]});
   if(url.endsWith('/minecraft/profile'))return json({id:createHash('sha256').update(uhs).digest('hex').slice(0,32),name:'FixtureCaptain',skins:[]});
   throw Error('Unexpected fixture request.');
  },wait:async(_ms,_value,{signal})=>new Promise((resolve,reject)=>{
   const abort=()=>reject(new DOMException('Cancelled','AbortError'));
   global.easterTestApprove=()=>{signal.removeEventListener('abort',abort);resolve();};
   signal.addEventListener('abort',abort,{once:true});
  })});
 }
 async signIn(notify,signal,onStage){
  global.easterStoreSignIns++;
  // The browser is the journey's `easterTestApprove()` press: it answers the address the
  // launcher opened, over the launcher's own loopback socket.
  const real=this.openExternal;
  this.openExternal=async url=>{
   await new Promise(resolve=>{global.easterTestApprove=resolve;});
   const query=new URL(url).searchParams;
   const answer=await fetch(query.get('redirect_uri')+'?code=fixture-code-'+encodeURIComponent(uhs)+'&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
   if(!answer.ok)throw Error('the fixture browser could not reach the launcher');
  };
  try{return await super.signIn(notify,signal,onStage);}
  finally{this.openExternal=real;}
 }
};
// The client is installed and current, so the hero is Play from a cold start and the store's
// prefetch is what this harness is about rather than a download.
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture-fabric',updatedAt:'2026-10-19T00:00:00.000Z',record:{version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'}});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.installClient=async()=>({version:'fixture-fabric',javaPath:'/fixture/java',message:'Client ready.'});
install.launch=async options=>{
 global.easterStoreLaunch=options;
 const game=new EventEmitter();
 game.stdout=new EventEmitter();game.stderr=new EventEmitter();
 global.easterStoreGame=game;
 return game;
};
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});
visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
