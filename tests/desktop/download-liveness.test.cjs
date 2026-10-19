const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {downloadVerified,createControl}=require('../../desktop/install.cjs');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t,handler){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'easter-liveness-'));
 const server=http.createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 const file=path.join(root,'client.jar');await fs.writeFile(file,'previous');
 return {url:'http://127.0.0.1:'+server.address().port+'/client.jar',file};
}
test('an active download can outlast its idle timeout', {timeout:5000},async t=>{
 const payload=Buffer.alloc(24,65);
 const {url,file}=await fixture(t,(_request,response)=>{
  response.writeHead(200,{'Content-Length':payload.length});let sent=0;
  const timer=setInterval(()=>{response.write(payload.subarray(sent,sent+1));if(++sent===payload.length){clearInterval(timer);response.end();}},30);
  response.on('close',()=>clearInterval(timer));
 });
 await downloadVerified(url,file,digest(payload),'sha256',{idleTimeoutMs:250});
 assert.deepEqual(await fs.readFile(file),payload);
});
test('waiting for headers has a bounded idle timeout and keeps the installed file', {timeout:3000},async t=>{
 const {url,file}=await fixture(t,()=>{});
 await assert.rejects(downloadVerified(url,file,digest('new'),'sha256',{idleTimeoutMs:100}),{name:'TimeoutError'});
 assert.equal(await fs.readFile(file,'utf8'),'previous');
});
test('a stalled body times out after the last received bytes', {timeout:3000},async t=>{
 const {url,file}=await fixture(t,(_request,response)=>{response.writeHead(200,{'Content-Length':9});response.write('new');});
 await assert.rejects(downloadVerified(url,file,digest('new-client'),'sha256',{idleTimeoutMs:100}),{name:'TimeoutError'});
 assert.equal(await fs.readFile(file,'utf8'),'previous');
 assert.equal(await fs.readFile(file+'.part','utf8'),'new');
});
test('cancel interrupts a response waiting for headers immediately', {timeout:3000},async t=>{
 let requested;const arrived=new Promise(resolve=>{requested=resolve;});
 const {url,file}=await fixture(t,()=>requested());const control=createControl();
 const download=downloadVerified(url,file,digest('new'),'sha256',{control,idleTimeoutMs:2000});
 const rejection=assert.rejects(download,{name:'CancelledError'});
 await arrived;control.cancel();await rejection;
 assert.equal(await fs.readFile(file,'utf8'),'previous');
 assert.equal(control.listeners.size,0,'a completed transfer releases its subscription');
});
test('a pause while waiting for headers suspends the idle deadline', {timeout:3000},async t=>{
 let requested,respond;const arrived=new Promise(resolve=>{requested=resolve;});
 const payload=Buffer.from('new-client');
 const {url,file}=await fixture(t,(_request,response)=>{respond=()=>response.end(payload);requested();});
 const control=createControl();
 const download=downloadVerified(url,file,digest(payload),'sha256',{control,idleTimeoutMs:150});
 const completion=download.then(value=>({value}),error=>({error}));
 await arrived;control.pause();await sleep(400);control.resume();respond();
 const result=await completion;if(result.error)throw result.error;
 assert.equal(result.value,true);assert.deepEqual(await fs.readFile(file),payload);
 assert.equal(control.listeners.size,0);
});
