// This entry point is excluded from desktop packages. No production test bypass.
// Drives the real desktop/main.cjs with a stubbed account provider and a stubbed
// client pipeline, so the launcher state contract can be observed in a live main
// process without a real Mojang or Modrinth download.
const {EventEmitter}=require('node:events');
const companyFixture=require('./account-fixture.cjs');companyFixture.install();
// A test-owned readiness fixture. It is never packaged and uses no network.
global.easterTestServerState='running';global.easterTestWakes=0;
const fixtureAccounts=require('../../desktop/accounts.cjs').AccountClient;
fixtureAccounts.prototype.gameStatus=async()=>{
 if(global.easterTestServerState==='unreachable')throw Error('Fixture service unavailable.');
 return require('../../desktop/game.cjs').sanitizeGameStatus({state:global.easterTestServerState,ready:global.easterTestServerState==='running',endpoint:require('../../desktop/config.cjs').serverAddress()});
};
fixtureAccounts.prototype.wakeGame=async function(){global.easterTestWakes++;return this.gameStatus();};
const auth=require('../../desktop/auth.cjs');
auth.MicrosoftAuth=class{
 async signIn(notify,signal){
  notify({code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  return {...companyFixture.proof('1234567890abcdef1234567890abcdef','TestCaptain'),profile:{id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
};
const install=require('../../desktop/install.cjs');
// The second launch in flow.electron.mjs starts with an install already present.
let installed=process.env.EASTER_FLOW_INSTALLED==='1';
let graphicsPublished=false;
install.clientStatus=async()=>({installed,version:installed?'fixture-2.0.0':null,updatedAt:installed?'2026-10-15T00:00:00.000Z':null,record:installed?{version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'}:null});
// Counted so the launch-time update check can be asserted from the main process.
global.easterTestUpdateChecks=0;
install.checkForUpdates=async()=>{global.easterTestUpdateChecks++;return {checked:true,changed:false,applied:false,changes:[],result:null};};
// Steps through the contract's own progress shape, parking on the real control so
// pause, resume and cancel behave exactly as they do around a real transfer.
install.installClient=async({notify,control,includeGraphics=false})=>{
 let percent=0;
 const report=()=>notify({phase:'downloading',message:'Downloading the game',progress:{label:'Downloading the game',percent,bytesDone:percent*10,bytesTotal:1000,bytesPerSecond:percent?250:null,etaSeconds:percent?Math.round((1000-percent*10)/250):null}});
 report();
 while(percent<100){
  await control?.gate();
  await new Promise(resolve=>setTimeout(resolve,80));
  percent+=10;
  report();
 }
 installed=true;
 return {version:'fixture-fabric',javaPath:'/fixture/java',includeGraphics,graphics:graphicsPublished?'fixture-hash':'not-published',message:graphicsPublished?'Client ready. Enhanced graphics installed.':'Client ready. Enhanced graphics are not published yet, so the client was installed without them.'};
};
// Counted so the game shortcut can be shown to start exactly one game, and none at all
// when something still needs the player.
global.easterTestLaunches=0;
install.launch=async()=>{global.easterTestLaunches++;const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
