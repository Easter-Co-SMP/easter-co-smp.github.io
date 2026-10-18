// Dedicated transport fixtures; production auth/state/UI run unchanged.
const {EventEmitter}=require('node:events');
const {shell}=require('electron');
global.ownershipMode='missing';global.ownershipEnrols=0;global.ownershipLaunches=0;global.ownershipOpened=[];
shell.openExternal=async url=>{global.ownershipOpened.push(url);};
const auth=require('../../desktop/auth.cjs'),Original=auth.MicrosoftAuth;
const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
auth.MicrosoftAuth=class extends Original{
 constructor(options){super({...options,request:async url=>{
  if(url.endsWith('/devicecode'))return json({device_code:'fixture-private-device',user_code:'TEST-JAVA',verification_uri:'https://microsoft.com/link',expires_in:600});
  if(url.endsWith('/token'))return json({access_token:'fixture-private-ms',refresh_token:'fixture-private-refresh'});
  if(url.includes('/user/authenticate'))return json({Token:'fixture-private-xbox'});
  if(url.includes('/xsts/authorize'))return global.ownershipMode==='auth-failure'?json({XErr:2148916238},401):json({Token:'fixture-private-xsts',DisplayClaims:{xui:[{uhs:'fixture-hash',xid:'1234'}]}});
  if(url.includes('/authentication/login_with_xbox'))return json({access_token:'fixture-private-minecraft',expires_in:86400});
  if(url.includes('/entitlements/license'))return global.ownershipMode==='unknown'?json({},503):json({items:global.ownershipMode==='missing'?[]:[{name:'game_minecraft'}]});
  if(url.endsWith('/minecraft/profile'))return global.ownershipMode==='profile-required'?json({},404):json({id:'1234567890abcdef1234567890abcdef',name:'JavaCaptain',skins:[{state:'ACTIVE',url:'https://invalid.test/skin'}]});
  throw Error('Unexpected fixture request.');
 },wait:async(_ms,_value,{signal})=>new Promise((resolve,reject)=>{
  const abort=()=>reject(new DOMException('Cancelled','AbortError'));
  global.ownershipApprove=()=>{signal.removeEventListener('abort',abort);resolve();};signal.addEventListener('abort',abort,{once:true});
 })});}
};
const accounts=require('../../desktop/accounts.cjs');
accounts.AccountClient=class{async login(){global.ownershipEnrols++;return {created:false,account:{id:42,displayName:'JavaCaptain',minecraftName:null,minecraftUuid:null,roles:['member'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:require('node:crypto').createHash('sha256').update('xbox-uhs:fixture-hash').digest('hex')},session:{token:'fixture-company-private',expiresAt:Date.now()+86400000}};}async logout(){}};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture',record:{version:'fixture',java:'/fixture/java'}});
install.checkForUpdates=async()=>({applied:false});
install.launch=async()=>{global.ownershipLaunches++;global.ownershipGame=new EventEmitter();return global.ownershipGame;};
require('../../desktop/main.cjs');
