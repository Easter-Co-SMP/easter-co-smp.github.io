// The launcher as a returning player meets it: a packaged build, its own update check
// already answered "current", and an installed client whose game update is still being
// verified. That is the moment the home screen mounts and asks for its editorial content,
// and the moment the mandatory-update gate is still closed.
//
// The verify is held on a promise this suite resolves, so the state under test is a fact
// rather than a race won by a fast machine (doc/launcher-discovery.md, "The startup gate").
// Only the update check, the client status and the verify are fixtures: main.cjs, the
// preload, site/ and desktop/discovery.cjs are the real ones, and the document is served
// from a loopback origin the way the published one is served.
const {app}=require('electron');
Object.defineProperty(app,'isPackaged',{value:true});
app.setPath('appData',process.env.EASTER_TEST_HOME);
global.easterClientVerifyStarted=false;
global.easterClientVerifyHeld=new Promise(resolve=>{global.easterClientVerifyContinue=resolve;});
require('../../desktop/updater.cjs').update=async({notify})=>{notify({phase:'current',version:'fixture',message:null});return null;};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture-fabric',record:{version:'fixture-fabric',java:'/fixture/java'}});
install.checkForUpdates=async()=>{global.easterClientVerifyStarted=true;await global.easterClientVerifyHeld;return {applied:false};};
install.launch=async()=>{throw Error('no game runs in this suite');};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
