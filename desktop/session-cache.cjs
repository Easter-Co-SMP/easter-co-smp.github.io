'use strict';
// The last known Minecraft-session answer, kept in its own small file beside the settings
// and the vaults so a restart can say what the launcher last knew before the account service
// answers (doc/launcher-states.md, "The last known answer, shown while it is confirmed").
//
// WHAT THIS FILE IS FOR. On a cold start the launcher restores the Easter Company account
// from its vault with no network call, and then asks the account service for a Minecraft
// session (`probeMinecraftSession`). While that answer is in flight the hero could only say
// "Checking your Minecraft session…", for up to the mint's own three-minute budget. This file
// is what lets it say the last answer it had, with the note that it is being confirmed.
//
// WHAT THIS FILE IS NOT. It is a picture of a hero and a header, and it authorises nothing.
// It is never read by `canPlayNow()`, `sessionSource()`, `sessionAccessOk()` or any launch
// path in desktop/main.cjs: a press still mints (or refreshes) a real session and still goes
// through the same gate, so a cached "local" that has since become `reauth` can only change
// what the hero says, never what a launch is allowed to do. `desktop/main.cjs` publishes it as
// `sessionCached: true` with the word it holds, and drops it the moment an answer lands.
//
// THE WHITELIST, BY NAME. Nothing reaches the file except by travelling through `build()`
// below, which reads these field names off its argument and no others, and validates each
// one. A token, a refresh token, a session key, a server address or a SteamID64 has no field
// here to travel in, and `tests/desktop/session-cache.test.cjs` proves it by handing the
// builder a whole session — refresh tokens, access tokens, an XSTS token, a server address
// and a SteamID64 — and asserting that none of those values, or their values' own words, is
// anywhere in the text it produces.
const VERSION=1;
// How old the answer may be before it is ignored. Every fact in this file is about a Minecraft
// session, and the launcher's own access token lives `mc.expires_in||86400` seconds
// (desktop/auth.cjs, the one place a token's life is decided): 24 hours, so past one token
// lifetime the session the file describes cannot still be live, and the launcher's own
// six-hourly Company renewal (`desktop/main.cjs`, the `renewal` interval) has re-proved the
// account it belongs to at least four times since. It also keeps the note's grammar bounded —
// "N minutes ago" or "N hours ago", never days — so a player who has not opened the launcher
// for a fortnight gets today's "Checking…" screen instead of a fortnight-old claim.
const MAX_AGE_MS=24*60*60*1000;
// The seven words `minecraftSession.state` can take. `checking` is a wait and never an
// answer, so it is refused here as well as at the write: a file that says it holds an answer
// must not say "I am still asking".
const SESSION_WORDS=Object.freeze(['local','server','reauth','busy','required','unlinked','unknown']);
// The words that are facts this machine established rather than an answer from the service, so
// they are honest to hold without a `checkedAt`. `unknown` and `required` without one are the
// unasked word, and a guess is never written.
const LOCAL_WORDS=Object.freeze(['local','server','unlinked']);
const ACCESS_WORDS=Object.freeze(['owned','missing','profile-required','unknown']);
const PROVIDERS=Object.freeze(['microsoft','google','steam','discord']);
// The fields of each object, in the order they are written. These four lists are the whole
// whitelist, and the tests read them rather than a copy.
const FIELDS=Object.freeze(['version','writtenAt','account','minecraftSession','minecraftAccess','install']);
const ACCOUNT_FIELDS=Object.freeze(['id','displayName','username','minecraftName','minecraftUuid','providers','microsoftLinked']);
const SESSION_FIELDS=Object.freeze(['state','serverHeld','checkedAt']);
const INSTALL_FIELDS=Object.freeze(['installed','version','updatedAt']);
// Bounds on the text fields, so a file cannot grow a paragraph: a display name is 64 in
// accounts.cjs, a username 32, a Minecraft name 16, a client version is short.
const MAX_TEXT=64;
function text(value,max=MAX_TEXT){return typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;}
function identifier(value){
 if(typeof value==='number'&&Number.isFinite(value))return value;
 const id=text(value,MAX_TEXT);
 return id&&id.length?String(id):null;
}
// An ISO-8601 moment this process can parse, kept exactly as written so the published
// `cachedAt` is the file's own timestamp and not a re-rendering of it.
function moment(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;}
function oneOf(value,allowed){return typeof value==='string'&&allowed.includes(value)?value:null;}
// The seven words, as a session field this file may hold, or null. This is the one predicate
// the write and the read share, so an answer the launcher refused to write can never be read
// back as one.
function answerSession(field){
 if(!field||typeof field!=='object')return null;
 const state=oneOf(field.state,SESSION_WORDS);
 if(!state||state==='checking')return null;
 const checkedAt=moment(field.checkedAt);
 if(!checkedAt&&!LOCAL_WORDS.includes(state))return null;
 return {state,serverHeld:field.serverHeld===true,checkedAt};
}
function answerAccount(account){
 if(!account||typeof account!=='object')return null;
 const raw=Array.isArray(account.providers)?account.providers.filter(provider=>PROVIDERS.includes(provider)):[];
 return {
  id:identifier(account.id),
  displayName:text(account.displayName),
  username:text(account.username,32),
  minecraftName:text(account.minecraftName,16),
  minecraftUuid:text(account.minecraftUuid,40),
  providers:[...new Set(raw)].slice(0,PROVIDERS.length),
  microsoftLinked:account.microsoftLinked===true
 };
}
function answerInstall(install){
 if(!install||typeof install!=='object')return null;
 return {installed:install.installed===true,version:text(install.version,48),updatedAt:moment(install.updatedAt)};
}
// The record, or null when the launcher has nothing an answer could be said from. Every key
// is written from one of the four lists above, so nothing else can be in the object.
function build({writtenAt,account,minecraftSession,minecraftAccess,install}={}){
 const owner=answerAccount(account),session=answerSession(minecraftSession);
 if(!owner?.id||!session)return null;
 // A caller may pass the moment as a Date or as its ISO text; both are written as the ISO text
 // this process would publish, and neither is invented when it is missing or unparseable.
 let at=moment(writtenAt);
 if(!at&&writtenAt instanceof Date&&Number.isFinite(writtenAt.getTime()))at=writtenAt.toISOString();
 if(!at)return null;
 return {
  version:VERSION,
  writtenAt:at,
  account:{...owner},
  minecraftSession:{...session},
  minecraftAccess:oneOf(minecraftAccess,ACCESS_WORDS),
  install:{...answerInstall(install)}
 };
}
// The reasons a file is not read. Every one but `absent` means the file must go: it can never
// be used again, and leaving it would make every later start repeat the same discard.
const DISCARDED=Object.freeze(['unreadable','version','stale','incomplete','another-account']);
// Is this file this account's own answer? The id is the account the answer was written for,
// compared exactly as `mintMinecraftSession` compares the account it minted for; the Minecraft
// identity is compared on its bare uuid and its name for the same reason that comparison
// exists there — the service is the authority on which Java profile belongs to an account, so
// a file that names another one is another account's answer, whatever its id says.
function belongs(cache,account){
 if(!cache?.account?.id||!account?.id)return false;
 if(String(cache.account.id)!==String(account.id))return false;
 const cachedUuid=String(cache.account.minecraftUuid||'').replace(/-/g,'').toLowerCase();
 const liveUuid=String(account.minecraftUuid||'').replace(/-/g,'').toLowerCase();
 if(cachedUuid&&liveUuid&&cachedUuid!==liveUuid)return false;
 const cachedName=cache.account.minecraftName,liveName=account.minecraftName;
 if(cachedName&&liveName&&cachedName!==liveName)return false;
 return true;
}
// Read a file's text. `liveAccount` is the account this launcher holds right now, and a file
// that is not that account's answer is `another-account` — never edited, never shown.
function parse(raw,{now=Date.now(),liveAccount=null}={}){
 if(typeof raw!=='string'||!raw.trim())return {cache:null,reason:'absent'};
 let stored;
 try{stored=JSON.parse(raw);}catch{return {cache:null,reason:'unreadable'};}
 if(!stored||typeof stored!=='object'||Array.isArray(stored))return {cache:null,reason:'unreadable'};
 if(stored.version!==VERSION)return {cache:null,reason:'version'};
 const writtenAt=moment(stored.writtenAt);
 // The age is taken from `writtenAt`, the moment the launcher last knew this answer, and a
 // moment in the future — a clock that moved backwards between two runs — is read as age zero
 // rather than refused: the file was written here, and refusing it would only throw away an
 // answer this machine itself produced.
 const age=writtenAt?Math.max(0,now-Date.parse(writtenAt)):Infinity;
 if(!writtenAt||age>MAX_AGE_MS)return {cache:null,reason:'stale'};
 const cache=build({writtenAt,account:stored.account,minecraftSession:stored.minecraftSession,minecraftAccess:stored.minecraftAccess,install:stored.install});
 if(!cache)return {cache:null,reason:'incomplete'};
 if(!liveAccount||!belongs(cache,liveAccount))return {cache:null,reason:'another-account'};
 return {cache,reason:null};
}
// What the hero is told while the answer is being confirmed: the word the launcher last knew,
// the moment it knew it, and nothing else. `cachedAt` is the file's own `writtenAt` and is the
// only field the contract adds to `minecraftSession` while this is in use.
function published(cache){
 if(!cache?.minecraftSession)return null;
 const {state,serverHeld,checkedAt}=cache.minecraftSession;
 return {state,serverHeld:Boolean(serverHeld),checkedAt,cachedAt:cache.writtenAt};
}
module.exports={VERSION,MAX_AGE_MS,FIELDS,ACCOUNT_FIELDS,SESSION_FIELDS,INSTALL_FIELDS,SESSION_WORDS,DISCARDED,build,parse,belongs,published};
