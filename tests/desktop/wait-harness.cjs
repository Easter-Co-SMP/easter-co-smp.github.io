'use strict';
// This entry point is excluded from desktop packages. No production test bypass.
//
// Only the Microsoft side is stubbed: the browser sign-in names its stages and then waits for
// the test to approve it, exactly as desktop/auth.cjs does when a player finishes on
// Microsoft's page. Everything after that is the real launcher against the real account
// service - desktop/main.cjs, desktop/accounts.cjs, the state channel and site/desktop.js -
// which is the part the post-approval report is about.
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const auth=require('../../desktop/auth.cjs');
// The same message table the main process uses, so the stage sentences this harness sends
// are the launcher's own words rather than the harness's.
const STAGES={
 'microsoft-opening':'Opening Microsoft sign-in…',
 'microsoft-waiting':'Complete sign-in on Microsoft’s page.',
 'microsoft-verifying':'Verifying your Microsoft sign-in…'
};
const UHS=process.env.EASTER_WAIT_UHS||'123456789';
auth.MicrosoftAuth=class{
 async signIn(notify,signal,onStage){
  onStage?.('microsoft-opening');
  // One flag crosses over and nothing else: Microsoft's sign-in page is open in the player's
  // browser. No code, no address, no token.
  notify({browser:true});
  onStage?.('microsoft-waiting');
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=()=>{onStage?.('microsoft-verifying');resolve();};
   signal?.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled'),{name:'AbortError'})),{once:true});
  });
  // The proof the account fixture's synthetic provider accepts, minted for this run.
  return {xboxUserToken:'fixture-xbox:'+UHS+':',xboxExpiresAt:Date.now()+86400000,
   companySubject:createHash('sha256').update('xbox-uhs:'+UHS).digest('hex'),
   profile:{id:createHash('sha256').update(UHS).digest('hex').slice(0,32),name:'FixtureCaptain'},
   accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(session){return session;}
 async reopen(){return true;}
};
// The skin service is not part of this proof, and a launcher must never wait for it. Only
// remote fetches are refused: the easter:// protocol handler reads the bundled site/ through
// net.fetch as well, and that must keep working.
const {net}=require('electron');
const localFetch=net.fetch.bind(net);
net.fetch=async (resource,options)=>{
 const url=typeof resource==='string'?resource:resource instanceof URL?resource.href:String(resource?.url||'');
 if(/^(file|easter):/i.test(url))return localFetch(resource,options);
 throw Object.assign(new Error('offline fixture'),{name:'TypeError'});
};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture-2.0.0',updatedAt:'2026-10-15T00:00:00.000Z',record:{version:'fixture-fabric',mod:'fixture-2.0.0',java:'/fixture/java'}});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
install.launch=async()=>{const game=new EventEmitter();game.stdout=new EventEmitter();game.stderr=new EventEmitter();global.easterTestGame=game;return game;};
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
