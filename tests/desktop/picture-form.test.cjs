'use strict';
// THE ACCOUNT PICTURE HAS TWO FORMS AND ONE RULE, AND THIS IS THAT RULE'S GATE.
//
// Owen, 2026-11-08: "the user profile image in the easter co. launcher is the image I uploaded. the
// user profile image else where (everywhere else!) is my minecraft skin ... every single one should
// obviously be the same source". The cause was three readers of one field disagreeing:
// `sanitizeAccount` kept a `data:image/png;base64,` URI and an `https:` URL,
// `publicAccount` kept only the data URI, and site/desktop.js filtered the picture a third time on
// its own terms. The measured field: `GET /v2/accounts/me` answered account 3's picture on
// 2026-11-08 as a 98-character `https://lh3.googleusercontent.com/a/ACg8oc...=s96-c`.
//
// Two things are asserted here, and neither of them can pass by being ignored:
//   1. the three readers answer IDENTICALLY for both accepted forms and for every refused one -
//      including the line that ships inside site/desktop.js, which is read out of the source file
//      rather than restated here, so a drift in that copy fails this test;
//   2. the packaged launcher still mints the picture itself, under e-server's own bounds, and its
//      CSP still refuses a remote host - so the fix never became "let the desktop window fetch a
//      URL".
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pictureForm,sanitizeAccount,publicAccount,PICTURE_MAX}=require('../../desktop/accounts.cjs');
const {allowedPicture,privatePictureHost,hydratePicture,forgetHydratedPictures,PICTURE_TIMEOUT_MS,PICTURE_MAX_BYTES}=require('../../desktop/profile.cjs');
const ROOT=path.join(__dirname,'../..');
const HTTPS_PICTURE='https://lh3.googleusercontent.com/a/ACg8ocLfixture=fixture=s96-c';
const DATA_PICTURE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// The form rule as it is SHIPPED in site/desktop.js - a classic script with no imports, so it
// repeats the resolver's one line rather than sharing it. Read out of the file and turned into a
// function, so this test measures the copy a player's launcher actually runs.
function pagePictureForm(){
 const source=fs.readFileSync(path.join(ROOT,'site/desktop.js'),'utf8');
 const match=source.match(/const pictureForm=value=>[^\n]*value:null;/);
 assert.ok(match,'site/desktop.js no longer carries the picture form rule: the resolver and the window have drifted apart');
 return new Function('value',match[0].replace('const pictureForm=value=>','return '));
}
const sanitized=picture=>sanitizeAccount({id:7,username:'fixture_player',passwordRequired:false,picture});
const publicPicture=picture=>publicAccount({account:sanitized(picture)}).picture;

test('the form rule keeps both of the account service\'s picture forms and refuses everything else',()=>{
 assert.equal(pictureForm(HTTPS_PICTURE),HTTPS_PICTURE,'an https picture from a linked provider is the account\'s picture (the measured 98-character googleusercontent URL)');
 assert.equal(pictureForm(DATA_PICTURE),DATA_PICTURE,'a data:image/png;base64 picture from an upload is the account\'s picture');
 const long='https://lh3.googleusercontent.com/a/'+'a'.repeat(PICTURE_MAX);
 assert.equal(pictureForm(long.slice(0,PICTURE_MAX+1)),null,'a picture past the 360000-character ceiling is dropped');
 assert.equal(pictureForm('data:image/png;base64,'+'A'.repeat(PICTURE_MAX)),null,'and so is an inline texture past it, whatever its form');
 // A third scheme is never kept, whatever it claims to be: the face falls through to the skin head
 // and then the tile, and nothing here ever hands a fetch or an <img> something it may not have.
 for(const refused of ['javascript:alert(1)','javascript:data:image/png;base64,AAAA','http://lh3.googleusercontent.com/a/x','file:///etc/passwd','data:image/jpeg;base64,AAAA','data:text/html,<script>','HTTPS://lh3.googleusercontent.com/a/x','//lh3.googleusercontent.com/a/x','',null,undefined,42,{},[HTTPS_PICTURE]]){
  assert.equal(pictureForm(refused),null,'refused: '+JSON.stringify(refused));
 }
});

test('sanitizeAccount, publicAccount and the shipped site/desktop.js line all agree',()=>{
 const onThePage=pagePictureForm();
 for(const value of [HTTPS_PICTURE,DATA_PICTURE,'javascript:alert(1)','http://lh3.googleusercontent.com/a/x','file:///etc/passwd','data:image/jpeg;base64,AAAA',null,'']){
  const resolver=pictureForm(value),account=sanitized(value).picture,shown=publicPicture(value),page=onThePage(value);
  assert.equal(account,resolver,'sanitizeAccount must read the form through the resolver: '+JSON.stringify(value));
  assert.equal(shown,resolver,'publicAccount must keep exactly what sanitizeAccount kept, or the account control paints a different face: '+JSON.stringify(value));
  assert.equal(page,resolver,'the site/desktop.js copy must answer as the resolver does, or the launcher\'s window and the site disagree again: '+JSON.stringify(value));
 }
 // And the one that is the defect itself, named: an account whose picture is a provider URL keeps
 // that URL all the way to the value the account control paints.
 assert.equal(publicPicture(HTTPS_PICTURE),HTTPS_PICTURE,'an https picture survives to the painted account');
});

test('the packaged launcher still refuses every unapproved picture URL before any request is made',async()=>{
 let asked=0;
 const request=()=>{asked++;assert.fail('a refused picture must never be requested');};
 const image={isEmpty:()=>true};
 for(const [name,url] of [
  ['a non-https URL','http://lh3.googleusercontent.com/a/x'],
  ['a private address','https://127.0.0.1/a.png'],
  ['a private address on the LAN','https://192.168.1.10/a.png'],
  ['a link-local metadata address','https://169.254.169.254/latest/meta-data/'],
  ['a private address in 172.16/12','https://172.20.0.1/a.png'],
  ['localhost','https://localhost/a.png'],
  ['IPv6 loopback','https://[::1]/a.png'],
  ['a host wearing an allowed name','https://a.googleusercontent.com@attacker.test/a.png'],
  ['an allowed host on a port','https://cdn.discordapp.com:8443/a.png'],
 ]){
  forgetHydratedPictures();
  const result=await hydratePicture({companyId:'EC-7',picture:url},{request,nativeImage:image});
  assert.equal(result.picture,null,name+' answers null and leaves the skin head in place');
 }
 assert.equal(asked,0,'none of the refusals reached the network');
 // The allowlist and e-server's private-host refusal are two separate rules, and the private one
 // answers on its own: a future widening of the allowlist cannot open this door.
 assert.equal(privatePictureHost('127.0.0.1'),true);
 assert.equal(privatePictureHost('localhost'),true);
 assert.equal(privatePictureHost('172.31.255.255'),true);
 assert.equal(privatePictureHost('lh3.googleusercontent.com'),false);
 assert.equal(allowedPicture('https://lh3.googleusercontent.com/a/x'),true);
});

// A response body is an async iterable of Buffers, exactly as net.fetch's is.
const body=chunks=>({async*[Symbol.asyncIterator](){for(const chunk of chunks)yield chunk;}});
const pngNativeImage=()=>({createFromBuffer:()=>({isEmpty:()=>false,resize:()=>({toPNG:()=>Buffer.alloc(2048)})})});

test('an oversize body is refused at the byte that crosses the cap, not after it',async()=>{
 forgetHydratedPictures();
 const megabyte=Buffer.alloc(64*1024,1);
 let delivered=0;
 let response=null;
 const request=async()=>{
  const chunks=new Array(64).fill(megabyte); // 4 MiB, four times the cap
  response={ok:true,body:{async*[Symbol.asyncIterator](){for(const chunk of chunks){delivered+=chunk.length;yield chunk;}}}};
  return response;
 };
 const result=await hydratePicture({companyId:'EC-8',picture:HTTPS_PICTURE},{request,nativeImage:pngNativeImage()});
 assert.equal(result.picture,null,'a 4 MiB body is not a profile picture and answers null');
 assert.equal(PICTURE_MAX_BYTES,1024*1024,'the cap is e-server\'s one mebibyte (core/minecraft_face.py, PICTURE_URL_LIMIT)');
 assert.ok(delivered<=PICTURE_MAX_BYTES+megabyte.length,'the stream is cut as the cap is crossed rather than read to the end: read '+delivered+' bytes of '+64*megabyte.length);
 assert.ok(delivered<64*megabyte.length,'and the rest of the body is never read');
});

test('a timeout answers null and leaves the skin head in place',async()=>{
 forgetHydratedPictures();
 assert.equal(PICTURE_TIMEOUT_MS,4000,'the ceiling is e-server\'s four seconds (core/minecraft_face.py, PICTURE_URL_TIMEOUT)');
 let sawAbort=false;
 // net.fetch honours the signal it is given: this stub does the same, so the path measured is the
 // shipped one rather than a promise that would still be pending when the test ended.
 const request=(url,init)=>new Promise((resolve,reject)=>{
  init.signal.addEventListener('abort',()=>{sawAbort=true;reject(init.signal.reason);},{once:true});
 });
 const started=Date.now();
 const result=await hydratePicture({companyId:'EC-9',picture:HTTPS_PICTURE},{request,nativeImage:pngNativeImage(),timeoutMs:30});
 assert.equal(result.picture,null,'a host that does not answer inside the ceiling leaves no picture to draw');
 assert.equal(sawAbort,true,'the request was actually aborted, not merely abandoned');
 assert.ok(Date.now()-started<1000,'and it was abandoned at the ceiling rather than left running');
});

test('a fetch that throws never fails a sign-in, a launch or a render',async()=>{
 forgetHydratedPictures();
 const throwing=async()=>{throw Error('the host is down');};
 const resolved=await hydratePicture({companyId:'EC-10',picture:HTTPS_PICTURE},{request:throwing,nativeImage:pngNativeImage()});
 assert.equal(resolved.picture,null,'a throwing fetch answers the account with no picture');
 assert.equal(resolved.companyId,'EC-10','and the account itself is untouched, so the sign-in still stands');
 const notOk=await hydratePicture({companyId:'EC-11',picture:'https://avatars.steamstatic.com/a.png'},{request:async()=>({ok:false,body:body([])}),nativeImage:pngNativeImage()});
 assert.equal(notOk.picture,null,'a non-2xx answer is no picture either');
});

test('the fetch is the main process\'s own, and its HTTP headers are not the page\'s',async()=>{
 forgetHydratedPictures();
 let seen=null;
 const request=async(url,init)=>{
  seen={url,init};
  return {ok:true,body:body([Buffer.from('fixture-png')])};
 };
 const result=await hydratePicture({companyId:'EC-12',picture:HTTPS_PICTURE},{request,nativeImage:pngNativeImage()});
 assert.match(result.picture,/^data:image\/png;base64,/,'an approved https picture arrives as a data: URL, which is the only form the packaged window\'s CSP admits');
 assert.equal(seen.url,HTTPS_PICTURE);
 assert.equal(seen.init.credentials,'omit','no cookie of any kind travels with this request');
 assert.equal(seen.init.referrerPolicy,'no-referrer','and no referrer - the CDN is not told which surface asked');
 assert.deepEqual(seen.init.headers,{Accept:'image/*'},'and the only header this app adds is the one asking for an image');
 assert.equal(seen.init.redirect,'error','a redirect is refused rather than followed somewhere unexamined');
 assert.ok(seen.init.signal,'the request carries the abort signal the ceiling rides on');
});

test('one mint per account for the session, and a changed picture is fetched again',async()=>{
 forgetHydratedPictures();
 let calls=0;
 const counting=async()=>{calls++;return {ok:true,body:body([Buffer.from('fixture-png')])};};
 const first=await hydratePicture({companyId:'EC-13',picture:HTTPS_PICTURE},{request:counting,nativeImage:pngNativeImage()});
 const second=await hydratePicture({companyId:'EC-13',picture:HTTPS_PICTURE},{request:counting,nativeImage:pngNativeImage()});
 assert.match(first.picture,/^data:image\/png;base64,/);
 assert.equal(second.picture,first.picture,'the second paint is answered from the session cache');
 assert.equal(calls,1,'the same face is not refetched on every paint');
 const changed=await hydratePicture({companyId:'EC-13',picture:HTTPS_PICTURE+'=s128-c'},{request:counting,nativeImage:pngNativeImage()});
 assert.equal(calls,2,'a picture the player changed is fetched again rather than answered from memory');
 assert.equal(changed.picture,first.picture);
});

test('the packaged window\'s CSP has not been widened for a remote picture',()=>{
 const main=fs.readFileSync(path.join(ROOT,'desktop/main.cjs'),'utf8');
 const csp=main.match(/const CSP="([^"]+)"/);
 assert.ok(csp,'desktop/main.cjs must still declare the window\'s CSP');
 assert.match(csp[1],/img-src 'self' data: blob:/,'the policy is still exactly img-src \'self\' data: blob:');
 assert.doesNotMatch(csp[1],/img-src[^;]*https:/,'no remote host was added to img-src: the picture reaches the page as a data: URL minted in main, never as a URL the window fetches itself');
 assert.doesNotMatch(csp[1],/img-src[^;]*\*/,'and never widened to a wildcard');
 assert.match(main,/hydratePicture\(profile,\{request:\(\.\.\.args\)=>net\.fetch\(\.\.\.args\),nativeImage\}\)/,'main is still the half that mints the picture (desktop/profile.cjs, hydratePicture), so no renderer fetch was introduced');
});
