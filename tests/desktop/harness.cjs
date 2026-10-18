// This entry point is excluded from desktop packages. No production test bypass.
const {EventEmitter}=require('node:events');
const companyFixture=require('./account-fixture.cjs');companyFixture.install();
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
let installed=false;
const record=()=>({version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'});
install.clientStatus=async()=>({installed,version:installed?'fixture-2.0.0':null,updatedAt:installed?'2026-10-15T00:00:00.000Z':null,record:installed?record():null});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.installClient=async({notify,control,includeGraphics=false})=>{
 notify({phase:'downloading',message:'Downloading the test client',progress:{label:'Downloading the test client',percent:50,bytesDone:50,bytesTotal:100,bytesPerSecond:null,etaSeconds:null}});
 await new Promise(resolve=>setTimeout(resolve,150));
 await control?.gate();
 installed=true;
 return {version:'fixture-fabric',javaPath:'/fixture/java',includeGraphics,message:'Client ready.'};
};
install.launch=async()=>{const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
require('../../desktop/main.cjs');
