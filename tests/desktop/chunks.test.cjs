// Chunked content, immutable-chunk skips, resumable single-file transfers and the
// overridable client origin. Everything runs against fixtures and loopback stub
// servers; no upstream download is involved.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {installClient,clientStatus,downloadVerified,createControl,Transfer,chunkList,selectedChunks,pendingChunks,gamePins,installDiff,transferStats,resetTransferStats,partPath}=require('../../desktop/install.cjs');
const {clientOrigin,DEFAULT_CLIENT_ORIGIN}=require('../../desktop/config.cjs');
const {setTimeout:sleep}=require('node:timers/promises');
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
async function tempDir(prefix){return fs.mkdtemp(path.join(os.tmpdir(),prefix));}
// A loopback file server that records every request, so a run that fetched nothing
// can be told apart from one that fetched a file it already had.
async function fileServer(files,{ranges=false}={}){
 const requests=[];
 const server=http.createServer((request,response)=>{
  const name=decodeURIComponent(new URL(request.url,'http://stub').pathname);
  const body=files[name];
  requests.push({path:name,range:request.headers.range||null});
  if(!body){response.writeHead(404);response.end();return;}
  const range=ranges?/^bytes=(\d+)-$/.exec(request.headers.range||''):null;
  if(range){
   const start=Number(range[1]);
   response.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':body.length-start,'Content-Range':'bytes '+start+'-'+(body.length-1)+'/'+body.length});
   response.end(body.subarray(start));
   return;
  }
  response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':body.length});
  response.end(body);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:'http://127.0.0.1:'+server.address().port,requests,close:()=>new Promise(resolve=>server.close(resolve))};
}
function entry(url,relative,body){
 return {id:'easter-navy',name:'Easter Co. client',version:'2.0.0',path:relative,url,hash:'sha256:'+sha256(body),size:body.length};
}
function chunkFixture({base,graphics}){
 return {
  minecraft:'26.2',fabric:'0.19.5',
  mod:{name:'Easter Co. client',version:'2.0.0',sha256:'a'.repeat(64),url:'downloads/easter-navy.jar'},
  dependencies:[{id:'fabric-api',name:'Fabric API',version:'0.161.0+26.2'}],
  chunks:[base,...(graphics?[graphics]:[])]
 };
}
const FABRIC_VERSION='26.2-fabric0.19.5';
// An installed tree whose game install is already complete, so a chunk change never
// reaches out to Mojang.
async function installedTree({chunks={},extraFiles=[]}={}){
 const dir=await tempDir('easter-chunk-');
 const root=path.join(dir,'minecraft');
 const java=path.join(dir,'java');
 await fs.writeFile(java,'#!/bin/sh\n');
 await fs.mkdir(path.join(root,'versions',FABRIC_VERSION),{recursive:true});
 await fs.writeFile(path.join(root,'versions',FABRIC_VERSION,FABRIC_VERSION+'.json'),'{}');
 await fs.mkdir(path.join(root,'mods'),{recursive:true});
 for(const relative of extraFiles){
  const target=path.join(root,relative);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,'');
 }
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify({version:FABRIC_VERSION,minecraft:'26.2',fabric:'0.19.5',java,game:{minecraft:'26.2',fabric:'0.19.5',verified:true},chunks,files:extraFiles,updatedAt:'2026-10-15T00:00:00.000Z'}));
 return {root,java,cleanup:()=>fs.rm(dir,{recursive:true,force:true}),record:()=>JSON.parse(require('node:fs').readFileSync(path.join(root,'installed.json'),'utf8'))};
}

test('the client origin is overridable with the same rule as the API origin',()=>{
 assert.equal(DEFAULT_CLIENT_ORIGIN,'https://easter-co-smp.github.io/');
 assert.equal(clientOrigin(undefined),DEFAULT_CLIENT_ORIGIN);
 assert.equal(clientOrigin(''),DEFAULT_CLIENT_ORIGIN);
 assert.equal(clientOrigin('https://example.test'),'https://example.test/');
 assert.equal(clientOrigin('https://example.test/base///'),'https://example.test/base/');
 // Plaintext is accepted on the loopback interface only, for tests.
 assert.equal(clientOrigin('http://127.0.0.1:8080'),'http://127.0.0.1:8080/');
 assert.equal(clientOrigin('http://localhost:8080/'),'http://localhost:8080/');
 for(const value of ['http://example.test','http://192.168.1.5:8080','ftp://127.0.0.1','example.test','not a url','https://user:pass@example.test'])
  assert.throws(()=>clientOrigin(value),/EASTER_CLIENT_ORIGIN/,value+' must be refused');
});

test('the manifest and its relative chunk files are built from the client origin',async()=>{
 const body=Buffer.from('jar-bytes');
 const server=await fileServer({'/data/client.json':Buffer.from(JSON.stringify(chunkFixture({base:{id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(body),files:[entry('files/base.jar','mods/easter-navy.jar',body)]}}))),'/files/base.jar':body});
 const tree=await installedTree();
 try{
  const result=await installClient({root:tree.root,published:undefined,origin:server.origin,includeGraphics:false});
  assert.equal(result.unchanged,undefined);
  assert.deepEqual(server.requests.map(request=>request.path),['/data/client.json','/files/base.jar'],'the manifest and the relative file both come from the override');
  assert.equal(await fs.readFile(path.join(tree.root,'mods','easter-navy.jar'),'utf8'),'jar-bytes');
 }finally{await server.close();await tree.cleanup();}
});

test('a second run over an installed tree fetches no chunk and reads no frozen content',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await installedTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  // First run: the chunks are not recorded yet, so both are fetched.
  resetTransferStats();
  const first=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  const afterFirst=transferStats();
  assert.equal(first.unchanged,undefined);
  assert.deepEqual(server.requests.map(request=>request.path).sort(),['/files/base.jar','/files/graphics.zip']);
  assert(afterFirst.hashReads>0,'the first run has to verify what it installs');
  assert.equal(afterFirst.bytesFetched,base.length+graphics.length);
  const record=tree.record();
  assert.equal(record.chunks.base.version,'sha256:'+sha256(base));
  assert.equal(record.chunks.graphics.version,'sha256:'+sha256(graphics));
  assert.deepEqual(record.chunks.base.files,['mods/easter-navy.jar']);
  assert.equal(record.chunks.base.immutable,true);
  assert.equal(record.chunks.base.verified,true);
  // Second run: nothing changed anywhere, so nothing is fetched and nothing is read.
  const before=server.requests.length;
  resetTransferStats();
  const second=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  const afterSecond=transferStats();
  assert.equal(second.unchanged,true);
  assert.equal(server.requests.length,before,'a repeat run must fetch no chunk');
  assert.equal(afterSecond.hashReads,0,'a repeat run must not re-hash the frozen files');
  assert.equal(afterSecond.bytesFetched,0);
  // And the update check agrees, quietly.
  const diff=installDiff(published,tree.record(),{includeGraphics:true,origin:server.origin});
  assert.deepEqual(diff,{changed:false,changes:[]},'the update check finds nothing to do');
 }finally{await server.close();await tree.cleanup();}
});

test('a new graphics chunk is fetched alone and the base chunk is left untouched',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle-v1'),newGraphics=Buffer.from('shader-bundle-v2-longer');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':newGraphics});
 const tree=await installedTree({extraFiles:['mods/easter-navy.jar','shaderpacks/graphics.zip']});
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const oldGraphics={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const newGraphicsChunk={...oldGraphics,version:'sha256:'+sha256(newGraphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',newGraphics)]};
  await fs.writeFile(path.join(tree.root,'mods','easter-navy.jar'),base);
  await fs.writeFile(path.join(tree.root,'shaderpacks','graphics.zip'),graphics);
  const record=tree.record();
  record.chunks={base:{id:'base',version:baseChunk.version,immutable:true,files:['mods/easter-navy.jar'],verified:true},graphics:{id:'graphics',version:oldGraphics.version,immutable:false,files:['shaderpacks/graphics.zip'],verified:true}};
  record.files=['mods/easter-navy.jar','shaderpacks/graphics.zip'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const baseBefore=await fs.stat(path.join(tree.root,'mods','easter-navy.jar'));
  const published=chunkFixture({base:baseChunk,graphics:newGraphicsChunk});
  assert.deepEqual(installDiff(published,tree.record(),{includeGraphics:true,origin:server.origin}).changes,['chunk:graphics']);
  resetTransferStats();
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  assert.deepEqual(server.requests.map(request=>request.path),['/files/graphics.zip'],'only the changed chunk is fetched');
  assert.equal(transferStats().hashReads,1,'only the file that changed is read');
  const baseAfter=await fs.stat(path.join(tree.root,'mods','easter-navy.jar'));
  assert.equal(baseAfter.mtimeMs,baseBefore.mtimeMs,'the base chunk file was not touched');
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','graphics.zip'),'utf8'),'shader-bundle-v2-longer');
  const after=tree.record();
  assert.equal(after.chunks.base.version,baseChunk.version,'the base chunk record is unchanged');
  assert.equal(after.chunks.graphics.version,newGraphicsChunk.version);
 }finally{await server.close();await tree.cleanup();}
});

test('switching enhanced graphics off downloads nothing and invalidates nothing',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await installedTree({extraFiles:['mods/easter-navy.jar','shaderpacks/graphics.zip']});
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  await fs.writeFile(path.join(tree.root,'mods','easter-navy.jar'),base);
  await fs.writeFile(path.join(tree.root,'shaderpacks','graphics.zip'),graphics);
  const record=tree.record();
  record.chunks={base:{id:'base',version:baseChunk.version,immutable:true,files:['mods/easter-navy.jar'],verified:true},graphics:{id:'graphics',version:graphicsChunk.version,immutable:false,files:['shaderpacks/graphics.zip'],verified:true}};
  record.files=['mods/easter-navy.jar','shaderpacks/graphics.zip'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const markerBefore=await fs.readFile(path.join(tree.root,'installed.json'),'utf8');
  resetTransferStats();
  const result=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(result.unchanged,true);
  assert.deepEqual(server.requests,[]);
  assert.equal(transferStats().hashReads,0);
  assert.equal(await fs.readFile(path.join(tree.root,'installed.json'),'utf8'),markerBefore,'the marker is not rewritten either');
  const after=tree.record();
  assert.equal(after.chunks.graphics.version,graphicsChunk.version,'the installed graphics record survives the toggle being off');
  assert.deepEqual(after.chunks.base.files,['mods/easter-navy.jar']);
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','graphics.zip'),'utf8'),'shader-bundle','nothing on disk was invalidated');
  // Switching it back on has nothing to do either.
  resetTransferStats();
  const back=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  assert.equal(back.unchanged,true);
  assert.deepEqual(server.requests,[]);
 }finally{await server.close();await tree.cleanup();}
});

test('an optional chunk is never fetched while its toggle is off',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await installedTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.deepEqual(server.requests.map(request=>request.path),['/files/base.jar']);
  assert.equal(tree.record().chunks.graphics,undefined);
  assert.equal(await fs.stat(path.join(tree.root,'shaderpacks','graphics.zip')).then(()=>'present',()=>'absent'),'absent');
 }finally{await server.close();await tree.cleanup();}
});

test('a chunked manifest is validated, and a required chunk must be immutable',()=>{
 const base={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+'a'.repeat(64),files:[entry('files/x.jar','mods/x.jar',Buffer.from('x'))]};
 const published=chunkFixture({base});
 const chunks=chunkList(published,'https://easter-co-smp.github.io/');
 assert.equal(chunks.length,1);
 assert.equal(chunks[0].files[0].algorithm,'sha256');
 assert.equal(chunks[0].files[0].url,'https://easter-co-smp.github.io/files/x.jar');
 assert.deepEqual(selectedChunks(chunks,false).map(c=>c.id),['base']);
 assert.deepEqual(gamePins(chunks),{fabric:'0.19.5',java:null});
 assert.equal(chunkList({minecraft:'26.2'},'https://x/'),null,'a manifest with no chunk list stays valid');
 const broken=[
  [{...base,immutable:false},/must be immutable/],
  [{...base,version:'26.2'},/not a content digest/],
  [{...base,files:[]},/no files/],
  [{...base,files:[{...entry('files/x.jar','mods/x.jar',Buffer.from('x')),hash:'sha256:abc'}]},/truncated checksum/],
  [{...base,files:[{...entry('files/x.jar','../escape.jar',Buffer.from('x'))}]},/invalid file path/],
  [{...base,files:[{...entry('files/x.jar','mods/x.jar',Buffer.from('x')),size:0}]},/size/],
  [{...base,files:[{...entry('http://cdn.example.com/x.jar','mods/x.jar',Buffer.from('x'))}]},/insecure file location/]
 ];
 for(const [chunk,expected] of broken){
  assert.throws(()=>chunkList({...published,chunks:[chunk]},'https://easter-co-smp.github.io/'),expected);
 }
 assert.throws(()=>chunkList({...published,chunks:[base,{...base}]},'https://easter-co-smp.github.io/'),/invalid chunk id/);
 assert.throws(()=>chunkList({...published,chunks:[]},'https://easter-co-smp.github.io/'),/invalid chunk list/);
});

// ---- resumable transfers ----------------------------------------------------
// A stub that dribbles bytes out and honours Range requests.
async function rangeServer(payload,{chunk=8192,delay=15}={}){
 const state={requests:[]};
 const server=http.createServer((request,response)=>{
  const range=/^bytes=(\d+)-$/.exec(request.headers.range||'');
  const start=range?Number(range[1]):0;
  state.requests.push({range:request.headers.range||null,start});
  if(range){
   response.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':payload.length-start,'Content-Range':'bytes '+start+'-'+(payload.length-1)+'/'+payload.length});
  }else response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length});
  let offset=start;
  const timer=setInterval(()=>{
   if(offset>=payload.length){clearInterval(timer);response.end();return;}
   response.write(payload.subarray(offset,offset+chunk));offset+=chunk;
  },delay);
  response.on('close',()=>clearInterval(timer));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:'http://127.0.0.1:'+server.address().port,state,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('an interrupted transfer resumes with a Range request instead of starting the file again',async()=>{
 const payload=crypto.randomBytes(384*1024),hash=sha256(payload);
 const server=await rangeServer(payload);
 const dir=await tempDir('easter-range-');
 const file=path.join(dir,'client.jar');
 const control=createControl();
 let started;const arrived=new Promise(resolve=>{started=resolve;});
 const first=downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{control,onBytes(){started();}});
 try{
  await arrived;await sleep(120);control.cancel();
  await assert.rejects(first,error=>error.name==='CancelledError');
  const partial=await fs.stat(partPath(file));
  assert(partial.size>0&&partial.size<payload.length,'a usable prefix was kept: '+partial.size+' of '+payload.length);
  resetTransferStats();
  const second=await downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{});
  assert.equal(second,true);
  const written=await fs.readFile(file);
  assert.equal(sha256(written),hash,'the resumed file matches its checksum');
  assert.equal(written.equals(payload),true);
  assert.equal(server.state.requests[0].range,null,'the first attempt asked for the whole file');
  const resumed=server.state.requests[1];
  assert.equal(resumed.range,'bytes='+partial.size+'-','the second attempt asked for the rest');
  const fetched=transferStats().bytesFetched;
  assert(fetched<payload.length,'the resumed attempt fetched only the remainder: '+fetched+' of '+payload.length);
  assert(fetched+partial.size>=payload.length,'and together they cover the file');
  assert.deepEqual(await fs.readdir(dir),['client.jar'],'no partial files are left behind');
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a corrupted prefix is discarded rather than trusted, and the file still verifies',async()=>{
 const payload=crypto.randomBytes(256*1024),hash=sha256(payload);
 const server=await rangeServer(payload);
 const dir=await tempDir('easter-corrupt-prefix-');
 const file=path.join(dir,'client.jar');
 const control=createControl();
 let started;const arrived=new Promise(resolve=>{started=resolve;});
 const first=downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{control,onBytes(){started();}});
 try{
  await arrived;await sleep(120);control.cancel();
  await assert.rejects(first,error=>error.name==='CancelledError');
  // Corrupt the prefix in place, keeping its length: the resume must not trust it.
  const part=partPath(file);
  const prefix=await fs.readFile(part);
  await fs.writeFile(part,Buffer.alloc(prefix.length,7));
  const second=await downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{});
  assert.equal(second,true);
  const written=await fs.readFile(file);
  assert.equal(written.equals(payload),true,'the corrupt prefix was thrown away, not trusted');
  assert.equal(sha256(written),hash);
  assert.deepEqual(await fs.readdir(dir),['client.jar']);
  assert(server.state.requests.length>=3,'the corrupt prefix cost one extra attempt, not a wrong file');
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a source that ignores Range is not appended to a prefix it did not continue',async()=>{
 const payload=crypto.randomBytes(128*1024),hash=sha256(payload);
 // This server never answers 206, whatever the request asks for.
 const server=await fileServer({'/client.jar':payload});
 const dir=await tempDir('easter-no-range-');
 const file=path.join(dir,'client.jar');
 try{
  await fs.writeFile(partPath(file),payload.subarray(0,4096));
  await fs.writeFile(partPath(file)+'.json',JSON.stringify({url:server.origin+'/client.jar',hash,algorithm:'sha256'}));
  const result=await downloadVerified(server.origin+'/client.jar',file,hash,'sha256',{});
  assert.equal(result,true);
  assert.equal(server.requests[0].range,'bytes=4096-','the prefix was offered as a range request');
  const written=await fs.readFile(file);
  assert.equal(written.length,payload.length,'the file was written from the start, not appended to the prefix');
  assert.equal(written.equals(payload),true);
  assert.deepEqual(await fs.readdir(dir),['client.jar'],'the abandoned prefix is gone');
 }finally{await server.close();await fs.rm(dir,{recursive:true,force:true});}
});
