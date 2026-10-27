// The return-target validator, on its own: what the site will send a browser back to, and what it
// refuses.
//
//   node --test tests/auth-return.test.mjs
//
// site/auth-return.mjs was written as a pure function on purpose, so this file needs no browser and
// no server: every case below is one call to resolve(), or one call to the storage seam around it,
// against the module the site actually ships. THE REJECTIONS ARE THE POINT. An allow-list that is
// only tested by the addresses it accepts is an allow-list nobody has measured the edges of, so
// every class the ticket names is asserted here, and each one is asserted to be a refusal rather
// than merely checked for not being the expected answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {RETURN_KEY,ALLOWED,resolve,appUrl,requestedTarget,rememberReturnTarget,takeTarget,forgetTarget} from '../site/auth-return.mjs';

const memory=()=>{const values=new Map();return {getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};};

// THE TWO ADDRESSES THE CONTRACT NAMES, and the two ids that name them.
test('the allow-listed apps are e-server and the launcher, at the addresses the contract froze',async()=>{
 assert.deepEqual(Object.keys(ALLOWED).sort(),['e-server','launcher'],'one row per first-party app, and no others yet');
 assert.equal(appUrl('e-server'),'https://easter-server.char-istrian.ts.net:8443/','e-server is the household host, on its own port');
 assert.equal(appUrl('launcher'),'easter-company://signed-in','the launcher is its own deep link');
 // The tailnet domain is the one constant a second domain would join. Owen wrote "chat-istrian";
 // what the household's tailnet actually serves - measured from e-server's own configured URL - is
 // char-istrian, and that is what is implemented and what e-server's side builds against.
 const source=await readFile(new URL('../site/auth-return.mjs',import.meta.url),'utf8');
 assert(source.includes("const TAILNET_DOMAIN='char-istrian.ts.net'"),'the tailnet suffix is one constant');
 assert(!source.includes('chat-istrian.ts.net'),'and the misspelled domain is not implemented anywhere');
});

test('an id that is not in the table is no target at all',()=>{
 for(const id of ['','e-server ','E-SERVER','e_server','constructor','__proto__','toString','hasOwnProperty','e-server\u0000','store'])
  assert.equal(appUrl(id),null,JSON.stringify(id)+' names no allow-listed app');
 for(const value of [null,undefined,42,{},[],['e-server']])
  assert.equal(appUrl(value),null,JSON.stringify(value)+' is not an app id');
 assert.equal(requestedTarget('?app=nope'),null,'an unknown ?app is ignored rather than an error');
 assert.equal(requestedTarget('?app='),null,'and so is an empty one');
});

// THE ADDRESSES THAT ARE ACCEPTED.
test('an https address on an easter.company host, or a char-istrian.ts.net host, is accepted',()=>{
 const accepted=[
  'https://easter.company/',
  'https://easter.company',
  'https://www.easter.company/store/',
  'https://accounts.easter.company/?tab=linked#top',
  'https://easter.company:8443/portal/',
  'https://char-istrian.ts.net/',
  'https://easter-server.char-istrian.ts.net:8443/',
  'https://anything.char-istrian.ts.net/deep/path?x=1',
 ];
 for(const target of accepted)assert.equal(resolve(target),new URL(target).href,'accepted: '+target);
 assert.equal(resolve('https://easter-company.easter.company/'),'https://easter-company.easter.company/','a label that contains the domain is fine when it is a label of a real subdomain of it');
 assert.equal(resolve('  https://easter.company/account/  '),'https://easter.company/account/','surrounding whitespace is a copy-paste artefact, not an address');
});

test('the launcher scheme is accepted as its own deep link and nowhere else',()=>{
 assert.equal(resolve('easter-company://signed-in'),'easter-company://signed-in');
 assert.equal(resolve('easter-company://signed-in/'),'easter-company://signed-in/');
 assert.equal(resolve('easter-company://reset/some/deep/path'),'easter-company://reset/some/deep/path','the app decides what its own scheme opens');
 assert.equal(resolve('easter-company://'),null,'an empty host is not a deep link to anywhere');
 assert.equal(resolve('easter-company:///signed-in'),null,'and neither is an empty authority with a path');
 assert.equal(resolve('easter-company:?x=1'),null,'a scheme with no authority at all is refused');
});

// THE ADDRESSES THAT ARE REFUSED, each one asserted as a refusal.
test('every scheme but https and easter-company: is refused',()=>{
 const refused=[
  'javascript:alert(document.domain)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:,https://easter.company/',
  'blob:https://easter.company/private',
  'file:///etc/passwd',
  'filesystem:https://easter.company/temporary/x',
  'about:blank',
  'chrome://settings',
  'ftp://easter.company/',
  'ws://easter.company/socket',
  'http://easter.company/',
  'http://char-istrian.ts.net/',
  'http://easter-server.char-istrian.ts.net:8443/',
 ];
 for(const target of refused)assert.equal(resolve(target),null,'refused: '+target);
});

test('an address carrying a username or password is refused, however it is spelled',()=>{
 const refused=[
  'https://user:pass@easter.company/',
  'https://user@easter.company/',
  'https://:pass@easter.company/',
  'https://easter.company@evil.example/',
  'https://user:pass@easter-server.char-istrian.ts.net:8443/',
  'https://x:y@easter.company.evil.example/',
 ];
 for(const target of refused)assert.equal(resolve(target),null,'refused: '+target);
});

test('a relative, protocol-relative or unparseable target is refused',()=>{
 const refused=[
  '//easter.company/account/',
  '//evil.example/',
  '/account/',
  '../store/',
  'account/',
  'easter.company',
  'https:/easter.company/',
  'https://',
  '',
  '   ',
  '#top',
  '?app=e-server',
  'https://easter company/',
 ];
 for(const target of refused)assert.equal(resolve(target),null,'refused: '+JSON.stringify(target));
});

test('a host that merely contains an allowed name is refused',()=>{
 const refused=[
  'https://evil-char-istrian.ts.net/',
  'https://char-istrian.ts.net.evil.example/',
  'https://char-istrianXts.net/',
  'https://char-istrianxts.net/',
  'https://evil-char-istrian.ts.net.evil.example/',
  'https://noteaster.company/',
  'https://easter.company.evil.example/',
  'https://evileaster.company/',
  'https://easter.company-evil.example/',
  'https://myserver.char-istrian.ts.net.evil.example/',
  'https://evil.example/?next=https://easter.company/',
  'https://evil.example/#https://easter.company/',
  'https://evil.example/easter.company/',
 ];
 for(const target of refused)assert.equal(resolve(target),null,'refused: '+target);
});

test('a host that only becomes an allowed host after normalisation is refused',()=>{
 // A trailing dot is a different DNS name, and the parser keeps it: an allow-list that compared
 // what the browser normalised would accept a host nobody here spelled.
 assert.equal(resolve('https://easter.company./'),null,'a trailing dot on easter.company is refused');
 assert.equal(resolve('https://char-istrian.ts.net./'),null,'and on the tailnet domain');
 assert.equal(resolve('https://easter-server.char-istrian.ts.net.:8443/'),null,'and on a host under it');
 // Upper case: the parser lower-cases a special scheme's host, so "it is the same host" and "it is
 // the spelling the allow-list names" are different questions. Only the second one is a target.
 assert.equal(resolve('https://EASTER.COMPANY/'),null,'an upper-case spelling is refused');
 assert.equal(resolve('https://Char-Istrian.TS.NET/'),null,'on the tailnet domain too');
 assert.equal(resolve('https://Easter-Server.char-istrian.ts.net:8443/'),null,'and on a host under it');
 // A look-alike: the Cyrillic 'е' is not the Latin one, and IDNA maps it to a punycode host that is
 // nothing to do with us. Refusing on the spelling is what catches that class of address.
 assert.equal(resolve('https://\u0435aster.company/'),null,'a Cyrillic look-alike host is refused');
 assert.equal(resolve('https://easter%2Ecompany/'),null,'a percent-encoded dot in the host is refused');
 assert.equal(resolve('https://xn--aster-ywe.company/'),null,'and the punycode it would normalise to');
});

test('anything that is not a string, and anything absurdly long, is refused',()=>{
 for(const value of [null,undefined,42,0,true,{},[],()=>'https://easter.company/',new URL('https://easter.company/')])
  assert.equal(resolve(value),null,'refused: '+String(value));
 assert.equal(resolve('https://easter.company/'+'a'.repeat(3000)),null,'a value longer than any address is refused');
});

// THE TWO PARAMETERS, and the answer they give.
test('?app= chooses an allow-listed row and ?next= has to pass the same validator',()=>{
 assert.equal(requestedTarget('?app=e-server'),'https://easter-server.char-istrian.ts.net:8443/');
 assert.equal(requestedTarget('?app=launcher'),'easter-company://signed-in');
 assert.equal(requestedTarget('?next='+encodeURIComponent('https://easter.company/app/')),'https://easter.company/app/');
 assert.equal(requestedTarget('?next='+encodeURIComponent('https://evil.example/')),null,'a next the validator refuses is ignored');
 assert.equal(requestedTarget('?next='+encodeURIComponent('javascript:alert(1)')),null);
 assert.equal(requestedTarget('?next=https://evil.example/'),null,'an unencoded next is the same refusal');
 assert.equal(requestedTarget(''),null,'no parameter, no target');
 assert.equal(requestedTarget('?code=abc&state=xyz'),null,'a provider callback is not a target');
 assert.equal(requestedTarget('?signed-in=1'),null,'and neither is the splash flag');
 assert.equal(requestedTarget('?app=e-server&next='+encodeURIComponent('https://evil.example/')),'https://easter-server.char-istrian.ts.net:8443/','an allow-listed id wins over a refused next');
 for(const value of [null,undefined,42,{}])assert.equal(requestedTarget(value),null,'refused: '+String(value));
});

// THE STORAGE SEAM: written once, read once, and never a credential.
test('a target is stored once in this tab, consumed once, and the key is gone afterwards',()=>{
 const storage=memory();
 assert.equal(rememberReturnTarget('?app=e-server',storage),'https://easter-server.char-istrian.ts.net:8443/');
 assert.equal(storage.getItem(RETURN_KEY),'https://easter-server.char-istrian.ts.net:8443/','the stored value is the address and nothing else');
 assert.equal(takeTarget(storage),'https://easter-server.char-istrian.ts.net:8443/','the sign-in that succeeds gets it');
 assert.equal(storage.getItem(RETURN_KEY),null,'reading it deletes it: the return happens once');
 assert.equal(takeTarget(storage),null,'and a second read is nothing, which is the second visit going to "/"');
});

test('a visit with no parameter writes nothing and leaves a stored target alone',()=>{
 const storage=memory();
 assert.equal(rememberReturnTarget('',storage),null);
 assert.equal(storage.values.size,0,'no key is written for a visit that asked for nothing');
 assert.equal(rememberReturnTarget('?code=abc&state=xyz',storage),null);
 assert.equal(rememberReturnTarget('?signed-in=1',storage),null);
 assert.equal(storage.values.size,0,'a callback and the splash flag ask for nothing either');
 // A page with no parameter does not clear what an earlier page of the tab stored: the sign-in
 // started on that page still has to come back.
 rememberReturnTarget('?app=launcher',storage);
 rememberReturnTarget('',storage);
 assert.equal(storage.getItem(RETURN_KEY),'easter-company://signed-in','the target survives a page that did not ask for one');
 // A newer request does replace it: the tab's newest intent is the one it comes back to.
 rememberReturnTarget('?app=e-server',storage);
 assert.equal(takeTarget(storage),'https://easter-server.char-istrian.ts.net:8443/');
});

test('a refused sign-in drops the request instead of carrying it forwards',()=>{
 const storage=memory();
 rememberReturnTarget('?app=e-server',storage);
 forgetTarget(storage);
 assert.equal(storage.getItem(RETURN_KEY),null,'nothing is left behind for the next sign-in in this tab to redeem');
 assert.equal(takeTarget(storage),null);
});

test('a hand-edited storage entry is dropped rather than followed',()=>{
 for(const kept of ['https://evil.example/','javascript:alert(1)','',"https://easter.company@evil.example/",'not a url']){
  const storage=memory();
  storage.setItem(RETURN_KEY,kept);
  assert.equal(takeTarget(storage),null,'refused: '+JSON.stringify(kept));
  assert.equal(storage.getItem(RETURN_KEY),null,'and it does not survive the read either');
 }
});

test('a storage that is denied or absent costs the return, never the sign-in',()=>{
 const denied={getItem(){throw Error('Storage denied');},setItem(){throw Error('Storage denied');},removeItem(){throw Error('Storage denied');}};
 assert.equal(rememberReturnTarget('?app=e-server',denied),null);
 assert.equal(takeTarget(denied),null);
 assert.doesNotThrow(()=>forgetTarget(denied));
 assert.equal(rememberReturnTarget('?app=e-server',null),null,'no storage at all answers the same way');
 assert.equal(takeTarget(null),null);
 assert.doesNotThrow(()=>forgetTarget(null));
});

// NO TOKEN, SESSION OR CODE EVER TRAVELS IN A REDIRECT TARGET. This is the gate that keeps the
// module from being extended into a handoff: the code below the header mentions no token, no
// password and no account seam at all, so there is nothing here that could put one in a URL, and a
// change that adds one fails this test rather than a review.
test('the module constructs no URL carrying a token, a session or a code',async()=>{
 const source=await readFile(new URL('../site/auth-return.mjs',import.meta.url),'utf8');
 // The prose above the code says what the module refuses to be; the code is what ships.
 const code=source.replace(/^\s*\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'');
 assert(code.length>1000,'the scan read the module\'s code, not an empty string: '+code.length);
 // The only "credential" the code can name is the userinfo it REFUSES (url.username/url.password),
 // and the only "session" is this tab's own storage. Everything else is asserted absent.
 const scanned=code.replace(/sessionStorage/g,'').replace(/url\.(username|password)/g,'');
 for(const forbidden of ['token','password','credential','Authorization','bearer','one-time','authorization code'])
  assert.equal(new RegExp(forbidden,'i').test(scanned),false,'the shipping code mentions '+JSON.stringify(forbidden)+' nowhere');
 // The one place the word "session" appears in the code is the tab's own storage, which holds the
 // address and nothing else: it is not the account seam's session and never carries one.
 assert.equal(/session/i.test(scanned),false,'the code mentions no session but this tab\'s storage');
 // Nothing here may reach the account seam, where a session does exist.
 for(const module of ['web-account.mjs','account-client.mjs','company-auth.mjs','web.js'])
  assert(!code.includes(module),'the module imports nothing that holds a session: '+module);
 // And the only storage it touches is the return key.
 assert.deepEqual([...source.matchAll(/RETURN_KEY/g)].length>0,true,'the one storage key is the only thing written');
 assert.equal((source.match(/setItem\(/g)||[]).length,1,'one write: the address, under one key');
 assert.equal((source.match(/getItem\(/g)||[]).length,1,'and one read');
 // The stored value is the resolved address: no query parameter is ever appended to it by this
 // module, so nothing can be smuggled onto the return beside the address.
 for(const id of Object.keys(ALLOWED)){
  const url=appUrl(id);
  assert.equal(url.includes('?'),false,'an allow-listed row carries no query string: '+url);
  assert.equal(url.includes('#'),false,'and no fragment: '+url);
 }
});
