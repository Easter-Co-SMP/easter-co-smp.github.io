// Completed Company accounts for tests whose subject is install/UI behavior.
const {createHash}=require('node:crypto');
const profiles=new Map();
function proof(id,name){
 profiles.set(id,name);
 return {xboxUserToken:'fixture-xbox:'+id,xboxExpiresAt:Date.now()+86400000,companySubject:createHash('sha256').update(id).digest('hex')};
}
function install(){
 if(process.env.EASTER_API_BASE_URL)return;
 const accounts=require('../../desktop/accounts.cjs');
 accounts.AccountClient=class{
  async login(token){
   const id=token.split(':')[1],name=profiles.get(id)||'TestCaptain';
   const account={id:parseInt(id.slice(-8),16)||1,minecraftUuid:id.slice(0,8)+'-'+id.slice(8,12)+'-'+id.slice(12,16)+'-'+id.slice(16,20)+'-'+id.slice(20),minecraftName:name,displayName:name,roles:['member'],createdAt:'2026-01-01T00:00:00Z',passwordRequired:false,microsoftLinked:true,microsoftSubject:createHash('sha256').update(id).digest('hex')};
   return {created:false,account,session:{token:'fixture-company-session',expiresAt:Date.now()+86400000}};
  }
  async logout(){}
 };
}
module.exports={proof,install};
