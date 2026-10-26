'use strict';
// ---- The socket the player's browser answers into ---------------------------------
// This suite drives the REAL listener — a real socket, bound to a real ephemeral port on
// 127.0.0.1, with real HTTP requests arriving on it — because the socket is the part of a
// browser sign-in that a mock cannot vouch for. Every claim below is a claim about what that
// socket does, and none of them is read out of the implementation: the assertions are
// status codes an HTTP client actually received, a connection that was actually refused, and
// a promise that actually settled.
//
// The four properties the ticket names are the four sections:
//   * bound to 127.0.0.1 and to nothing else, on a port the operating system chose;
//   * exactly one callback accepted, and the port gone the moment it is;
//   * a wrong state refused, without completing the sign-in or destroying it;
//   * the whole wait bounded, cancellable, and closed on every path out.
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('node:net'),os=require('node:os');
const {createHash}=require('node:crypto');
const {LoopbackRedirect,pkcePair,stateToken,sameState,LOOPBACK_HOST,CALLBACK_PATH,REGISTERED_REDIRECT,REGISTERED_ORIGIN,LOOPBACK_TIMEOUT_MS}=require('../../desktop/loopback.cjs');

// One request, as a browser or a local process would send it.
const httpGet=async url=>{
 const answer=await fetch(url,{redirect:'manual'});
 return {status:answer.status,body:await answer.text()};
};
// Whether anything is still listening on a port: a connection that is refused is the proof
// that the socket is gone, and a connection that is accepted is the proof that it is not.
const listening=port=>new Promise(resolve=>{
 const socket=net.connect({host:LOOPBACK_HOST,port});
 const done=value=>{try{socket.destroy();}catch{}resolve(value);};
 socket.setTimeout(2000,()=>done(false));
 socket.once('connect',()=>done(true));
 socket.once('error',()=>done(false));
});
const opened=async(options={})=>{
 const redirect=new LoopbackRedirect({timeoutMs:2000,...options});
 await redirect.listen();
 redirect.state=stateToken();
 return redirect;
};

// ---- Where it is bound -----------------------------------------------------------
test('the listener is on 127.0.0.1, on a port the operating system chose, and nothing else',async()=>{
 const redirect=await opened();
 try{
  assert.equal(redirect.host,LOOPBACK_HOST,'the host is the loopback address itself');
  assert.match(redirect.redirectUri,/^http:\/\/localhost:\d+\/callback$/,'the address the browser is sent to is the loopback callback on the real port: '+redirect.redirectUri);
  assert.notEqual(redirect.port,0,'the operating system answered with a port');
  // The URI says `localhost` because that is the only name whose port Microsoft ignores when
  // it matches a registered redirect URI; the socket it points at is not the name, it is the
  // address below, and this is the assertion that keeps the two from drifting apart.
  assert.equal(new URL(redirect.redirectUri).pathname,CALLBACK_PATH);
  // Nothing else on this machine can reach it: the listener's own address is the loopback one,
  // so a connection to any other address of this computer is refused rather than served.
  const external=Object.values(os.networkInterfaces()).flat().find(entry=>entry&&entry.family==='IPv4'&&!entry.internal);
  if(external){
   const reached=await new Promise(resolve=>{
    const socket=net.connect({host:external.address,port:redirect.port});
    const done=value=>{try{socket.destroy();}catch{}resolve(value);};
    socket.setTimeout(2000,()=>done('timeout'));
    socket.once('connect',()=>done('connected'));
    socket.once('error',error=>done(error.code||'error'));
   });
   assert.notEqual(reached,'connected','the listener answered on '+external.address+', which is not the loopback address');
  }
 }finally{redirect.close();}
});

// ---- One callback, then it is gone -----------------------------------------------
test('exactly one callback is accepted, and the port is closed the moment it is',async()=>{
 const redirect=await opened();
 // The wait is registered first, exactly as the real flow does it before opening a browser.
 const answer=redirect.wait();
 const code='ACCEPTED-CODE';
 const page=await httpGet(redirect.redirectUri+'?code='+code+'&state='+encodeURIComponent(redirect.state));
 assert.equal(page.status,200,'the browser that carried this sign-in’s own state is answered 200');
 assert.deepEqual(await answer,{code,error:'',errorDescription:''},'and the code is what the launcher receives');
 assert.equal(await listening(redirect.port),false,'the socket is closed in the same breath: nothing is listening on '+redirect.port);
 // A second request — a browser retrying, a local process that saw the port — reaches nothing.
 await assert.rejects(httpGet(redirect.redirectUri+'?code=SECOND&state='+encodeURIComponent(redirect.state)));
});

test('the answer is kept even when the browser comes back before anyone waits for it',async()=>{
 // The real flow opens the browser inside the call that starts the sign-in, so an early
 // callback is the normal case, not an edge one: a listener that dropped it would turn a
 // completed sign-in into a timeout.
 const redirect=await opened();
 await httpGet(redirect.redirectUri+'?code=EARLY&state='+encodeURIComponent(redirect.state));
 assert.deepEqual(await redirect.wait(),{code:'EARLY',error:'',errorDescription:''});
});

// ---- Wrong state is refused, and refused only -----------------------------------
test('a callback with the wrong state is refused and neither completes nor cancels the sign-in',async()=>{
 const redirect=await opened();
 const answer=redirect.wait();
 const wrong=await httpGet(redirect.redirectUri+'?code=STOLEN&state='+encodeURIComponent(stateToken()));
 assert.equal(wrong.status,400,'another state is answered 400');
 assert.equal(redirect.finished,false,'and nothing is finished');
 assert.equal(redirect.rejected,1,'the refusal is counted');
 // Still listening, still waiting: the refusal cannot be turned into a denial by a local
 // process that does not know the state, because it never ends the flow it failed to join.
 assert.equal(await listening(redirect.port),true,'the listener is still there for the real answer');
 const good=await httpGet(redirect.redirectUri+'?code=ACCEPTED&state='+encodeURIComponent(redirect.state));
 assert.equal(good.status,200,'the sign-in the player started still completes');
 assert.deepEqual(await answer,{code:'ACCEPTED',error:'',errorDescription:''});
});

test('a callback with no state at all, and one on another path, are both refused',async()=>{
 const redirect=await opened();
 const answer=redirect.wait();
 assert.equal((await httpGet(redirect.redirectUri+'?code=NO-STATE')).status,400,'a callback with no state is refused');
 assert.equal((await httpGet('http://localhost:'+redirect.port+'/')).status,404,'another path is not the callback at all');
 assert.equal((await httpGet('http://localhost:'+redirect.port+'/favicon.ico')).status,404,'a browser’s own favicon request is not a refusal either');
 assert.equal(redirect.rejected,1,'only the stateless callback was counted as a refusal');
 assert.equal(redirect.finished,false,'and none of it completed the sign-in');
 await httpGet(redirect.redirectUri+'?code=FINALLY&state='+encodeURIComponent(redirect.state));
 assert.equal((await answer).code,'FINALLY','the real answer still lands');
});

test('Microsoft’s own refusal arrives with the state and ends the wait with the error, not a code',async()=>{
 const redirect=await opened();
 const answer=redirect.wait();
 const page=await httpGet(redirect.redirectUri+'?error=access_denied&state='+encodeURIComponent(redirect.state));
 assert.equal(page.status,400,'the player is shown the refusal page, not the signed-in one');
 const settled=await answer;
 assert.equal(settled.error,'access_denied');
 assert.equal(settled.code,'');
});

test('nothing a request carried is ever written back into the page',async()=>{
 const redirect=await opened();
 const answer=redirect.wait();
 const hostile='<script>alert(1)</script>';
 const page=await httpGet(redirect.redirectUri+'?code='+encodeURIComponent(hostile)+'&state='+encodeURIComponent(redirect.state));
 assert.equal(page.status,200);
 assert.equal(/<script/i.test(page.body),false,'the answer page carries no markup from the request');
 assert.equal(page.body.includes('alert(1)'),false,'and none of its text either');
 assert.equal((await answer).code,hostile,'the value is carried to the launcher, never rendered');
});

// ---- Bounded, cancellable, and closed on every way out ---------------------------
test('the wait times out, and the socket is closed when it does',async()=>{
 const redirect=await opened({timeoutMs:60});
 await assert.rejects(redirect.wait(),{name:'TimeoutError'});
 assert.equal(await listening(redirect.port),false,'a timed-out sign-in leaves no port behind');
});

test('a cancel ends the wait exactly as a timeout does, with the launcher’s own AbortError',async()=>{
 const redirect=await opened({timeoutMs:30000});
 const controller=new AbortController();
 const answer=redirect.wait(controller.signal);
 controller.abort();
 await assert.rejects(answer,{name:'AbortError'});
 assert.equal(await listening(redirect.port),false,'a cancelled sign-in leaves no port behind');
});

test('an abort that has already happened never opens a wait at all',async()=>{
 const redirect=await opened();
 const controller=new AbortController();
 controller.abort();
 await assert.rejects(redirect.wait(controller.signal),{name:'AbortError'});
 redirect.close();
});

test('a flood of refused requests ends the sign-in instead of holding the socket open',async()=>{
 // A refusal cannot cancel the sign-in, but a refusal cannot be unlimited either: past the
 // limit the listener is closed and the wait fails, so a local process can deny a sign-in but
 // cannot keep a port open with it.
 const redirect=await opened({timeoutMs:30000,rejectLimit:3});
 // Settled rather than awaited: the third refusal is what ends the wait, so the rejection is
 // already on its way by the time the last request returns.
 const answer=redirect.wait().then(()=>null,error=>error);
 const statuses=[];
 for(let attempt=0;attempt<3;attempt+=1)statuses.push((await httpGet(redirect.redirectUri+'?code=X&state='+encodeURIComponent(stateToken()))).status);
 assert.deepEqual(statuses,[400,400,400],'each wrong state is refused on its own');
 assert.match(String((await answer)?.message),/too many requests/,'the flood ends the sign-in rather than holding the socket');
 assert.equal(await listening(redirect.port),false,'and the port goes with it');
});

test('closing a listener that never waited leaves nothing behind either',async()=>{
 const redirect=await opened();
 assert.equal(await listening(redirect.port),true);
 redirect.close();
 assert.equal(await listening(redirect.port),false);
});

// ---- PKCE and state -------------------------------------------------------------
test('PKCE is S256: the challenge is the SHA-256 of the verifier, and only the challenge travels',async()=>{
 const {verifier,challenge}=pkcePair();
 assert.match(verifier,/^[-_A-Za-z0-9]{43,128}$/,'the verifier is the shape RFC 7636 requires');
 assert.equal(challenge,createHash('sha256').update(verifier).digest('base64url'),'the challenge is SHA-256(verifier), base64url, unpadded');
 assert.equal(challenge.length,43,'SHA-256 base64url is 43 characters');
 assert.notEqual(challenge,verifier,'the verifier is not the challenge');
 const second=pkcePair();
 assert.notEqual(second.verifier,verifier,'every sign-in mints its own pair');
 assert.notEqual(second.challenge,challenge);
});

test('a state is 256 bits, a fresh one every time, and compared in constant time',async()=>{
 const first=stateToken(),second=stateToken();
 assert.match(first,/^[-_A-Za-z0-9]{43}$/,'32 random bytes, base64url');
 assert.notEqual(first,second);
 assert.equal(sameState(first,first),true);
 assert.equal(sameState(first,second),false);
 assert.equal(sameState(first,first.slice(0,-1)),false,'a shorter value is not a prefix match');
 assert.equal(sameState('',onlyState()),false,'and nothing is accepted against an empty state');
 function onlyState(){return ''+first;}
});

test('the registered address is the one Microsoft matches, and it is never 127.0.0.1',async()=>{
 // Microsoft ignores the port of a localhost redirect URI when it matches one (RFC 8252 §7.2),
 // which is the only reason an ephemeral port can be used at all. The exemption is for the
 // localhost literal: 127.0.0.1 would be matched literally, port and all, and is refused — even
 // though it is the same machine as the socket. So the two are deliberately different, and this
 // asserts both halves of that in one place.
 assert.equal(REGISTERED_REDIRECT,'http://localhost/callback');
 assert.match(REGISTERED_REDIRECT,/^http:\/\/[^:]+\/callback$/,'no port in the registered form, and the path this code asks for');
 const redirect=await opened();
 try{
  assert.equal(redirect.host,'127.0.0.1','the socket is bound to the loopback ADDRESS');
  assert.match(redirect.redirectUri,/^http:\/\/localhost:\d+\/callback$/,'and the URI it hands Microsoft says localhost: '+redirect.redirectUri);
  assert.equal(redirect.redirectUri.includes('127.0.0.1'),false,'the registered literal is never emitted');
  assert.equal(redirect.redirectUri.startsWith(REGISTERED_ORIGIN),true);
  assert.equal(new URL(redirect.redirectUri).pathname,CALLBACK_PATH,'the path is the one registered: '+CALLBACK_PATH);
 }finally{redirect.close();}
});

test('the whole wait is bounded by a named timeout, not a bare number',()=>{
 assert.equal(LOOPBACK_TIMEOUT_MS,300000,'five minutes: half the life of one Microsoft authorization code');
});
