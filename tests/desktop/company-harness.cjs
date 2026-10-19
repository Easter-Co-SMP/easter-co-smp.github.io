const {EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
global.companyMode='owned';global.companyUser='1';global.companyLaunches=0;
const auth=require('../../desktop/auth.cjs'),Original=auth.MicrosoftAuth;
const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
auth.MicrosoftAuth=class extends Original{
 constructor(options){super({...options,request:async url=>{
  const uhs=process.env.EASTER_IDENTITY_FIXTURE_SEED+global.companyUser;
  if(url.endsWith('/devicecode'))return json({device_code:'fixture-private-device',user_code:'COMPANY-TEST',verification_uri:'https://microsoft.com/link',expires_in:600});
  // The access token is derived from the identity, because the backend now stores a
  // Microsoft-verified email as a second login key and the fixture derives that address
  // from this token: one fixed token for every identity would give two synthetic players
  // the same address and the second signup would be an identity_conflict.
  if(url.endsWith('/token'))return json({access_token:'fixture-private-ms-'+uhs,refresh_token:'fixture-private-refresh-'+uhs});
  if(url.includes('/user/authenticate'))return json({Token:'fixture-xbox:'+uhs+':'+global.companyMode,NotAfter:new Date(Date.now()+86400000).toISOString()});
  if(url.includes('/xsts/authorize'))return json({Token:'fixture-private-xsts',DisplayClaims:{xui:[{uhs}]}});
  if(url.includes('/authentication/login_with_xbox'))return json({access_token:'fixture-private-minecraft',expires_in:86400});
  if(url.includes('/entitlements/license'))return json({items:global.companyMode==='missing'?[]:[{name:'game_minecraft'}]});
  if(url.endsWith('/minecraft/profile'))return json({id:createHash('sha256').update(uhs).digest('hex').slice(0,32),name:'FixtureCaptain',skins:[{state:'ACTIVE',url:'https://invalid.test/skin'}]});
  throw Error('Unexpected fixture request.');
 },wait:async(_ms,_value,{signal})=>new Promise((resolve,reject)=>{
  const abort=()=>reject(new DOMException('Cancelled','AbortError'));
  global.companyApprove=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});
 })});}
};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture',record:{version:'fixture',java:'/fixture/java'}});
install.checkForUpdates=async()=>({applied:false});
install.launch=async()=>{global.companyLaunches++;global.companyGame=new EventEmitter();return global.companyGame;};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
