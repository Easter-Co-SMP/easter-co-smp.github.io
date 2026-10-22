'use strict';
// Microsoft's token endpoint, modelled with the two behaviours that decide whether the
// refresh token the launcher hands over is worth anything.
//
//  1. A REFRESH TOKEN IS SINGLE USE. Spending one invalidates it; the replacement is what
//     the next grant must use. Microsoft documents it ("a refresh token can be used only
//     once ... a new refresh token is returned") and it is the behaviour behind this whole
//     ticket: a launcher that keeps the token it just spent keeps a dead one.
//  2. A TOKEN RESPONSE CARRIES A NEW REFRESH TOKEN ONLY WHEN THE REQUEST ASKED FOR
//     offline_access. So a grant can spend the only refresh token in hand and come back
//     with nothing to replace it with — which is a launcher bug, not a Microsoft one.
//
// Every other leg here (Xbox Live, XSTS, Minecraft, the licence read, the Java profile) is
// the same synthetic chain the other journeys use, and the uhs is digits because the real
// account service fixture parses it that way. Nothing here reaches a network.
//
// Two modes, because the launcher never sees which one Microsoft behaves as:
//   'unproven' — the device-code answer is minted for the client application, so
//                auth.cjs must exchange it for XboxLive.signin before it is used;
//   'proven'   — the device-code answer already carries an Xbox Live audience, so that
//                exchange is skipped and the Graph leg is the only other grant.
// The defect this ticket fixes is present in both, which is why both are exercised.
const {createHash}=require('node:crypto');
const json=(data,status=200)=>({ok:status<400,status,json:async()=>data});
const claim=claims=>['eyJhbGciOiJub25lIn0',Buffer.from(JSON.stringify(claims)).toString('base64url'),'sig'].join('.');
// Every token is its own value, like Microsoft's: the account service derives the verified
// address from the Graph token it is given, so two runs that were handed one identical token
// would collide on one address and the second sign-in would answer `unavailable`.
const XBOX_AUDIENCE_TOKEN=jti=>claim({aud:'http://auth.xboxlive.com',jti});
const CLIENT_AUDIENCE_TOKEN=jti=>claim({aud:'client-application',jti});

// `state` is an optional `{live:[],counter}` pair so a journey can keep Microsoft's view of
// the world across two launches of the same install: the token a first launch handed over
// must still be honoured by the process the second launch talks to. `persist(next)` is
// called with the new state after every change.
function createMicrosoft({mode='unproven',uhs='123456789',state=null,persist=null}={}){
 if(mode!=='unproven'&&mode!=='proven')throw Error('unknown Microsoft fixture mode: '+mode);
 const live=new Set(state?.live||[]);
 const issued=Array.isArray(state?.issued)?[...state.issued]:[...live];
 let counter=Number(state?.counter||0);
 const calls=[];
 let consented=false;
 const saved=()=>{if(persist)persist({live:[...live],counter,issued});};
 // The install's own uhs is part of every value, so two journeys that share one fixture
 // process never mint the same token — and therefore never claim the same verified address.
 const mintRefresh=()=>{const token='fixture-refresh-'+uhs+'-'+(++counter);live.add(token);issued.push(token);saved();return token;};
 const spend=(token,withOffline)=>{
  if(!live.has(token))return null;
  live.delete(token);
  const next=withOffline?'fixture-refresh-'+uhs+'-'+(++counter):null;
  if(next){live.add(next);issued.push(next);}
  saved();
  return {next};
 };
 const request=async(url,options={})=>{
  // The launcher sends a URLSearchParams for the form legs and a JSON string elsewhere; the
  // device-code grant's scope is the one field this fixture has to read correctly.
  const body=options.body instanceof URLSearchParams?options.body:new URLSearchParams(String(options.body??''));
  const scope=body.get('scope')||'';
  const offline=scope.split(/\s+/).includes('offline_access');
  calls.push({url,grant:body.get('grant_type'),scope,sent:body.get('refresh_token')||null});
  if(url.endsWith('/devicecode')){
   // The consent, and the only place the device flow's scopes are named: Microsoft answers
   // the token poll with a refresh token only when THIS request asked for offline_access.
   consented=offline;
   return json({device_code:'fixture-device-code',user_code:'HANDOVER-TEST',verification_uri:'https://microsoft.com/link',expires_in:600,interval:1});
  }
  if(url.endsWith('/token')){
   if(body.get('grant_type')==='urn:ietf:params:oauth:grant-type:device_code'){
    // A fresh sign-in. The poll names no scope: the consent above is what decides whether a
    // refresh token comes back.
    return json({access_token:mode==='proven'?XBOX_AUDIENCE_TOKEN('device-'+uhs+'-'+counter):CLIENT_AUDIENCE_TOKEN('device-'+uhs+'-'+counter),token_type:'Bearer',expires_in:3600,...(consented?{refresh_token:mintRefresh()}:{}),scope:'XboxLive.signin offline_access'});
   }
   const answer=spend(body.get('refresh_token'),offline);
   // A burned token is refused, which is exactly what a launcher holding a spent copy meets.
   if(!answer)return json({error:'invalid_grant',error_description:'the refresh token is not valid'},400);
   return json({access_token:XBOX_AUDIENCE_TOKEN('grant-'+uhs+'-'+counter),token_type:'Bearer',expires_in:3600,scope,...(answer.next?{refresh_token:answer.next}:{})});
  }
  if(url.endsWith('/user/authenticate'))return json({Token:'fixture-xbox:'+uhs+':gamertag',NotAfter:new Date(Date.now()+86400000).toISOString()});
  if(url.endsWith('/xsts/authorize'))return json({Token:'fixture-xsts',DisplayClaims:{xui:[{uhs,xid:uhs}]}});
  if(url.endsWith('/authentication/login_with_xbox'))return json({access_token:'fixture-minecraft-access',expires_in:86400});
  if(url.includes('/entitlements/license'))return json({items:[{name:'game_minecraft'},{name:'product_minecraft'}]});
  if(url.endsWith('/minecraft/profile'))return json({id:createHash('sha256').update(uhs).digest('hex').slice(0,32),name:'FixtureCaptain',skins:[]});
  throw Error('unexpected Microsoft fixture request: '+url);
 };
 return {
  request,calls,uhs,
  // What Microsoft would still accept, and what the launcher last handed over.
  live:()=>[...live],
  // Every refresh token this fixture has ever minted, and the ones Microsoft would now
  // refuse: a journey can say that no dead credential survived in the launcher's vault.
  issued:()=>issued,spentTokens:()=>issued.filter(token=>!live.has(token)),
  honours:token=>typeof token==='string'&&live.has(token),
  refreshGrants:()=>calls.filter(call=>call.grant==='refresh_token'),
  // The token a launcher spent and this fixture destroyed: every refresh token it has ever
  // minted that is no longer live.
  spent:token=>typeof token==='string'&&/^fixture-refresh-/.test(token)&&!live.has(token)
 };
}
module.exports={createMicrosoft,json,XBOX_AUDIENCE_TOKEN,CLIENT_AUDIENCE_TOKEN};
