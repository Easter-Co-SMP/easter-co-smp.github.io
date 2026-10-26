'use strict';
// A journey entry point for the Microsoft hand-over (ticket 3027a681, doc/launcher-states.md
// "The hand-over, exactly once"). The Microsoft legs are a fixture in this process, the
// account service is the REAL one (/root/easter-co-cloud/tests/launcher_api_fixture.py, behind
// the journey's recording proxy), the game install and the game process are stubs.
//
// What this harness adds over the others: a Microsoft fixture that behaves like Microsoft
// (tests/desktop/microsoft-fixture.cjs — single-use refresh tokens, and a replacement only
// when offline_access was asked for), whose view of the world is kept in a file under
// EASTER_TEST_HOME so a SECOND launch of the same install can be told whether the token the
// first launch handed over is still one Microsoft would accept. Every other harness answers
// a fresh refresh token on every grant, which is exactly why nothing in the suite saw this
// defect.
//
// EASTER_VAULT_FIXTURE_KEY installs an explicit test-only AES-GCM safeStorage, because the
// isolated X session has no OS keyring and one of the criteria is about what the encrypted
// vault no longer carries.
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {safeStorage}=require('electron');
if(process.env.EASTER_VAULT_FIXTURE_KEY){
 const crypto=require('node:crypto'),key=Buffer.from(process.env.EASTER_VAULT_FIXTURE_KEY,'hex');
 safeStorage.isEncryptionAvailable=()=>true;
 safeStorage.getSelectedStorageBackend=()=>'fixture-encrypted';
 safeStorage.encryptString=value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);};
 safeStorage.decryptString=value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');};
}
const home=process.env.EASTER_TEST_HOME;
const stateFile=path.join(home,'microsoft-state.json');
const load=()=>{try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return null;}};
const {createMicrosoft}=require('./microsoft-fixture.cjs');
const microsoft=createMicrosoft({
 mode:process.env.EASTER_HANDOVER_MODE||'unproven',
 uhs:process.env.EASTER_HANDOVER_UHS||'123456789',
 state:load(),
 persist:next=>fs.writeFileSync(stateFile,JSON.stringify(next))
});
global.easterHandoverSignIns=0;
const auth=require('../../desktop/auth.cjs'),Original=auth.MicrosoftAuth;
auth.MicrosoftAuth=class extends Original{
 constructor(options){
  super({...options,request:microsoft.request,wait:async(_ms,_value,{signal})=>new Promise((resolve,reject)=>{
   const abort=()=>reject(new DOMException('Cancelled','AbortError'));
   global.easterHandoverApprove=()=>{signal.removeEventListener('abort',abort);resolve();};
   signal.addEventListener('abort',abort,{once:true});
  })});
 }
 async signIn(notify,signal,onStage){
  // Counted, not replaced: the journey's own assertions are about how many Microsoft
  // sign-ins one launch started.
  global.easterHandoverSignIns++;
  // THE BROWSER IS THE JOURNEY'S `easterHandoverApprove` PRESS. This hook used to live in the
  // `wait` callback above, which only the device-code poll ever called; the browser sign-in
  // never waits there, so the hook has to be published where the flow now stops for the
  // player — the moment the browser is handed the address. It answers that address over the
  // launcher's own loopback socket, with a code Microsoft issued for this sign-in's state and
  // PKCE challenge, exactly as the fixture's other browser leg does.
  const real=this.openExternal;
  this.openExternal=async url=>{
   await new Promise(resolve=>{global.easterHandoverApprove=resolve;});
   const answer=await microsoft.browser(url);
   if(answer.status!==200)throw Error('the fixture browser could not reach the launcher');
  };
  try{return await super.signIn(notify,signal,onStage);}
  finally{this.openExternal=real;}
 }
};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture-fabric',updatedAt:'2026-10-19T00:00:00.000Z',record:{version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'}});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.installClient=async()=>({version:'fixture-fabric',javaPath:'/fixture/java',message:'Client ready.'});
install.launch=async options=>{
 global.easterHandoverLaunch=options;
 const game=new EventEmitter();
 game.stdout=new EventEmitter();game.stderr=new EventEmitter();
 global.easterHandoverGame=game;
 return game;
};
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});
visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
