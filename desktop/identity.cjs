'use strict';
const STATUSES=new Set(['owned','missing','profile-required','unknown']);
function access(session){if(!session)return 'signed-out';return STATUSES.has(session.minecraftAccess)?session.minecraftAccess:session.profile?'owned':'unknown';}
function id(session){return session?.accountId||session?.profile?.id||(/^\d{1,20}$/.test(session?.xuid||'')?'xbox:'+session.xuid:null);}
function publicIdentity(session){const key=id(session);return key?{id:key,name:session.profile?.name||'Microsoft account'}:null;}
function valid(session){
 if(!session||typeof session.refreshToken!=='string'||!session.refreshToken)return false;
 const key=id(session);if(!key)return false;
 if(session.profile&&(!/^[a-f0-9]{32}$/i.test(session.profile.id)||!/^\w{1,16}$/.test(session.profile.name)))return false;
 return /^msa:[a-f0-9]{64}$/.test(key)||key===session.profile?.id||/^\d{1,20}$/.test(session.xuid||'')&&(/^[a-f0-9]{32}$/i.test(key)||key==='xbox:'+session.xuid);
}
module.exports={access,id,publicIdentity,valid};
