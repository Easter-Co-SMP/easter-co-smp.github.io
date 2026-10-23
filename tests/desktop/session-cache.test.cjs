'use strict';
// The last known session answer, as a file: its whitelist, its bound and the rules that
// discard it (ticket 19e51885, doc/launcher-states.md "The last known answer, shown while it
// is confirmed"). These are pure functions, so they are proven here rather than through a
// launch; the journey `tests/desktop/session-cache.electron.mjs` proves what a real main
// process does with the file, and `tests/identity-browser.mjs` proves the words on the hero.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cache=require('../../desktop/session-cache.cjs');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const NOW=Date.parse('2026-10-23T12:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const ACCOUNT={id:'EC-7',displayName:'Captain Fixture',username:'captainfixture',minecraftName:'FixtureCaptain',minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',providers:['microsoft'],microsoftLinked:true};
// A whole account and a whole session, as the process really holds them: every one of these
// values is something that must never reach the file, and each is distinctive enough to be
// found in the text if it ever did.
const SECRETS={
 refreshToken:'fixture-secret-refresh-token-9b1c',
 accessToken:'fixture-secret-access-token-4e2a',
 xstsToken:'fixture-secret-xsts-token-77d0',
 sessionKey:'fixture-secret-session-key-0a1b',
 password:'fixture-secret-password-hunter2',
 serverAddress:'smp.easter.company:25565',
 steamId64:'76561198000000001',
 userHash:'fixture-secret-uhs-0123456789abcdef'
};
const WHOLE_ACCOUNT={...ACCOUNT,providers:['microsoft','steam'],microsoftSubject:SECRETS.userHash,providerDetails:{steam:{persona:'Owen',steamId64:SECRETS.steamId64},microsoft:{email:'owen@example.test'}},role:'owner',picture:'https://example.test/p.png'};
const WHOLE_SESSION={state:'server',serverHeld:true,checkedAt:'2026-10-23T09:30:00.000Z',refreshToken:SECRETS.refreshToken,accessToken:SECRETS.accessToken,xstsToken:SECRETS.xstsToken,sessionKey:SECRETS.sessionKey,password:SECRETS.password,server:SECRETS.serverAddress,steamId64:SECRETS.steamId64,companySubject:SECRETS.userHash};
const WHOLE_INSTALL={installed:true,version:'fixture-fabric',updatedAt:'2026-10-19T00:00:00.000Z',location:'/home/player/.easter-company/minecraft',location2:SECRETS.serverAddress};
const record=extra=>cache.build({writtenAt:iso(NOW),account:WHOLE_ACCOUNT,minecraftSession:WHOLE_SESSION,minecraftAccess:'owned',install:WHOLE_INSTALL,...extra});

test('the file holds exactly the named presentation fields and nothing else',async()=>{
 const built=record();
 assert.deepEqual(Object.keys(built),[...cache.FIELDS],'the top level is the whitelist, in order');
 assert.deepEqual(Object.keys(built.account),[...cache.ACCOUNT_FIELDS],'the account block is its own list');
 assert.deepEqual(Object.keys(built.minecraftSession),[...cache.SESSION_FIELDS],'the session block is its own list');
 assert.deepEqual(Object.keys(built.install),[...cache.INSTALL_FIELDS],'the install block is its own list');
 assert.equal(built.version,cache.VERSION,'the file names its own version');
 assert.equal(built.writtenAt,iso(NOW),'and the moment it was written');
 assert.deepEqual(built.account,{...ACCOUNT,providers:['microsoft','steam']},'the account is rebuilt field by field from the account, so nothing else on it travels');
});

test('no secret-shaped value can reach the file, whatever the caller hands the builder',async()=>{
 // Everything at once: the whole account document, a whole session with every credential the
 // launcher can hold, an install record, and extra top-level fields an optimistic caller might
 // add. The builder reads its own field names off the argument and ignores all of it.
 const built=record({session:SECRETS,accountId:'EC-7',token:SECRETS.accessToken,steamId64:SECRETS.steamId64,server:SECRETS.serverAddress});
 const text=JSON.stringify(built);
 for(const [name,value] of Object.entries(SECRETS))assert(!text.includes(value),name+' must never be written to the session cache');
 // The keys too, not only the values: a file that carried `refreshToken: null` would still be a
 // file the next reader has to wonder about.
 // Arrays carry their entries by index, which is not a field name: only object keys are read.
 const keys=[];
 const collect=node=>{
  if(!node||typeof node!=='object'||Array.isArray(node))return;
  for(const [key,value] of Object.entries(node)){keys.push(key);collect(value);}
 };
 collect(built);
 const allowed=new Set([...cache.FIELDS,...cache.ACCOUNT_FIELDS,...cache.SESSION_FIELDS,...cache.INSTALL_FIELDS]);
 assert.deepEqual(keys.filter(key=>!allowed.has(key)),[],'only whitelisted keys exist anywhere in the record');
 for(const forbidden of ['refreshToken','accessToken','token','sessionKey','password','server','steamId64','microsoftSubject','xstsToken','userHash','picture','providerDetails'])assert(!keys.includes(forbidden),forbidden+' must not be a key in the file');
 // And the text a real caller would write is exactly what this produces, so the assertion is
 // about the bytes on disk rather than about an object nobody serializes.
 const written=JSON.stringify(built,null,2);
 for(const value of Object.values(SECRETS))assert(!written.includes(value),'the written text carries no secret either');
});

test('the file is written from an answer only, never from a wait or a guess',async()=>{
 const withState=field=>record({minecraftSession:field});
 // A wait is not an answer: `checking` is refused, and so is the unasked word.
 assert.equal(withState({state:'checking',serverHeld:false,checkedAt:null}),null,'a mint in flight is never written');
 assert.equal(withState({state:'unknown',serverHeld:false,checkedAt:null}),null,'the unasked word is never written');
 assert.equal(withState({state:'required',serverHeld:false,checkedAt:null}),null,'and neither is the unasked linked word');
 // Each of the seven words that does carry an answer is written, with its own moment.
 for(const state of ['reauth','busy','unknown'])assert.equal(withState({state,serverHeld:false,checkedAt:iso(NOW)}).minecraftSession.state,state,'an answer is written: '+state);
 for(const state of ['local','server','unlinked'])assert.equal(withState({state,serverHeld:false,checkedAt:null}).minecraftSession.state,state,'a fact this machine established is written: '+state);
 // An install and an account are not answers either: without both there is no record at all.
 assert.equal(cache.build({writtenAt:iso(NOW),account:{...WHOLE_ACCOUNT,id:null},minecraftSession:WHOLE_SESSION}),null,'no account id, no record');
 assert.equal(cache.build({writtenAt:'not a moment',account:WHOLE_ACCOUNT,minecraftSession:WHOLE_SESSION}),null,'no moment, no record');
});

test('a corrupt, mismatched or stale file is refused with its own reason so it can be deleted',async()=>{
 const good=JSON.stringify(record());
 const parse=(raw,options={})=>cache.parse(raw,{now:NOW,liveAccount:WHOLE_ACCOUNT,...options});
 assert.deepEqual(parse(undefined),{cache:null,reason:'absent'},'no file is not an error');
 assert.deepEqual(parse(''),{cache:null,reason:'absent'});
 assert.deepEqual(parse('{oops'),{cache:null,reason:'unreadable'},'unparseable text is unreadable, never a crash');
 assert.deepEqual(parse('"a string"'),{cache:null,reason:'unreadable'});
 assert.deepEqual(parse('[]'),{cache:null,reason:'unreadable'});
 assert.deepEqual(parse(JSON.stringify({...record(),version:cache.VERSION+1})),{cache:null,reason:'version'},'another version is never guessed at');
 assert.deepEqual(parse(JSON.stringify({...record(),writtenAt:iso(NOW-cache.MAX_AGE_MS-1000)}).replace(/}/,'')),{cache:null,reason:'unreadable'});
 // The bound itself: one millisecond inside it is read, one millisecond past it is not.
 assert(cache.parse(JSON.stringify(record({writtenAt:iso(NOW-cache.MAX_AGE_MS+1000)})),{now:NOW,liveAccount:WHOLE_ACCOUNT}).cache,'an answer at the edge of the bound is still an answer');
 assert.deepEqual(parse(JSON.stringify(record({writtenAt:iso(NOW-cache.MAX_AGE_MS-1000)})) ),{cache:null,reason:'stale'},'past the bound it is ignored');
 // The account it belongs to. Id, Minecraft uuid and Minecraft name, because a file that names
 // another player is another account's answer however its id reads.
 assert.deepEqual(parse(good,{liveAccount:{...WHOLE_ACCOUNT,id:'EC-8'}}),{cache:null,reason:'another-account'},'another account id discards it');
 assert.deepEqual(parse(good,{liveAccount:{...WHOLE_ACCOUNT,minecraftUuid:'00000000-0000-0000-0000-000000000000'}}),{cache:null,reason:'another-account'},'another Minecraft identity discards it');
 assert.deepEqual(parse(good,{liveAccount:{...WHOLE_ACCOUNT,minecraftName:'SomebodyElse'}}),{cache:null,reason:'another-account'},'another Minecraft name discards it');
 assert.deepEqual(parse(good,{liveAccount:null}),{cache:null,reason:'another-account'},'no account at all discards it');
 // Every reason above is one the launcher deletes the file for; `absent` is the only one it does
 // not, because there is nothing to delete. The list in the module is what main.cjs reads.
 assert.deepEqual(['unreadable','version','stale','incomplete','another-account'],[...cache.DISCARDED],'the discard list is exactly the five reasons, and absent is not one of them');
 // A file whose own fields were damaged is discarded rather than half-read.
 assert.deepEqual(parse(JSON.stringify({...record(),minecraftSession:{state:'playing',checkedAt:iso(NOW)}})),{cache:null,reason:'incomplete'},'a word the contract does not have is not a word');
 assert.deepEqual(parse(JSON.stringify({...record(),account:{id:'EC-7'},minecraftSession:{state:'checking'}})),{cache:null,reason:'incomplete'},'a file claiming a wait is not an answer');
 // A hand-edited file cannot smuggle a credential in: the read rebuilds the record field by
 // field, so a key that is not on the whitelist is simply not there afterwards.
 const smuggled=cache.parse(JSON.stringify({...record(),refreshToken:SECRETS.refreshToken,account:{...ACCOUNT,accessToken:SECRETS.accessToken}}),{now:NOW,liveAccount:WHOLE_ACCOUNT});
 assert.deepEqual(Object.keys(smuggled.cache).sort(),[...cache.FIELDS].sort());
 assert(!JSON.stringify(smuggled.cache).includes(SECRETS.accessToken));
});

test('a moment in the future is this machine\'s own answer, not a reason to refuse it',async()=>{
 // A clock that moved backwards between two runs leaves `writtenAt` ahead of now. The file was
 // written here, so it is read, with an age of zero — never treated as stale by a negative age.
 const future=record({writtenAt:iso(NOW+60*60*1000)});
 assert(cache.parse(JSON.stringify(future),{now:NOW,liveAccount:WHOLE_ACCOUNT}).cache,'a slightly future moment is still this machine\'s answer');
});

test('what a view is told while the answer is confirmed is the word and its moment, nothing more',async()=>{
 const built=record();
 assert.deepEqual(cache.published(built),{state:'server',serverHeld:true,checkedAt:'2026-10-23T09:30:00.000Z',cachedAt:iso(NOW)},'the session field plus the moment the file was written');
 assert.equal(cache.published(null),null,'no cache publishes nothing');
 const local=record({minecraftSession:{state:'local',serverHeld:false,checkedAt:null}});
 assert.deepEqual(cache.published(local),{state:'local',serverHeld:false,checkedAt:null,cachedAt:iso(NOW)},'a local fact has no checkedAt and is not given one');
});

test('the launcher only consults the cache where it draws the session, never where it decides a launch',async()=>{
 // The gate is the reason this file exists in the form it does: it is a picture, and a picture
 // must not be an authorisation. These are the four functions a launch is decided by, and none
 // of them may mention the cache at all.
 const main=read('desktop/main.cjs');
 for(const fn of ['function canPlayNow()','function sessionSource()','function sessionAccessOk()','async function launchSession()','function launchProfile()']){
  const start=main.indexOf(fn);
  assert(start>0,'main.cjs defines '+fn);
  const end=main.indexOf('\n}',start);
  const body=main.slice(start,end);
  assert(!/sessionAnswer|cachedAnswer|sessionCacheShowing|rememberSession/.test(body),fn+' must not read the session cache');
 }
 assert.match(main,/const sessionAnswer=require\('\.\/session-cache\.cjs'\)/,'and the one module that holds it is required exactly there');
 // The file's own path is beside the vaults and the settings, under the per-user directory.
 assert.match(main,/const sessionCacheFile=\(\)=>path\.join\(configRoot\(\),'session-cache\.json'\)/);
 // It is written atomically, through the same primitive the settings use.
 assert.match(main,/atomicJSON\(sessionCacheFile\(\),record\)/);
 // And the state publishes the word plus one flag and one moment, so no view has to infer it.
 assert.match(main,/minecraftSession:publishedMinecraftSession\(\),sessionCached:sessionCacheShowing\(\)/);
});

test('the bound is named, is 24 hours, and is justified by the token life it outlives',async()=>{
 assert.equal(cache.MAX_AGE_MS,24*60*60*1000,'one token lifetime is the bound');
 const source=read('desktop/session-cache.cjs'),auth=read('desktop/auth.cjs');
 assert.match(auth,/mc\.expires_in\|\|86400/,'auth.cjs is where a Minecraft token\'s life is decided');
 assert.match(source,/86400/,'and the bound quotes it, so the two cannot drift apart silently');
 assert.match(source,/MAX_AGE_MS=24\*60\*60\*1000/);
 // The document names the same bound and the same sentences, so the contract cannot fall behind.
 const doc=read('doc/launcher-states.md');
 assert.match(doc,/MAX_AGE_MS|cache older than/,'doc/launcher-states.md records the bound');
 assert.match(doc,/Last checked /,'and the note sentence this feature adds');
});

test('the record a real caller writes is a file the same code reads back unchanged',async()=>{
 // Written into a temporary directory as a real file, then read back the way the launcher reads
 // it: the round trip is the proof that build() and parse() agree about the shape.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'session-cache-test-'));
 try{
  const file=path.join(dir,'session-cache.json'),built=record();
  fs.writeFileSync(file,JSON.stringify(built,null,2),{mode:0o600});
  const readBack=cache.parse(fs.readFileSync(file,'utf8'),{now:NOW,liveAccount:WHOLE_ACCOUNT});
  assert.deepEqual(readBack.reason,null);
  assert.deepEqual(readBack.cache,built,'what is written is exactly what is read back');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
