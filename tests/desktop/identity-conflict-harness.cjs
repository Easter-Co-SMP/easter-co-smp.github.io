// The saved-session shortcut and the identity conflict it can stop on, driven through the
// product's own preload, the product's own main process and a loopback account service that
// speaks the frozen account contract. Nothing in the renderer is stubbed: the point of the
// journey this harness serves is that the refusal code crosses the real isolated-world
// boundary, which a stub bridge cannot show.
//
// It differs from tests/desktop/harness.cjs in exactly one way: the interactive Microsoft
// sign-in is counted, so "no second sign-in call is made" is a measurement in the main
// process rather than something inferred from the screen.
// This entry point is excluded from desktop packages. No production test bypass.
const {EventEmitter}=require('node:events');
const companyFixture=require('./account-fixture.cjs');companyFixture.install();
// The Microsoft identity the fixture player signs in with, and the proof the saved session
// carries. Unchanged from the shared harness so both journeys describe the same player.
const ID='1234567890abcdef1234567890abcdef';
global.identityConflictSignIns=0;
const auth=require('../../desktop/auth.cjs');
auth.MicrosoftAuth=class{
 async signIn(notify,signal){
  // Every interactive sign-in — the first one and the one a fall-through would start —
  // passes through here, so this counter is what tells a stop from a silent second flow.
  global.identityConflictSignIns+=1;
  notify({code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  return {...companyFixture.proof(ID,'TestCaptain'),profile:{id:ID,name:'TestCaptain'},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 // A saved Microsoft session is re-issued from the vault without asking anyone anything,
 // which is the whole premise of the shortcut.
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
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
