// This entry point is excluded from desktop packages. No production test bypass.
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
install.prepare=async(_root,_settings,notify)=>{
 notify({phase:'installing',message:'Verifying test client',progress:50});
 await new Promise(resolve=>setTimeout(resolve,150));
 return {version:'fixture-fabric',javaPath:'/fixture/java'};
};
install.launch=async()=>{const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
require('../../desktop/main.cjs');
