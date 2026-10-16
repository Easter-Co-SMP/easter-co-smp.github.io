'use strict';
// Local stub of the frozen account API. The real API is not deployed, so every
// account test runs against this server or an address with nothing listening.
const http=require('node:http');
const {AccountClient}=require('../../desktop/accounts.cjs');
const ACCOUNT={id:42,minecraftUuid:'12345678-90ab-cdef-1234-567890abcdef',minecraftName:'TestCaptain',displayName:'Captain Testbeard',roles:['crew'],createdAt:'2026-01-01T00:00:00Z'};
async function startStub(handler){
 const calls=[];
 const server=http.createServer((request,response)=>{
  const chunks=[];
  request.on('data',chunk=>chunks.push(chunk));
  request.on('end',()=>{
   const body=Buffer.concat(chunks).toString('utf8');
   calls.push({method:request.method,url:request.url,headers:request.headers,body});
   handler({request,body,response,url:new URL(request.url,'http://stub')});
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {port}=server.address();
 return {origin:'http://127.0.0.1:'+port,calls,close:()=>new Promise(resolve=>server.close(resolve))};
}
function send(response,status,payload,headers={}){
 const body=payload===undefined?'':typeof payload==='string'?payload:JSON.stringify(payload);
 response.writeHead(status,{'Content-Type':'application/json',...headers});
 response.end(body);
}
function client(origin,options={}){return new AccountClient({baseUrl:origin,client:'launcher/1.0.1',...options});}
function rejects(assert,promise,code){
 return promise.then(()=>assert.fail('expected '+code),error=>{assert.equal(error.code,code);return error;});
}
module.exports={startStub,send,client,rejects,ACCOUNT};
