'use strict';
// Microsoft's sign-in endpoints, modelled well enough that the launcher's own flow runs
// against them for real: the authorize page (both the registration probe and the address a
// browser is opened at), the code exchange with its PKCE check, and the refresh grants. What
// arrives at the launcher's callback is delivered over a real HTTP connection by `browser()`
// below, so the loopback socket is exercised rather than mocked.
//
// The two behaviours that decide whether the refresh token the launcher hands over is worth
// anything are modelled exactly:
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
// account service fixture parses it that way. Nothing here reaches a network beyond the
// launcher's own loopback listener.
//
// Two modes, because the launcher never sees which one Microsoft behaves as:
//   'unproven' — the code-exchange answer is minted for the client application, so
//                auth.cjs must exchange it for XboxLive.signin before it is used;
//   'proven'   — the code-exchange answer already carries an Xbox Live audience, so that
//                exchange is skipped and the Graph leg is the only other grant.
// The hand-over rules hold in both, which is why both are exercised.
//
// `registration` is the one thing about the Azure app registration this fixture can pretend
// to know: `'registered'` (the default) answers the launcher's probe with the redirect it
// just asked for; `'unregistered'` answers with the page Microsoft shows instead when the
// redirect URI is not on the app — the case that has to fail with a sentence naming the URI
// rather than with a timeout.
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
function createMicrosoft({mode='unproven',registration='registered',uhs='123456789',state=null,persist=null}={}){
 if(mode!=='unproven'&&mode!=='proven')throw Error('unknown Microsoft fixture mode: '+mode);
 if(registration!=='registered'&&registration!=='unregistered')throw Error('unknown Microsoft fixture registration: '+registration);
 const live=new Set(state?.live||[]);
 const issued=Array.isArray(state?.issued)?[...state.issued]:[...live];
 let counter=Number(state?.counter||0);
 const calls=[];
 // The codes this fixture has handed a browser, and what each was bound to: the exchange is
 // only honoured for a code that came back with the challenge and the address it was issued
 // to, which is what makes the launcher's PKCE verifier a real part of this fixture.
 const issuedCodes=new Map();
 let codeCounter=0;
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
  // authorize request's scope is the one field this fixture has to read correctly.
  const body=options.body instanceof URLSearchParams?options.body:new URLSearchParams(String(options.body??''));
  const scope=body.get('scope')||'';
  const offline=scope.split(/\s+/).includes('offline_access');
  calls.push({url,grant:body.get('grant_type'),scope,sent:body.get('refresh_token')||null});
  if(url.includes('/authorize?')){
   const query=new URL(url).searchParams;
   const redirectUri=query.get('redirect_uri')||'';
   // The launcher's registration probe, and the only answer that decides whether it opens a
   // browser: a redirect back to its own callback proves the address is on the app; a page
   // instead of a redirect is the app refusing to answer to it at all.
   if(query.get('prompt')==='none'){
    if(registration==='unregistered')return {ok:false,status:200,json:async()=>({}),text:async()=>'<html><body>AADSTS50011: The redirect URI specified in the request does not match the redirect URIs configured for the application.</body></html>',headers:{get:()=>null}};
    const back=redirectUri+'?error=login_required&error_description=AADSTS50058&state='+encodeURIComponent(query.get('state')||'');
    return {ok:false,status:302,json:async()=>({}),text:async()=>'',headers:{get:name=>(String(name).toLowerCase()==='location'?back:null)}};
   }
   // The launcher never fetches this itself: the player's browser does, and in a test
   // `browser()` below is that browser. Reaching here means something requested the page
   // rather than opening it, which is not a flow this fixture offers.
   throw Error('the authorize page is opened by a browser, not requested: '+url);
  }
  if(url.endsWith('/token')){
   if(body.get('grant_type')==='authorization_code'){
    // A fresh sign-in. This is the one place the browser's answer is spent, so it is the one
    // place the code and the verifier are checked: a code this fixture never issued, a
    // verifier whose SHA-256 is not the challenge that code was issued with, and an address
    // other than the one it was issued to are all refused, exactly as Microsoft refuses them.
    const issued=issuedCodes.get(body.get('code'));
    const verifier=body.get('code_verifier')||'';
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    if(!issued||issued.challenge!==challenge||issued.redirectUri!==body.get('redirect_uri'))return json({error:'invalid_grant',error_description:'the code could not be redeemed'},400);
    issuedCodes.delete(body.get('code'));
    // The refresh token comes back only because the authorize request asked for
    // offline_access, which is the same rule the refresh grants below enforce.
    return json({access_token:mode==='proven'?XBOX_AUDIENCE_TOKEN('code-'+uhs+'-'+counter):CLIENT_AUDIENCE_TOKEN('code-'+uhs+'-'+counter),token_type:'Bearer',expires_in:3600,...(offline?{refresh_token:mintRefresh()}:{}),scope:'XboxLive.signin offline_access'});
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
  request,calls,uhs,registration,
  // The player's browser, for a test: it reads the address the launcher opened, has Microsoft
  // issue a code for it, and delivers that code to the launcher's own loopback listener over a
  // real HTTP connection — which is the only way a callback can arrive.
  browser:async url=>{
   const query=new URL(url).searchParams;
   const redirectUri=query.get('redirect_uri')||'';
   const code='fixture-code-'+uhs+'-'+(++codeCounter);
   issuedCodes.set(code,{challenge:query.get('code_challenge'),redirectUri});
   const answer=await fetch(redirectUri+'?code='+encodeURIComponent(code)+'&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
   return {code,status:answer.status,body:await answer.text()};
  },
  // The other thing a browser can do: refuse on Microsoft's own page.
  refuse:async(url,error='access_denied')=>{
   const query=new URL(url).searchParams;
   const answer=await fetch(query.get('redirect_uri')+'?error='+encodeURIComponent(error)+'&state='+encodeURIComponent(query.get('state')||''),{redirect:'manual'});
   return {status:answer.status,body:await answer.text()};
  },
  issuedCodes,
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
