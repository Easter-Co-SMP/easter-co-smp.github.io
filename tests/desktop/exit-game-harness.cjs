// Excluded from desktop packages. Drives the real desktop/main.cjs, so Exit Game can be pressed in a
// live main process against a real process.
//
// What is stubbed, and nothing else: the account service (`AccountClient` — see
// tests/desktop/account-fixture.cjs) and the client pipeline (`clientStatus`, `checkForUpdates`,
// `installClient`, `launch`), plus the two launcher-update questions, which are answered "current"
// without the network. Everything behind those boundaries is the real thing: main.cjs, the marker
// `desktop/game-marker.cjs` writes, the signals, and every process below — each spawned detached
// with the launcher's own `execOptions()`, so the stand-in for java has java's shape as far as this
// launcher is concerned (its own session, no inherited pipe, and a pid the operating system reports
// a start time for).
//
// Three switches belong to the journey. Nothing in the product reads any of them:
//
//   * `EASTER_GAME_IGNORES_SIGTERM` — the spawned stand-in for java swallows SIGTERM, which is the
//     only way to prove the second half of Owen's instruction ("backup force quit"): a polite ask
//     with a very short bound, and then a kill.
//   * `global.easterServiceDown` — every account-service call fails. Owen's requirement is that Exit
//     Game works "with the account service unreachable, because it is local process control and
//     nothing else", so the journey needs a service that really does fail.
//   * `global.easterServiceCalls` — how many account-service calls have been made in total, so the
//     journey can prove the exit path made none rather than assert it from the source.
'use strict';
const {spawn}=require('node:child_process');
const companyFixture=require('./account-fixture.cjs');
companyFixture.install();
// The account service as this launcher's client reaches it, wrapped so that a journey can break the
// service and count the requests that reached it. A class, so the wrap is on the prototype every
// instance shares — the real AccountClient's shape, with a switch in front of it.
const accounts=require('../../desktop/accounts.cjs');
global.easterServiceCalls=0;
global.easterServiceDown=false;
for(const name of Object.getOwnPropertyNames(accounts.AccountClient.prototype)){
 if(name==='constructor')continue;
 const real=accounts.AccountClient.prototype[name];
 if(typeof real!=='function')continue;
 accounts.AccountClient.prototype[name]=function(...args){
  global.easterServiceCalls+=1;
  // A refused connection is what an unreachable service looks like from here, and it is the shape
  // the launcher's own error handling already knows.
  if(global.easterServiceDown)throw Object.assign(Error('connect ECONNREFUSED 127.0.0.1:1'),{code:'ECONNREFUSED'});
  return real.apply(this,args);
 };
}
const auth=require('../../desktop/auth.cjs');
let index=0;
auth.MicrosoftAuth=class{
 async reopen(){return true;}
 async signIn(notify,signal){
  notify({browser:true});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  index++;
  return {...companyFixture.proof(String(index).padStart(32,'0'),'Captain'+index),profile:{id:String(index).padStart(32,'0'),name:'Captain'+index},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
};
const install=require('../../desktop/install.cjs');
let installed=false;
install.clientStatus=async()=>({installed,version:installed?'fixture-2.0.0':null,updatedAt:installed?'2026-10-15T00:00:00.000Z':null,record:installed?{version:'fixture-fabric',java:'/fixture/java'}:null});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.installClient=async()=>{installed=true;return {version:'fixture-fabric',javaPath:'/fixture/java',message:'Client ready.'};};
// The game, as a real process. The options are the launcher's own, so "it is detached with no
// inherited pipe" is measured on the options under test rather than a paraphrase of them.
global.easterSpawnOptions=install.execOptions(null);
global.easterTestLaunch=()=>{
 const source=process.env.EASTER_GAME_IGNORES_SIGTERM==='1'
  ?'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
  :'setInterval(()=>{},1000)';
 const child=spawn(process.execPath,['-e',source],{...global.easterSpawnOptions,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 global.easterGamePid=child.pid;
 global.easterTestGame=child;
 return child;
};
install.launch=async()=>global.easterTestLaunch();
// Both launcher-update questions answered without a single request: this journey is about a game
// ending, and a poll that reached the network would only add noise to it.
const updater=require('../../desktop/updater.cjs');
updater.update=async({current,notify})=>{notify({phase:'current',version:current,percent:null,message:null});return null;};
updater.createLauncherPoll=()=>({probes:0,stop(){}});
// No client tree exists to configure in this harness.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});
visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
