// Local stub of the frozen game-server routes (doc/launcher-states.md, "The game server,
// which may be asleep"). The cloud side does not exist yet, so every retry, wake and
// readiness test runs against this loopback server instead of the account API origin.
//
// It answers exactly the two routes the contract freezes:
//   GET  /v2/game/status  -> {state, ready, endpoint, since, players, detail}
//   POST /v2/game/wake    -> the same shape, and it records the call
//
// A test tells it what to say with set()/queue(), and proves the launcher woke the server
// exactly once by reading `wakes`. The session token is checked on every request, so a
// test can also prove the launcher authenticated with the Company session and nothing
// else; the token itself never leaves the stub's own record.
import http from 'node:http';
import config from '../../desktop/config.cjs';

// The default agrees with the deployment target. Mismatch tests explicitly supply
// a different endpoint and must prove that it cannot authorise a launch.
export const ENDPOINT=config.serverAddress();
export const TOKEN='fixture-company-session-token';

export function statusBody({state='stopped',ready=null,endpoint=ENDPOINT,since='2026-10-18T00:00:00Z',players=0,detail=''}={}){
 return {state,ready:ready===null?state==='running':Boolean(ready),endpoint,since,players,detail};
}

// options:
//  state      the state the server starts in ('stopped' unless a test says otherwise)
//  ready      an explicit ready flag, so a test can model a running server whose port
//             is not answering yet (state 'running', ready false)
//  script     state words answered by successive status reads, then stuck on the last
//  wakes      what a wake request does: 'status' answers the frozen shape, 'empty'
//             accepts it with 204 and no body, 'error' answers 503
//  statusError  answer every status read with this HTTP status instead
//  token      the session token the routes require
export async function startGameStub(options={}){
 const stub={
  state:options.state||'stopped',
  ready:typeof options.ready==='boolean'?options.ready:null,
  endpoint:options.endpoint||ENDPOINT,
  since:options.since||'2026-10-18T00:00:00Z',
  players:options.players||0,
  detail:options.detail||'',
  token:options.token||TOKEN,
  wakeMode:options.wakes||'status',
  statusError:options.statusError||null,
  script:Array.isArray(options.script)?[...options.script]:[],
  calls:[],
  wakes:[]
 };
 const body=()=>statusBody({
  state:stub.state,
  ready:stub.ready===null?(stub.state==='running'):stub.ready,
  endpoint:stub.endpoint,since:stub.since,players:stub.players,detail:stub.detail
 });
 // The script is the sequence of states the status route answers, in order: the head
 // is answered and popped while another state is behind it, so the last state in the
 // script is the one the server stays in.
 const peek=()=>{
  if(stub.script.length)stub.state=stub.script.length>1?stub.script.shift():stub.script[0];
  return stub.state;
 };
 const server=http.createServer((request,response)=>{
  const chunks=[];
  request.on('data',chunk=>chunks.push(chunk));
  request.on('end',()=>{
   const call={method:request.method,url:request.url,authorization:request.headers.authorization||null,body:Buffer.concat(chunks).toString('utf8')};
   stub.calls.push(call);
   const reply=(status,payload)=>{
    response.writeHead(status,{'Content-Type':'application/json'});
    response.end(payload===undefined?'':JSON.stringify(payload));
   };
   if(call.url==='/v2/game/wake'&&request.method==='POST')stub.wakes.push(call);
   // Both routes are authenticated with the existing Company session token, and the
   // stub refuses anything else rather than pretending a launch would have worked.
   if(call.authorization!=='Bearer '+stub.token)return reply(401,{error:'invalid_session'});
   if(call.url==='/v2/game/status'){
    if(stub.statusError)return reply(stub.statusError,{error:'service_unavailable'});
    peek();
    return reply(200,body());
   }
   if(call.url==='/v2/game/wake'&&request.method==='POST'){
    if(stub.wakeMode==='error')return reply(503,{error:'service_unavailable'});
    // 204: the request was taken and there is nothing to add, which is what a wake
    // with no first poll looks like on the wire.
    if(stub.wakeMode==='empty'){response.writeHead(204);return response.end();}
    // A wake is what starts a cold server: the answer is already the first poll, so the
    // launcher has something to act on without waiting for the next tick.
    if(!stub.script.length&&(stub.state==='stopped'||stub.state==='unknown'))stub.state='starting';
    return reply(200,body());
   }
   return reply(404,{error:'not_found'});
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 stub.origin='http://127.0.0.1:'+server.address().port;
 stub.set=(state,{ready=null}={})=>{stub.state=state;stub.ready=ready;};
 stub.queue=(...states)=>{stub.script=[...states];};
 stub.close=()=>new Promise(resolve=>server.close(resolve));
 return stub;
}
