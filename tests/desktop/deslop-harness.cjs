const companyFixture=require('./account-fixture.cjs');companyFixture.install();
const auth=require('../../desktop/auth.cjs');
let index=0;
auth.MicrosoftAuth=class{
 async signIn(notify,signal){
  if(global.easterTestDelayDevice)await new Promise((resolve,reject)=>{
   const abort=()=>reject(new DOMException('Cancelled','AbortError'));
   global.easterTestDeviceReady=()=>{signal.removeEventListener('abort',abort);resolve();};
   signal.addEventListener('abort',abort,{once:true});
  });
  notify({code:'TEST',url:'https://microsoft.com/link',expiresAt:Date.now()+60000});
  await new Promise((resolve,reject)=>{global.easterTestApprove=resolve;signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});
  index++;
  return {...companyFixture.proof(String(index).padStart(32,'0'),'Captain'+index),profile:{id:String(index).padStart(32,'0'),name:'Captain'+index,skinURL:'https://invalid.test/skin',skin:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQUlEQVR4nO3QwQkAIAwEwdRpOVZnV6YC8xORzMD9j40AADhYc+xqr/9dJ4AAAggggACNAwAAAAAAAAAAAAAAAN9JOwCowfTmxIQAAAAASUVORK5CYII='},accessToken:'fixture',refreshToken:'fixture',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
};

const install=require('../../desktop/install.cjs');
let installed=false;
install.clientStatus=async()=>({installed,version:'fixture',record:installed?{version:'fixture',java:'/fixture/java'}:null});
install.checkForUpdates=async()=>{if(global.easterClientUpdateFail)throw Error('Game manifest unavailable.');return {applied:false};};
install.installClient=async({notify})=>{notify({phase:'downloading',progress:{percent:50}});installed=true;return {message:'Client ready.'};};
install.launch=async()=>{if(global.easterTestFailPlay)throw Error('Unable to start Minecraft. Try again.');const {EventEmitter}=require('node:events');global.easterTestGame=new EventEmitter();return global.easterTestGame;};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
