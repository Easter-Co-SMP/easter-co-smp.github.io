// This entry point is excluded from desktop packages. No production test bypass.
// Drives the real desktop/main.cjs with a stubbed account provider and a stubbed
// client pipeline, so the launcher state contract can be observed in a live main
// process without a real Mojang or Modrinth download.
const {EventEmitter}=require('node:events');
const auth=require('../../desktop/auth.cjs');
auth.MicrosoftAuth=class{
 async signIn(notify,signal){
  notify({code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  return {profile:{id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
};
const install=require('../../desktop/install.cjs');
let installed=false;
let graphicsPublished=false;
install.clientStatus=async()=>({installed,version:installed?'fixture-2.0.0':null,updatedAt:installed?'2026-10-15T00:00:00.000Z':null,record:installed?{version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'}:null});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
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
install.launch=async()=>{const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
require('../../desktop/main.cjs');
