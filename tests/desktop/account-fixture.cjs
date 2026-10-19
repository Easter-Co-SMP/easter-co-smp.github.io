// Completed Company accounts for tests whose subject is install/UI behavior.
const {createHash}=require('node:crypto');
const profiles=new Map();
function proof(id,name){
 profiles.set(id,name);
 return {xboxUserToken:'fixture-xbox:'+id,xboxExpiresAt:Date.now()+86400000,companySubject:createHash('sha256').update(id).digest('hex')};
}
// The verified addresses the fixture account service reports, in the frozen shape:
// two provider-verified addresses for the account, the first one its login email. It is a
// record the fixture owns, not a renderer preference, so selecting one changes what the
// next read answers — exactly like the real route.
const emails={list:[
 {email:'captain@example.test',provider:'microsoft',verifiedAt:'2026-01-01T00:00:00Z',login:true},
 {email:'crew@example.test',provider:'microsoft',verifiedAt:'2026-01-02T00:00:00Z',login:false}
 ],loginEmail:'captain@example.test'};
function emailPayload(){
 const list=emails.list.map(entry=>({...entry,login:entry.email===emails.loginEmail}));
 return {emails:list,loginEmail:emails.loginEmail};
}
// What a journey can make of the server-held session: `mint` to hold one, `reauth` to refuse,
// `revoke` to say the revoke route is absent. Nothing is set by default.
const serverSession={mint:null,reauth:false,revoke:'accepted',revokedAt:0};
function install(){
 if(process.env.EASTER_API_BASE_URL)return;
 const accounts=require('../../desktop/accounts.cjs');
 accounts.AccountClient=class{
  async login(token){
   const id=token.split(':')[1],name=profiles.get(id)||'TestCaptain';
   const account={id:parseInt(id.slice(-8),16)||1,username:(name||'testcaptain').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,20)||'testcaptain',minecraftUuid:id.slice(0,8)+'-'+id.slice(8,12)+'-'+id.slice(12,16)+'-'+id.slice(16,20)+'-'+id.slice(20),minecraftName:name,displayName:name,roles:['member'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:createHash('sha256').update(id).digest('hex')};
   return {created:false,account,session:{token:'fixture-company-session',expiresAt:Date.now()+86400000}};
  }
  async logout(){}
  // The game-server routes of the same frozen service. The fixture server is warm, so
  // Play takes the path it always took: the status answers ready, no wake is sent and
  // nothing waits. The cold-start rule itself is proven in tests/desktop/wake.test.cjs
  // against tests/desktop/stub-game-api.mjs, which can be told to return any state.
  async gameStatus(){return {state:'running',ready:true,endpoint:'smp.easter.company:25565',since:'2026-10-18T00:00:00Z',players:1,detail:null};}
  async wakeGame(){return this.gameStatus();}
  // The server-held Microsoft session (doc/launcher-states.md, "The Minecraft session the
  // account service holds"). This fixture service has no such route unless a journey sets one
  // up, which is exactly the live service until the cloud half ships: a password sign-in that
  // cannot play asks for Microsoft as it always did, and a revoke revokes nothing.
  async gameSession(){
   if(serverSession.reauth)throw new accounts.AccountError('reauth_required',accounts.MESSAGES.reauth_required);
   if(serverSession.mint)return {...serverSession.mint};
   throw new accounts.AccountError('route_absent',accounts.MESSAGES.route_absent);
  }
  async revokeGameSession(){
   if(serverSession.revoke==='absent')throw new accounts.AccountError('route_absent',accounts.MESSAGES.route_absent);
   serverSession.revokedAt=Date.now();
   return {revoked:serverSession.revoke!=='nothing'};
  }
  // The owner-only verified email pair, answering the contract shape. A test that wants
  // the empty state or a refusal sets it on this fixture rather than on the UI.
  async emails(){return emailPayload();}
  async selectLoginEmail(_token,email){
   if(email!==null&&!emails.list.some(entry=>entry.email===email))throw new accounts.AccountError('email_not_yours',accounts.MESSAGES.email_not_yours);
   emails.loginEmail=email;
   return emailPayload();
  }
 };
}
module.exports={proof,install,emails,serverSession};
