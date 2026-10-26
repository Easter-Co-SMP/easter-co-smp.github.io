'use strict';
// The hand-over, at the level where it broke: the refresh token this launcher keeps and
// sends. Microsoft's refresh tokens are single use, and a token response only carries a
// new one when offline_access is asked for, so a launcher that spends its token on a
// grant and keeps the spent copy is holding — and handing over — a dead credential.
//
// The account service stores what it is given and, on the first mint, meets Microsoft's
// refusal: `invalid_grant`, so the row is revoked and wiped and every later mint answers
// `absent`. That is the loop Owen is in: the launcher proves the hand-over, the proof
// fails, this machine keeps the dead token, and the next launch asks him for Microsoft
// again. These tests are about one question each: is the token the launcher keeps, and
// sends, still one Microsoft would accept?
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {MicrosoftAuth}=require('../../desktop/auth.cjs');
const {AccountClient}=require('../../desktop/accounts.cjs');
const {createMicrosoft}=require('./microsoft-fixture.cjs');

// `openExternal` is the player's browser, and it is the fixture's own: the launcher opens a
// real loopback socket bound to 127.0.0.1, and every sign-in below is completed by a real HTTP
// request to it carrying the code Microsoft issued for that state and PKCE challenge. The
// only thing stubbed is Microsoft itself (tests/desktop/microsoft-fixture.cjs).
const fixture=(options={})=>{
 const microsoft=createMicrosoft({uhs:'123456789',...options});
 const auth=new MicrosoftAuth({clientId:'test-app',request:microsoft.request,openExternal:microsoft.browser,wait:async()=>{}});
 return {auth,microsoft};
};
const notify=()=>{};

// ---- What this launcher keeps ----------------------------------------------------
for(const mode of ['unproven','proven']){
 test('a completed sign-in keeps a refresh token Microsoft still honours ('+mode+')',async()=>{
  const {auth,microsoft}=fixture({mode});
  const session=await auth.signIn(notify,undefined);
  assert.ok(session.refreshToken,'the sign-in produced a refresh token');
  assert(microsoft.honours(session.refreshToken),'the token this launcher keeps is one Microsoft would still accept; it kept '+session.refreshToken+' and Microsoft holds '+JSON.stringify(microsoft.live()));
 });
}

// ---- What this launcher sends ----------------------------------------------------
for(const mode of ['unproven','proven']){
 test('the token handed over on the account request is the live one ('+mode+')',async()=>{
  // The order enrolAccount runs in: the Microsoft sign-in, then the optional Graph leg for
  // the account's own email, then the one account request that carries the refresh token.
  const {auth,microsoft}=fixture({mode});
  let candidate=await auth.signIn(notify,undefined);
  const graph=await auth.graphAccessToken(candidate.refreshToken,undefined);
  const graphAccessToken=typeof graph==='string'?graph:graph?.accessToken;
  if(graph?.refreshToken)candidate={...candidate,refreshToken:graph.refreshToken};
  assert.ok(graphAccessToken,'the Graph leg answered a token, so it also spent the refresh token');
  assert(microsoft.honours(candidate.refreshToken),'the token about to be handed over is still live; the launcher would have sent '+candidate.refreshToken+' and Microsoft holds '+JSON.stringify(microsoft.live()));

  // And on the wire, which is where the account service sees it.
  const bodies=[];
  const client=new AccountClient({baseUrl:'http://127.0.0.1:1',request:async(url,options)=>{bodies.push({url,body:options.body});return {ok:true,status:200,json:async()=>({created:false,account:{id:34,username:'owen',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'FixtureCaptain',displayName:'Owen',roles:[],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:'a'.repeat(64)},session:{token:'company-session',expiresAt:'2026-12-31T00:00:00Z'}})};},retryBudget:0});
  await client.login('fixture-xbox:123456789:gamertag',undefined,undefined,graphAccessToken,undefined,candidate.refreshToken);
  const sent=JSON.parse(bodies[0].body);
  assert.ok(sent.microsoftRefreshToken,'the sign-in request carries microsoftRefreshToken');
  assert(microsoft.honours(sent.microsoftRefreshToken),'and it is a token Microsoft would still accept');
 });
}

// ---- The two grants that can spend it --------------------------------------------
test('every refresh grant asks for offline_access, so a successor always comes back',async()=>{
 const {auth,microsoft}=fixture({mode:'unproven'});
 await auth.signIn(notify,undefined);
 await auth.graphAccessToken('fixture-refresh-3',undefined).catch(()=>null);
 const grants=microsoft.refreshGrants();
 assert(grants.length>=1,'the sign-in reissued the Xbox Live scope and the Graph leg asked for its own');
 for(const grant of grants){
  assert.match(grant.scope,/\boffline_access\b/,'every grant that spends a refresh token asks for the successor back: '+JSON.stringify(grant));
 }
});

test('the Graph leg answers with the rotated token, and never keeps one to itself',async()=>{
 const {auth,microsoft}=fixture({mode:'proven'});
 const session=await auth.signIn(notify,undefined);
 const held=session.refreshToken;
 const answer=await auth.graphAccessToken(held,undefined);
 assert.ok(answer,'the Graph leg answered');
 assert.equal(typeof answer,'object','the Graph leg reports the token it rotated as well as the token it was asked for');
 assert.ok(answer.accessToken,'it carries the Graph access token');
 assert.ok(answer.refreshToken,'and the refresh token that replaced the one it spent');
 assert(!microsoft.honours(held),'the token it spent is gone at Microsoft, which is why the successor matters');
 assert(microsoft.honours(answer.refreshToken),'the successor is the live one');
});

test('a spent refresh token is never presented as this machine’s session',async()=>{
 // The saved-session route: this machine holds a token, Microsoft has already burned it.
 // It must end as "no local session" rather than as a session that cannot refresh, so the
 // account service is asked instead of a dead token being replayed at it forever.
 const {auth,microsoft}=fixture({mode:'proven'});
 const stored={accountId:'msa:'+'b'.repeat(64),xuid:'123456789',xboxUserToken:'stale-xbox',xboxExpiresAt:0,accessToken:'stale',expiresAt:0,refreshToken:'fixture-refresh-99',profile:null};
 await assert.rejects(auth.refresh(stored,undefined,false,true),error=>{
  assert.equal(error.code,'invalid_grant','a spent token is a refused grant');
  return true;
 });
 assert(!microsoft.honours('fixture-refresh-99'),'and it stays spent');
});
