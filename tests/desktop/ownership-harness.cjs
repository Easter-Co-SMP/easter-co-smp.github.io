// Dedicated transport fixtures; production auth/state/UI run unchanged.
const {EventEmitter}=require('node:events');
const {shell}=require('electron');
global.ownershipMode='missing';global.ownershipEnrols=0;global.ownershipLaunches=0;global.ownershipOpened=[];
shell.openExternal=async url=>{global.ownershipOpened.push(url);};
const auth=require('../../desktop/auth.cjs'),Original=auth.MicrosoftAuth;
const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
auth.MicrosoftAuth=class extends Original{
 constructor(options){super({...options,request:async url=>{
  // The redirect check (desktop/auth.cjs, checkRedirectAccepted): the measured answer for a
  // registered loopback address is Microsoft's own sign-in page, which proves nothing and must
  // never stop a sign-in.
  if(url.includes('/oauth2/v2.0/authorize?')||String(url).startsWith('https://login.live.com/'))return {ok:true,status:200,json:async()=>({}),text:async()=>'<html>Microsoft account requires JavaScript to sign in.</html>',headers:{get:()=>null}};
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
 })});
 }
 async signIn(notify,signal,onStage){
  // The browser is the journey's own approve press: it answers the address the launcher opened,
  // over the launcher's own loopback socket, with a code for that address's state. Everything
  // after it is the real flow against this fixture's request stub.
  const real=this.openExternal;
  this.openExternal=async url=>{
   await new Promise(resolve=>{global.ownershipApprove=resolve;});
   const query=new URL(url).searchParams;
   const answer=await fetch(query.get('redirect_uri')+'?code=fixture-code-ownershipApprove&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
   if(!answer.ok)throw Error('the fixture browser could not reach the launcher');
  };
  try{return await super.signIn(notify,signal,onStage);}
  finally{this.openExternal=real;}
 }
};
const accounts=require('../../desktop/accounts.cjs');
accounts.AccountClient=class{async login(){global.ownershipEnrols++;return {created:false,account:{id:42,username:'javacaptain',displayName:'JavaCaptain',minecraftName:null,minecraftUuid:null,roles:['member'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:require('node:crypto').createHash('sha256').update('xbox-uhs:fixture-hash').digest('hex')},session:{token:'fixture-company-private',expiresAt:Date.now()+86400000}};}async logout(){}};
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:true,version:'fixture',record:{version:'fixture',java:'/fixture/java'}});
install.checkForUpdates=async()=>({applied:false});
install.launch=async()=>{global.ownershipLaunches++;global.ownershipGame=new EventEmitter();return global.ownershipGame;};
// These fixtures stub the game installation; no client tree exists to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
