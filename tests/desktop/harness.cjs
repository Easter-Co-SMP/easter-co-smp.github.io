// This entry point is excluded from desktop packages. No production test bypass.
const {EventEmitter}=require('node:events');
const companyFixture=require('./account-fixture.cjs');companyFixture.install();
const auth=require('../../desktop/auth.cjs');
auth.MicrosoftAuth=class{
 async signIn(notify,signal,onStage){
  global.easterTestAuthStage=onStage;
  global.easterTestDevice=notify;
  // One flag: Microsoft's sign-in page is open in the player's browser. The code this fixture
  // used to hand over is gone with the flow that printed it.
  notify({browser:true});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  return {...companyFixture.proof('1234567890abcdef1234567890abcdef','TestCaptain'),profile:{id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
 // The page main already opened, opened again (the launcher's open-microsoft command). A stub
 // browser has nothing to re-open; what matters is that the command reaches the sign-in rather
 // than opening an address of its own.
 async reopen(){global.easterTestReopens=(global.easterTestReopens||0)+1;return true;}
};
const install=require('../../desktop/install.cjs');
let installed=false;
const record=()=>({version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'});
install.clientStatus=async()=>({installed,version:installed?'fixture-2.0.0':null,updatedAt:installed?'2026-10-15T00:00:00.000Z':null,record:installed?record():null});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.installClient=async({notify,control,includeGraphics=false})=>{
 let progress=0;
 global.easterTestFinishDownload=()=>notify({phase:'ready',message:'Client ready.',progress:null});
 global.easterTestDownloadProgress=()=>notify({phase:'downloading',message:'Downloading the test client',progress:{label:'Downloading the test client',percent:++progress%100,bytesDone:progress,bytesTotal:1000,bytesPerSecond:250,etaSeconds:4}});
 notify({phase:'downloading',message:'Downloading the test client',progress:{label:'Downloading the test client',percent:50,bytesDone:50,bytesTotal:100,bytesPerSecond:null,etaSeconds:null}});
 await new Promise(resolve=>setTimeout(resolve,150));
 await control?.gate();
 installed=true;
 return {version:'fixture-fabric',javaPath:'/fixture/java',includeGraphics,message:'Client ready.'};
};
install.launch=async()=>{const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
