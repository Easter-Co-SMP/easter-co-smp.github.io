'use strict';
// ---- The loopback redirect a desktop sign-in needs -------------------------------
// Microsoft's device code flow is gone from this launcher because of the one thing it
// costs the player: a code to copy into a browser by hand. What replaces it is the
// shape every native application uses (RFC 8252): the launcher opens the system browser
// at Microsoft's own sign-in page and Microsoft hands the answer back to a socket this
// process is listening on. The player types nothing into the launcher and copies nothing.
//
// THE SOCKET IS THE SECURITY SURFACE, so everything about it is decided here and nowhere
// else, and every decision is one of the four below.
//
//  1. IT IS BOUND TO 127.0.0.1 AND TO NOTHING ELSE. Never '0.0.0.0', never a hostname, and
//     `listen(0, LOOPBACK_HOST)` so the operating system picks an ephemeral port. No other
//     machine can reach it: the address is the loopback interface, not this computer's.
//  2. IT ANSWERS EXACTLY ONE REQUEST AND THEN THE PORT IS GONE. The first request that
//     carries a valid `state` completes the sign-in; every socket is destroyed and the
//     server closed in the same tick, so there is no window in which a second local
//     process can reach a live listener. A request that does not validate — another path,
//     a missing or wrong `state`, a malformed query — is answered 400 and changes nothing:
//     it never completes the flow, and it never cancels it either, because a local process
//     must not be able to end a sign-in the player started. Those refusals are bounded
//     (LOOPBACK_REJECT_LIMIT) so the socket cannot be held open by a flood.
//  3. STATE IS THE ONLY THING THAT MAY COMPLETE IT. A callback is accepted only when its
//     `state` is the 256-bit value this process minted and has never written anywhere but
//     its own memory and the URL it opened in the browser. A code delivered with anybody
//     else's state is refused, so a local process cannot inject a code of its choosing.
//  4. THE CODE IS WORTHLESS WITHOUT THE VERIFIER. PKCE S256: the authorize request carries
//     only SHA-256(verifier), and the verifier never leaves this process. An authorization
//     code that leaked out of the socket still cannot be exchanged by whoever took it.
//
// What all of that means for an unrelated local process while the listener is open is in
// the report: it can connect and be refused, and it can deny the sign-in by flooding the
// port until the timeout. It cannot read the answer (each connection sees only its own
// bytes), cannot complete the flow (no state), and cannot spend a code it stole (no
// verifier).
const {createServer}=require('node:http');
const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');

const LOOPBACK_HOST='127.0.0.1';
const CALLBACK_PATH='/callback';
// What the Azure app registration must carry. Microsoft ignores the PORT of a localhost
// redirect URI when matching it (entra-docs, "Redirect URI (reply URL) best practices and
// limitations", *Localhost exceptions*: the port "is ignored for the purposes of matching
// a localhost redirect URI", and that is "only true for localhost redirect URIs"). That
// exemption is why the redirect URI this launcher asks for says `localhost` while the
// socket it actually holds is bound to 127.0.0.1: `http://127.0.0.1:<port>/callback`
// would be matched literally, port and all, which an ephemeral port can never satisfy.
const REGISTERED_ORIGIN='http://localhost';
const REGISTERED_REDIRECT=REGISTERED_ORIGIN+CALLBACK_PATH;
// The whole wait, from the moment the browser is opened: Microsoft's own authorization
// codes live about ten minutes, and half of that is already a player who has walked away.
const LOOPBACK_TIMEOUT_MS=300000;
// A refused request does not end the flow (see 2 above), so the refusals themselves are
// what has to be bounded: past this many the listener answers nothing more and is closed,
// which turns a flood into one failure instead of an unbounded wait.
const LOOPBACK_REJECT_LIMIT=16;
// A local process can hold a connection open without sending a request; these bound how
// long one connection may take and how many may exist at once.
const LOOPBACK_IDLE_MS=15000;
const LOOPBACK_MAX_CONNECTIONS=8;

const VERIFIER_BYTES=32;
const STATE_BYTES=32;
const PKCE_VERIFIER=/^[-_A-Za-z0-9]{43,128}$/;

// Two sentences, fixed, never interpolated: nothing a request carried is ever written back
// into the page, so a query string cannot become markup. The sign-in answer itself travels
// to the launcher over the socket, not through this page.
const page=(title,message)=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+title+'</title><style>html{font:16px/1.5 system-ui,sans-serif;background:#0d2029;color:#f2f6f7;display:grid;place-items:center;height:100%;margin:0}main{max-width:34rem;padding:2rem;text-align:center}</style></head><body><main><h1>'+title+'</h1><p>'+message+'</p></main></body></html>';
const DONE_PAGE=page('Signed in to Easter Co.','You can close this window and go back to the launcher.');
const REFUSED_PAGE=page('That sign-in did not come from this launcher','Return to the launcher and start signing in again.');

// PKCE, S256: the challenge is all that is ever sent to Microsoft, and the verifier is
// what the code exchange is refused without.
function pkcePair(bytes=VERIFIER_BYTES){
 const verifier=randomBytes(bytes).toString('base64url');
 if(!PKCE_VERIFIER.test(verifier))throw Error('The sign-in verifier was not the shape PKCE requires.');
 return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};
}
function stateToken(bytes=STATE_BYTES){
 return randomBytes(bytes).toString('base64url');
}
// Compared in constant time: a wrong state is refused without saying how close it was.
function sameState(expected,received){
 if(typeof expected!=='string'||typeof received!=='string')return false;
 const a=Buffer.from(expected,'utf8'),b=Buffer.from(received,'utf8');
 return a.length===b.length&&timingSafeEqual(a,b);
}

class LoopbackRedirect{
 constructor({host=LOOPBACK_HOST,path=CALLBACK_PATH,timeoutMs=LOOPBACK_TIMEOUT_MS,rejectLimit=LOOPBACK_REJECT_LIMIT}={}){
  this.host=host;this.path=path;
  this.timeoutMs=Number.isInteger(timeoutMs)&&timeoutMs>0?timeoutMs:LOOPBACK_TIMEOUT_MS;
  this.rejectLimit=Number.isInteger(rejectLimit)&&rejectLimit>0?rejectLimit:LOOPBACK_REJECT_LIMIT;
  this.server=null;this.port=0;this.sockets=new Set();this.rejected=0;this.closed=false;
  this.state='';this.settle=null;this.finished=false;this.answering=null;
  // The answer can arrive before anyone asks for it — the browser is opened and comes back
  // inside the same call that opened it — so both outcomes are kept here rather than dropped
  // on a listener that had no waiter yet.
  this.answer=null;this.failure=null;
 }
 // The address the player's browser will be sent back to. `localhost` on purpose, and only
 // ever as a URI: the listener below is on 127.0.0.1 regardless of how that name resolves.
 get redirectUri(){return REGISTERED_ORIGIN+':'+this.port+this.path;}
 // Bind first, then let the caller open the browser: a browser that is sent to a port with
 // no listener behind it is a sign-in that has already failed.
 listen(){
  return new Promise((resolve,reject)=>{
   const server=createServer((request,response)=>this.accept(request,response));
   server.on('connection',socket=>{
    this.sockets.add(socket);
    socket.on('close',()=>this.sockets.delete(socket));
    if(this.sockets.size>LOOPBACK_MAX_CONNECTIONS)socket.destroy();
   });
   // One connection may not sit there talking to itself: a header that never finishes, or a
   // body that never arrives, is bounded, so the single accepted request cannot be starved.
   server.headersTimeout=LOOPBACK_IDLE_MS;
   server.requestTimeout=LOOPBACK_IDLE_MS;
   server.maxHeadersCount=32;
   server.on('error',error=>{this.server=null;reject(error);});
   server.listen(0,this.host,()=>{
    this.server=server;
    const address=server.address();
    this.port=address&&typeof address==='object'?address.port:0;
    // Bound to what was asked for and to nothing else. This is checked rather than assumed:
    // an operating system that answered a different address than the one requested is a
    // listener this launcher must not use.
    if(!this.port||!address||address.address!==LOOPBACK_HOST){this.close();reject(Error('The sign-in listener was not on the loopback address.'));return;}
    resolve(this);
   });
  });
 }
 // One request, one answer. Anything that is not the callback with this process's own state
 // is refused here and has no other effect.
 accept(request,response){
  const url=new URL(request.url||'/',REGISTERED_ORIGIN);
  // The page reaches the browser before the connection goes: the reply is written, this one
  // socket destroys itself when the answer has flushed, and every other connection is
  // destroyed at once, so no socket outlives the request it was opened for.
  const reply=(status,body)=>{
   const socket=request.socket;
   try{
    response.on('finish',()=>{setImmediate(()=>{try{if(this.answering===socket)this.answering=null;socket?.destroy();}catch{}});});
    response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'",'X-Content-Type-Options':'nosniff'});
    response.end(body);
   }catch{try{socket?.destroy();}catch{}}
  };
  if(this.finished||url.pathname!==this.path){
   // Another path (a browser's own /favicon.ico, a probe by a local process) is not the
   // callback and is not counted as a refusal: it is simply not this listener's business.
   reply(404,'Not found');
   return;
  }
  const received=url.searchParams.get('state')||'';
  if(!this.state||!sameState(this.state,received)){
   this.rejected+=1;
   reply(400,REFUSED_PAGE);
   if(this.rejected>=this.rejectLimit)this.fail(Error('The sign-in listener refused too many requests.'));
   return;
  }
  // The state is this sign-in's, so this is the answer, whichever way it went: Microsoft's
  // own error (a cancelled consent) and its code are the same moment, and the listener ends
  // with either of them.
  const error=url.searchParams.get('error')||'';
  const code=url.searchParams.get('code')||'';
  this.finished=true;
  this.answering=request.socket;
  reply(code&&!error?200:400,code&&!error?DONE_PAGE:REFUSED_PAGE);
  this.close();
  this.finish({code,error,errorDescription:url.searchParams.get('error_description')||''});
 }
 close(){
  if(this.closed)return;
  this.closed=true;
  const server=this.server;this.server=null;
  if(server)try{server.close();}catch{}
  // The socket that is still flushing the player's page is left to finish and destroy
  // itself; every other one goes now.
  for(const socket of this.sockets)if(socket!==this.answering)try{socket.destroy();}catch{}
  this.sockets.clear();
 }
 finish(answer){
  this.answer=answer;
  const settle=this.settle;this.settle=null;
  if(settle)settle.resolve(answer);
 }
 fail(error){
  this.failure=error;
  const settle=this.settle;this.settle=null;
  this.close();
  if(settle)settle.reject(error);
 }
 // The wait itself: bounded from the moment the browser is opened, and ended by a cancel
 // (`signal`) exactly as cleanly as by the answer — the port is closed either way, and the
 // rejection is an AbortError so the caller's cancel path is the one it already has.
 wait(signal){
  if(this.answer)return Promise.resolve(this.answer);
  if(this.failure)return Promise.reject(this.failure);
  if(signal?.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
   let timer=null,onAbort=null;
   const done=()=>{
    if(timer)clearTimeout(timer);
    if(signal&&onAbort)signal.removeEventListener('abort',onAbort);
   };
   this.settle={
    resolve:value=>{done();resolve(value);},
    reject:error=>{done();reject(error);}
   };
   onAbort=()=>{this.fail(abortError());};
   signal?.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(()=>this.fail(timeoutError(this.timeoutMs)),this.timeoutMs);
   if(timer.unref)timer.unref();
  });
 }
 // Sockets are closed even when nobody is waiting any more; a caller that opened the
 // browser and then gave up must not leave a port behind.
 cancel(error=abortError()){this.fail(error);}
}
function abortError(){
 const error=Error('The sign-in was cancelled.');
 error.name='AbortError';
 return error;
}
function timeoutError(timeoutMs){
 const error=Error('The sign-in listener timed out after '+timeoutMs+'ms.');
 error.name='TimeoutError';
 return error;
}

module.exports={
 LoopbackRedirect,pkcePair,stateToken,sameState,abortError,
 LOOPBACK_HOST,CALLBACK_PATH,REGISTERED_ORIGIN,REGISTERED_REDIRECT,
 LOOPBACK_TIMEOUT_MS,LOOPBACK_REJECT_LIMIT,LOOPBACK_IDLE_MS,LOOPBACK_MAX_CONNECTIONS
};
