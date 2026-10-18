// Chunked content, immutable-chunk skips, resumable single-file transfers and the
// overridable client origin. Everything runs against fixtures and loopback stub
// servers; no upstream download is involved.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {installClient,applyGraphics,clientStatus,downloadVerified,createControl,Transfer,chunkList,selectedChunks,pendingChunks,gamePins,installDiff,transferStats,resetTransferStats,partPath,modFile,graphicsEntry,publishedManifest}=require('../../desktop/install.cjs');
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

test('the environment override is what clientOrigin reads, and a bad one is refused',()=>{
 const saved=process.env.EASTER_CLIENT_ORIGIN;
 try{
  process.env.EASTER_CLIENT_ORIGIN='http://127.0.0.1:8123';
  assert.equal(clientOrigin(),'http://127.0.0.1:8123/','a loopback override from the environment is accepted');
  process.env.EASTER_CLIENT_ORIGIN='https://staging.example.test';
  assert.equal(clientOrigin(),'https://staging.example.test/');
  for(const value of ['http://example.test','http://192.168.1.5','ftp://127.0.0.1','nonsense']){
   process.env.EASTER_CLIENT_ORIGIN=value;
   assert.throws(()=>clientOrigin(),/EASTER_CLIENT_ORIGIN/,value+' must be refused from the environment too');
  }
  delete process.env.EASTER_CLIENT_ORIGIN;
  assert.equal(clientOrigin(),DEFAULT_CLIENT_ORIGIN,'with no override the published origin is used');
 }finally{
  if(saved===undefined)delete process.env.EASTER_CLIENT_ORIGIN;else process.env.EASTER_CLIENT_ORIGIN=saved;
 }
});

test('the manifest URL and the relative mod URL both come from the client origin',async()=>{
 // The manifest.
 const server=await fileServer({'/data/client.json':Buffer.from('{"minecraft":"26.2"}')});
 try{
  const manifest=await publishedManifest(server.origin);
  assert.deepEqual(server.requests.map(request=>request.path),['/data/client.json']);
  assert.equal(manifest.minecraft,'26.2');
  // A client origin that answers nothing fails; it never quietly falls back to the
  // published origin.
  await assert.rejects(publishedManifest('http://127.0.0.1:9'));
 }finally{await server.close();}
 // The mod jar: relative on the manifest, resolved against the origin, and never
 // allowed to leave it.
 const client={mod:{url:'downloads/easter-navy.jar'}};
 assert.equal(modFile(client),'https://easter-co-smp.github.io/downloads/easter-navy.jar');
 assert.equal(modFile(client,'http://127.0.0.1:8123'),'http://127.0.0.1:8123/downloads/easter-navy.jar');
 assert.equal(modFile(client,'http://localhost:8123/'),'http://localhost:8123/downloads/easter-navy.jar');
 for(const url of ['https://evil.example/downloads/easter-navy.jar','downloads/other.jar','/etc/passwd','downloads/../private/easter-navy.jar',''])
  assert.throws(()=>modFile({mod:{url}}),/Unexpected custom mod location/,'refused: '+url);
 // The graphics payload resolves against the same origin.
 const digest='c'.repeat(64);
 const graphics={name:'Enhanced graphics',filename:'graphics.zip',url:'downloads/graphics.zip',sha256:digest};
 assert.equal(graphicsEntry(graphics,'http://127.0.0.1:8123').url,'http://127.0.0.1:8123/downloads/graphics.zip');
 assert.equal(graphicsEntry(graphics).url,'https://easter-co-smp.github.io/downloads/graphics.zip');
 assert.throws(()=>graphicsEntry({...graphics,url:'https://evil.example/graphics.zip'},'http://127.0.0.1:8123'),/Unexpected graphics location/);
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

test('a new base chunk fetches only its own files and never re-reads the frozen game',async()=>{
 const oldJar=Buffer.from('easter-navy-2.0.0'),newJar=Buffer.from('easter-navy-2.0.1-longer');
 const server=await fileServer({'/files/base.jar':newJar});
 const tree=await installedTree({extraFiles:['mods/easter-navy.jar']});
 try{
  const oldBase={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(oldJar),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',oldJar)]};
  const newBase={...oldBase,version:'sha256:'+sha256(newJar),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',newJar)]};
  await fs.writeFile(path.join(tree.root,'mods','easter-navy.jar'),oldJar);
  const record=tree.record();
  record.chunks={base:{id:'base',version:oldBase.version,immutable:true,files:['mods/easter-navy.jar'],verified:true}};
  record.files=['mods/easter-navy.jar'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const gameJson=path.join(tree.root,'versions',FABRIC_VERSION,FABRIC_VERSION+'.json');
  const gameBefore=await fs.stat(gameJson);
  const published=chunkFixture({base:newBase});
  assert.deepEqual(installDiff(published,tree.record(),{includeGraphics:false,origin:server.origin}).changes,['chunk:base']);
  resetTransferStats();
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.deepEqual(server.requests.map(request=>request.path),['/files/base.jar'],'only the changed chunk was fetched');
  assert.equal(transferStats().hashReads,1,'one read: the file that changed');
  assert.equal(await fs.readFile(path.join(tree.root,'mods','easter-navy.jar'),'utf8'),'easter-navy-2.0.1-longer');
  assert.equal((await fs.stat(gameJson)).mtimeMs,gameBefore.mtimeMs,'the frozen game files were not touched');
  const after=tree.record();
  assert.equal(after.chunks.base.version,newBase.version);
  assert.deepEqual(after.game,tree.record().game);
  assert.deepEqual(after.game,{minecraft:'26.2',fabric:'0.19.5',verified:true},'the game pin record is unchanged');
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

test('a chunk version is opaque: it is compared, never parsed',async()=>{
 const body=Buffer.from('base-jar-bytes');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  // A version that is not a digest at all is still a valid identity.
  const odd={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'release-2026-10-16.1',files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]};
  const published=chunkFixture({base:odd});
  assert.equal(chunkList(published,server.origin)[0].version,'release-2026-10-16.1');
  resetTransferStats();
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(tree.record().chunks.base.version,'release-2026-10-16.1','the marker records it verbatim');
  assert.deepEqual(server.requests.map(request=>request.path),['/files/base.jar']);
  // The same opaque version means nothing to do; a different one means fetch again.
  const before=server.requests.length;
  resetTransferStats();
  const repeat=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(repeat.unchanged,true);
  assert.equal(server.requests.length,before);
  assert.equal(transferStats().hashReads,0);
  assert.deepEqual(installDiff(published,tree.record(),{origin:server.origin}),{changed:false,changes:[]});
  assert.deepEqual(installDiff(chunkFixture({base:{...odd,version:'release-2026-10-16.2'}}),tree.record(),{origin:server.origin}).changes,['chunk:base']);
  for(const version of ['','   ',undefined,null,0,{}])
   assert.throws(()=>chunkList(chunkFixture({base:{...odd,version}}),server.origin),/no version/,JSON.stringify(version)+' must be refused');
 }finally{await server.close();await tree.cleanup();}
});

test('a chunk file hash may be sha512 and the parser must not assume sha256',async()=>{
 const body=Buffer.from('a-mod-jar-verified-with-sha512');
 const digest=crypto.createHash('sha512').update(body).digest('hex');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  const base={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'v1',files:[{id:'easter-navy',name:'Easter Co. client',version:'2.0.0',path:'mods/easter-navy.jar',url:server.origin+'/files/base.jar',hash:'sha512:'+digest,size:body.length}]};
  const parsed=chunkList(chunkFixture({base}),server.origin)[0].files[0];
  assert.equal(parsed.algorithm,'sha512');
  assert.equal(parsed.hash,digest);
  const published=chunkFixture({base});
  assert.deepEqual(installDiff(published,{minecraft:'26.2',fabric:'0.19.5',game:{minecraft:'26.2',fabric:'0.19.5'},chunks:{base:{version:'v0'}}}).changes,['chunk:base']);
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(require('node:crypto').createHash('sha512').update(await fs.readFile(path.join(tree.root,'mods','easter-navy.jar'))).digest('hex'),digest,'the sha512 file was verified and installed');
  // A hash that names an algorithm we do not verify is refused rather than guessed.
  for(const hash of ['md5:'+digest,'sha1:'+digest,'sha256:'+digest,'sha512:nothex',digest,'']){
   assert.throws(()=>chunkList(chunkFixture({base:{...base,files:[{...base.files[0],hash}]}}),server.origin),/checksum|truncated/,hash.slice(0,12)+' must be refused');
  }
 }finally{await server.close();await tree.cleanup();}
});

test('a manifest with only a base chunk handles the graphics toggle honestly',async()=>{
 const body=Buffer.from('base-jar-bytes');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  const published=chunkFixture({base:{id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'v1',fabric:'0.19.5',java:25,files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]}});
  assert.equal(chunkList(published,server.origin).length,1);
  assert.deepEqual(gamePins(chunkList(published,server.origin),'0.19.5'),{fabric:'0.19.5',java:25},'the base chunk carries the loader and Java pins');
  assert.throws(()=>gamePins(chunkList(published,server.origin),'9.9.9'),/disagrees about the Fabric pin/,'a manifest that contradicts the chunk is refused, not resolved');
  // The install completes normally with the toggle on and says what is missing.
  const result=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  assert.match(result.message,/not published yet/,'the honest message: '+result.message);
  assert.equal(result.graphics,null);
  assert.equal(result.includeGraphics,true,'the toggle is still reported back');
  assert.equal(tree.record().chunks.graphics,undefined,'no graphics record was invented');
  assert.deepEqual(server.requests.map(request=>request.path),['/files/base.jar'],'nothing extra was fetched');
  assert.equal(await fs.stat(path.join(tree.root,'shaderpacks')).then(()=>'present',()=>'absent'),'absent');
  // A manifest whose flat Fabric field contradicts the base chunk is refused
  // rather than resolved by picking one.
  const conflicting={...published,fabric:'0.19.6'};
  assert.throws(()=>gamePins(chunkList(conflicting,server.origin),conflicting.fabric),/disagrees about the Fabric pin/,'the rule itself refuses the contradiction');
  await assert.rejects(installClient({root:tree.root,published:conflicting,origin:server.origin,includeGraphics:false}),/disagrees about the Fabric pin/,'so does the pipeline');
  assert.deepEqual(installDiff(published,tree.record(),{origin:server.origin}),{changed:false,changes:[]},'the agreeing manifest is still the quiet case');
  // And a second run that finds nothing to do repeats it rather than failing.
  const second=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true});
  assert.equal(second.unchanged,true);
  assert.match(second.graphicsMessage,/not published yet/);
  // With the toggle off there is nothing to say.
  const off=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(off.graphicsMessage,null);
  assert.doesNotMatch(off.message||'',/not published yet/);
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
  [{...base,version:'   '},/no version/],
  [{...base,name:''},/no name/],
  [{...base,fabric:19},/invalid fabric pin/],
  [{...base,java:'25'},/invalid Java pin/],
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

// ---- the enhanced graphics toggle -------------------------------------------
// applyGraphics is the toggle's own entry point: the optional goods chunk through
// the same checksum-verified pipeline, the client's quality settings written inside
// the app-owned tree, and nothing else touched in either direction.
async function graphicsTree({extraFiles=[]}={}){
 const fixture=await installedTree({extraFiles:['mods/easter-navy.jar',...extraFiles]});
 await fs.writeFile(path.join(fixture.root,'.easter-client'),'');
 return fixture;
}

test('turning enhanced graphics on fetches only the graphics chunk and writes the quality files',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle-v1');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await graphicsTree();
 try{
  await fs.writeFile(path.join(tree.root,'.easter-client'),'');
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const record=tree.record();
  record.chunks={base:{id:'base',version:baseChunk.version,immutable:true,files:['mods/easter-navy.jar'],verified:true}};
  record.files=['mods/easter-navy.jar'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const baseBefore=await fs.stat(path.join(tree.root,'mods','easter-navy.jar'));
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  const progress=[];
  const result=await applyGraphics({root:tree.root,published,origin:server.origin,includeGraphics:true,control:createControl(),notify:patch=>progress.push(patch),hardware:{vramMB:8188,tier:'capable'}});
  assert.deepEqual(server.requests.map(request=>request.path),['/files/graphics.zip'],'only the optional chunk was fetched');
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','graphics.zip'),'utf8'),'shader-bundle-v1');
  assert.equal((await fs.stat(path.join(tree.root,'mods','easter-navy.jar'))).mtimeMs,baseBefore.mtimeMs,'the base chunk was not touched');
  assert.equal(tree.record().chunks.base.version,baseChunk.version,'nor its record');
  assert.equal(tree.record().graphics,graphicsChunk.version);
  // The sticky bar carries the transfer through the same progress shape as every
  // other download.
  const reported=progress.filter(patch=>patch.progress);
  assert(reported.length>0,'the toggle reports progress');
  for(const patch of reported)for(const field of ['label','percent','bytesDone','bytesTotal','bytesPerSecond','etaSeconds'])assert.equal(field in patch.progress,true,'progress.'+field);
  assert.match(reported[0].progress.label,/Enhanced graphics/);
  assert.equal(reported.some(patch=>patch.progress.bytesTotal===graphics.length),true,'the transfer knows its size');
  assert.equal(reported.some(patch=>patch.progress.bytesDone===graphics.length),true,'and reports the bytes it moved');
  // The quality settings are inside the client tree, derived from the reported memory.
  assert.deepEqual({renderDistance:result.quality.renderDistance,shadowDistance:result.quality.shadowDistance,shaders:result.quality.shaders},{renderDistance:16,shadowDistance:12,shaders:true});
  assert.match(await fs.readFile(path.join(tree.root,'options.txt'),'utf8'),/^renderDistance:16$/m);
  const iris=await fs.readFile(path.join(tree.root,'config','iris.properties'),'utf8');
  assert.match(iris,/^enableShaders:true$/m);
  assert.match(iris,/^shaderPack:ComplementaryUnbound_r5\.9\.3\.zip$/m);
  assert.match(iris,/^shadowDistance:12$/m);
  // A second toggle-on with nothing changed fetches nothing and reports nothing new.
  const before=server.requests.length;
  const again=await applyGraphics({root:tree.root,published,origin:server.origin,includeGraphics:true,hardware:{vramMB:8188,tier:'capable'}});
  assert.equal(server.requests.length,before,'a repeat toggle-on fetches nothing');
  assert.equal(again.unchanged,true);
  assert.deepEqual({...again.quality},{renderDistance:16,shadowDistance:12,shaders:true},'the tuned record is reported again without a further download');
 }finally{await server.close();await tree.cleanup();}
});

test('turning enhanced graphics off fetches nothing, deletes nothing and leaves the base chunk verified',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle-v1');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await graphicsTree({extraFiles:['shaderpacks/graphics.zip']});
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const record=tree.record();
  record.chunks={base:{id:'base',version:baseChunk.version,immutable:true,files:['mods/easter-navy.jar'],verified:true},graphics:{id:'graphics',version:graphicsChunk.version,immutable:false,files:['shaderpacks/graphics.zip'],verified:true}};
  record.files=['mods/easter-navy.jar','shaderpacks/graphics.zip'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  await fs.writeFile(path.join(tree.root,'shaderpacks','graphics.zip'),graphics);
  await fs.writeFile(path.join(tree.root,'options.txt'),'renderDistance:14\nfov:0.5\n');
  const markerBefore=await fs.readFile(path.join(tree.root,'installed.json'),'utf8');
  const optionsBefore=await fs.readFile(path.join(tree.root,'options.txt'),'utf8');
  resetTransferStats();
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  const result=await applyGraphics({root:tree.root,published,origin:server.origin,includeGraphics:false,hardware:{vramMB:8188,tier:'capable'}});
  assert.deepEqual(server.requests,[],'switching off downloads nothing at all');
  assert.equal(transferStats().hashReads,0,'and re-verifies nothing');
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','graphics.zip'),'utf8'),'shader-bundle-v1','the installed shader pack is kept, not deleted');
  assert.equal(await fs.readFile(path.join(tree.root,'installed.json'),'utf8'),markerBefore,'the marker is not rewritten');
  assert.equal(await fs.readFile(path.join(tree.root,'options.txt'),'utf8'),optionsBefore,'and the client settings are untouched');
  assert.equal(result.includeGraphics,false);
  assert.match(result.message,/off/i);
  assert.equal(tree.record().chunks.graphics.version,graphicsChunk.version,'the graphics record survives the toggle being off');
  assert.equal(tree.record().chunks.base.version,baseChunk.version,'the base chunk is still the verified one');
  // The base chunk is still considered current, so a later check has nothing to do.
  assert.deepEqual(installDiff(published,tree.record(),{includeGraphics:false,origin:server.origin}),{changed:false,changes:[]});
 }finally{await server.close();await tree.cleanup();}
});

test('with no graphics chunk published the toggle says so instead of claiming shaders',async()=>{
 const base=Buffer.from('base-mod-jar');
 const server=await fileServer({'/files/base.jar':base});
 const tree=await graphicsTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const record=tree.record();
  record.chunks={base:{id:'base',version:baseChunk.version,immutable:true,files:['mods/easter-navy.jar'],verified:true}};
  record.files=['mods/easter-navy.jar'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const published=chunkFixture({base:baseChunk});
  resetTransferStats();
  const result=await applyGraphics({root:tree.root,published,origin:server.origin,includeGraphics:true,hardware:{vramMB:8188,tier:'capable'}});
  assert.deepEqual(server.requests,[],'nothing is fetched, and certainly not the frozen base chunk');
  assert.equal(result.graphicsAvailable,false);
  assert.match(result.message,/not published yet/);
  assert.match(result.graphicsMessage,/not published yet/);
  assert.doesNotMatch(result.message,/\binstalled\./);
  assert.equal(tree.record().chunks.graphics,undefined,'no graphics record was invented');
  assert.equal(await fs.stat(path.join(tree.root,'shaderpacks')).then(()=>'present',()=>'absent'),'absent');
  assert.deepEqual({...result.quality},{renderDistance:16,shadowDistance:12,shaders:false},'the render settings are still tuned, without promising shaders');
  const iris=await fs.readFile(path.join(tree.root,'config','iris.properties'),'utf8');
  assert.match(iris,/^enableShaders:false$/m);
  assert.equal(/shaderPack/.test(iris),false,'no shader pack is named when none was fetched');
 }finally{await server.close();await tree.cleanup();}
});

test('the graphics toggle refuses a client that is not installed',async()=>{
 const dir=await tempDir('easter-graphics-missing-');
 const root=path.join(dir,'minecraft');
 await fs.mkdir(root,{recursive:true});
 try{
  await assert.rejects(applyGraphics({root,includeGraphics:true,fetchManifest:async()=>({minecraft:'26.2',chunks:[]})}),/Download the game/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
// ---- the toggle against the published manifest shape -------------------------
// The manifest the exporter publishes, read from the sibling worktree when it is
// present so the case cannot be satisfied by a fixture that agrees with the parser
// instead of with what ships. Its one remote file is served from the loopback stub.
const PUBLISHED_MANIFEST_PATH='/root/wt-launcher-graphics/site/data/client.json';
const PUBLISHED_GRAPHICS_SHAPE={
 minecraft:'26.2',fabric:'0.19.5',
 mod:{name:'Easter Co. Mod Pack: Guards & Villagers',version:'2.0.0',sha256:'1'.repeat(64),url:'downloads/easter-navy.jar'},
 dependencies:[],
 chunks:[
  {id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+'0'.repeat(64),fabric:'0.19.5',java:25,files:[{id:'easter-navy',name:'Easter Co. Mod Pack: Guards & Villagers',version:'2.0.0',path:'downloads/easter-navy.jar',url:'downloads/easter-navy.jar',hash:'sha256:'+'1'.repeat(64),size:656819}]},
  {id:'graphics',name:'Complementary Shaders - Unbound for Minecraft 26.2',optional:true,immutable:false,version:'sha256:'+'2'.repeat(64),files:[{id:'R6NEzAwj',name:'Complementary Shaders - Unbound',version:'r5.9.3',path:'shaderpacks/ComplementaryUnbound_r5.9.3.zip',url:'https://cdn.modrinth.com/data/R6NEzAwj/versions/B1kyfoUZ/ComplementaryUnbound_r5.9.3.zip',hash:'sha512:'+'3'.repeat(128),size:553400}]}
 ]
};
function publishedManifestFixture(){
 try{return JSON.parse(require('node:fs').readFileSync(PUBLISHED_MANIFEST_PATH,'utf8'));}
 catch{return PUBLISHED_GRAPHICS_SHAPE;}
}
function progressLabels(patches){return patches.map(patch=>patch.progress&&patch.progress.label).filter(Boolean);}

test('the toggle fetches the published graphics chunk and reports it as available',async()=>{
 const published=publishedManifestFixture();
 const graphicsChunk=published.chunks.find(chunk=>chunk.id==='graphics');
 assert(graphicsChunk&&graphicsChunk.optional===true,'the published manifest carries an optional graphics chunk');
 assert.equal('graphics' in published,false,'the bundle is a chunk, not a top-level field');
 assert.equal(graphicsChunk.files[0].path,'shaderpacks/ComplementaryUnbound_r5.9.3.zip');
 const body=Buffer.from('published-complementary-shaders-fixture');
 const server=await fileServer({'/shaderpacks/ComplementaryUnbound_r5.9.3.zip':body});
 const tree=await graphicsTree();
 try{
  // The one remote URL is answered by the loopback stub at the path the chunk names.
  const manifest={...published,chunks:published.chunks.map(chunk=>chunk.id!=='graphics'?chunk:{...chunk,files:chunk.files.map(file=>({...file,url:server.origin+'/'+file.path,hash:'sha256:'+sha256(body),size:body.length}))})};
  assert.deepEqual(chunkList(manifest,server.origin).map(chunk=>chunk.id),published.chunks.map(chunk=>chunk.id));
  const record=tree.record();
  record.chunks={base:{id:'base',version:manifest.chunks.find(chunk=>chunk.id==='base').version,immutable:true,files:['mods/easter-navy.jar'],verified:true}};
  record.files=['mods/easter-navy.jar'];
  await fs.writeFile(path.join(tree.root,'installed.json'),JSON.stringify(record));
  const baseBefore=await fs.stat(path.join(tree.root,'mods','easter-navy.jar'));
  const progress=[];
  const result=await applyGraphics({root:tree.root,published:manifest,origin:server.origin,includeGraphics:true,control:createControl(),notify:patch=>progress.push(patch),hardware:{vramMB:8188,tier:'capable'}});
  assert.equal(result.graphicsAvailable,true,'the published chunk is reported as available');
  assert.doesNotMatch(result.message||'',/not published yet/,'and not as missing');
  assert.match(result.message||'',/installed/);
  assert.deepEqual(server.requests.map(request=>request.path),['/shaderpacks/ComplementaryUnbound_r5.9.3.zip'],'only the shader file was fetched');
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','ComplementaryUnbound_r5.9.3.zip'),'utf8'),'published-complementary-shaders-fixture','the shader pack landed where the chunk said');
  assert.equal(tree.record().chunks.graphics.version,graphicsChunk.version);
  assert.equal((await fs.stat(path.join(tree.root,'mods','easter-navy.jar'))).mtimeMs,baseBefore.mtimeMs,'the base chunk was not touched');
  assert.equal(progressLabels(progress).some(label=>/Unbound|graphics/i.test(label)),true,'the sticky bar carried the transfer: '+JSON.stringify(progressLabels(progress)));
  // The settings name exactly the pack the chunk delivered.
  const iris=await fs.readFile(path.join(tree.root,'config','iris.properties'),'utf8');
  assert.match(iris,/^shaderPack:ComplementaryUnbound_r5\.9\.3\.zip$/m);
  assert.match(iris,/^enableShaders:true$/m);
  // Switching it off afterwards keeps the shader pack and fetches nothing.
  const before=server.requests.length;
  const off=await applyGraphics({root:tree.root,published:manifest,origin:server.origin,includeGraphics:false,hardware:{vramMB:8188,tier:'capable'}});
  assert.equal(server.requests.length,before,'nothing is fetched when the toggle goes off');
  assert.equal(await fs.readFile(path.join(tree.root,'shaderpacks','ComplementaryUnbound_r5.9.3.zip'),'utf8'),'published-complementary-shaders-fixture');
  assert.equal(off.includeGraphics,false);
 }finally{await server.close();await tree.cleanup();}
});

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

// Published download paths must not become the local mod installation paths.
test('published JAR paths install into mods and legacy markers request repair',async()=>{
 const body=Buffer.from('fixture-mod');
 const server=await fileServer({'/files/mod.jar':body});
 const fixture=await installedTree();
 try{
  const base={id:'base',name:'Minecraft 26.2',optional:false,immutable:true,version:'fixture-v1',fabric:'0.19.5',java:25,files:[entry(server.origin+'/files/mod.jar','downloads/easter-navy.jar',body),entry(server.origin+'/files/mod.jar','dependency.jar',body)]};
  const published=chunkFixture({base});
  const record=fixture.record();
  record.chunks={base:{version:'fixture-v1',files:['downloads/easter-navy.jar','dependency.jar'],verified:true}};
  await fs.writeFile(path.join(fixture.root,'installed.json'),JSON.stringify(record));
  assert.deepEqual(installDiff(published,record,{origin:server.origin}).changes,['chunk:base']);
  await installClient({root:fixture.root,published,origin:server.origin});
  assert.equal((await clientStatus(fixture.root)).installed,true);
  assert.equal(await fs.readFile(path.join(fixture.root,'mods/easter-navy.jar'),'utf8'),'fixture-mod');
  assert.equal(await fs.readFile(path.join(fixture.root,'mods/dependency.jar'),'utf8'),'fixture-mod');
  assert.equal(installDiff(published,fixture.record(),{origin:server.origin}).changed,false);
 }finally{await server.close();await fixture.cleanup();}
});

// ---- the client's display defaults -------------------------------------------
// Owen asked for a first launch that is already fullscreen at GUI scale 2, and later for
// the controls the household plays with: sprint and crouch swapped from vanilla, inventory
// on tab, the player list on the grave key that frees, third person on R, chat on enter,
// the GUI toggle on F10, social interactions on I, smooth camera on right shift, the
// vanilla debug keys unbound, and the Shippy Ships quick-build hotkey moved off the Left
// Ctrl that crouch owns. The seed is not a graphics choice, so every case here runs with
// the toggle off, and the second one starts from a tree that has already been played: the
// game writes every key on its first exit, and that tree is where the feature has to be
// observable.
const {parseProperties}=require('../../desktop/hardware.cjs');
const PLAYED_OPTIONS='version:4903\nao:true\nfullscreen:false\nguiScale:4\nfov:0.5\nrenderDistance:12\ngraphicsMode:fancy\n';
// The values Owen verified in the real clients. A fresh tree gets everything except the
// one binding only a mod can register.
const DEFERRED_KEY='key_key.shippy-ships.isPressingCtrl';
const DEBUG_BINDINGS=[
 'key_key.debug.clearChat',
 'key_key.debug.copyLocation',
 'key_key.debug.copyRecreateCommand',
 'key_key.debug.crash',
 'key_key.debug.debugOptions',
 'key_key.debug.dumpDynamicTextures',
 'key_key.debug.dumpVersion',
 'key_key.debug.focusPause',
 'key_key.debug.fpsCharts',
 'key_key.debug.lightmapTexture',
 'key_key.debug.modifier',
 'key_key.debug.networkCharts',
 'key_key.debug.overlay',
 'key_key.debug.profiling',
 'key_key.debug.profilingChart',
 'key_key.debug.reloadChunk',
 'key_key.debug.reloadResourcePacks',
 'key_key.debug.showAdvancedTooltips',
 'key_key.debug.showChunkBorders',
 'key_key.debug.showHitboxes',
 'key_key.debug.spectate',
 'key_key.debug.switchGameMode'
];
const WANTED_BINDS={
 'key_key.sneak':'key.keyboard.left.control',
 'key_key.sprint':'key.keyboard.left.shift',
 'key_key.inventory':'key.keyboard.tab',
 'key_key.playerlist':'key.keyboard.grave.accent',
 'key_key.togglePerspective':'key.keyboard.r',
 'key_key.chat':'key.keyboard.enter',
 'key_key.toggleGui':'key.keyboard.f10',
 'key_key.socialInteractions':'key.keyboard.i',
 'key_key.smoothCamera':'key.keyboard.right.shift',
 ...Object.fromEntries(DEBUG_BINDINGS.map(key=>[key,'key.keyboard.unknown'])),
 [DEFERRED_KEY]:'key.keyboard.right.control'
};
const bindLines=binds=>Object.entries(binds).map(([key,value])=>key+':'+value);
const SEEDED_BINDINGS=Object.keys(WANTED_BINDS);
// What a fresh tree gets: everything except the binding only a mod can register.
const IMMEDIATE_BINDINGS=SEEDED_BINDINGS.filter(key=>key!==DEFERRED_KEY);
const immediateBinds=()=>Object.fromEntries(IMMEDIATE_BINDINGS.map(key=>[key,WANTED_BINDS[key]]));
const SEEDED_BINDS=bindLines(immediateBinds()).join('\n')+'\n';
const DEFERRED_VANILLA=DEFERRED_KEY+':key.keyboard.left.control';
const DEFERRED_SEEDED=DEFERRED_KEY+':key.keyboard.right.control';
const SEVEN_KEYS={'key_key.sneak':WANTED_BINDS['key_key.sneak'],'key_key.sprint':WANTED_BINDS['key_key.sprint'],'key_key.inventory':WANTED_BINDS['key_key.inventory'],'key_key.playerlist':WANTED_BINDS['key_key.playerlist'],'key_key.togglePerspective':WANTED_BINDS['key_key.togglePerspective']};
const optionsFile=root=>path.join(root,'options.txt');
const displayRecordFile=root=>path.join(root,'.easter-client-display');
const shown=text=>text.split('\n').filter(Boolean);
// No two actions may end up on one key: inventory takes tab, which vanilla gives the
// player list, so the seed has to move both or neither.
function assertDistinctBindings(text,label){
 const options=parseProperties(text);
 for(const key of DEBUG_BINDINGS)assert.equal(options.get(key),'key.keyboard.unknown',label+': '+key+' is unbound');
 const absent=IMMEDIATE_BINDINGS.filter(key=>!options.has(key));
 assert.deepEqual(absent,[],label+': every seeded action has a binding');
 // The deferred key is only there once the client has written it, so it joins the check
 // when it is present and is never missed when it is not.
 const bound=[...IMMEDIATE_BINDINGS,...(options.has(DEFERRED_KEY)?[DEFERRED_KEY]:[])].filter(key=>!DEBUG_BINDINGS.includes(key)).map(key=>[key,options.get(key)]);
 const values=bound.map(([,value])=>value).filter(value=>value!=='key.keyboard.unknown');
 assert.equal(new Set(values).size,values.length,label+': no two seeded actions share a key: '+JSON.stringify(bound));
}

test('an install seeds the display defaults with enhanced graphics off, and only once',async()=>{
 const body=Buffer.from('base-mod-jar');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(body),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]};
  const published=chunkFixture({base:baseChunk});
  const result=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  assert.equal(result.unchanged,undefined);
  // Read the file itself: the defaults are on disk, not merely intended.
  const options=await fs.readFile(optionsFile(tree.root),'utf8');
  assert.deepEqual(shown(options),['guiScale:2','fullscreen:true',...bindLines(immediateBinds())],'the toggle was off and they were written anyway, bindings included');
  assert.equal(options.includes(DEFERRED_KEY),false,'and the mod’s own key is not invented before the client has written it');
  assert.equal(options.includes('\r'),false,'LF line endings');
  assert.equal((await fs.stat(optionsFile(tree.root))).mode&0o777,0o600,'the mode the existing settings writer uses');
  assertDistinctBindings(options,'an install');
  assert.equal(await fs.stat(path.join(tree.root,'config','iris.properties')).then(()=>'present',()=>'absent'),'absent','the graphics step wrote nothing');
  const record=JSON.parse(await fs.readFile(displayRecordFile(tree.root),'utf8'));
  assert.equal(record.schema,3,'the record covers the whole approved set, not only the display pair');
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...immediateBinds()},'and it covers exactly what it wrote');
  assert.equal(DEFERRED_KEY in record.values,false,'the deferred key is not claimed before the client has written it');
  // A second install/update run rewrites neither the file nor the record.
  const past=new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(optionsFile(tree.root),past,past);
  await fs.utimes(displayRecordFile(tree.root),past,past);
  const optionsBefore=await fs.readFile(optionsFile(tree.root));
  resetTransferStats();
  const repeat=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  assert.equal(repeat.unchanged,true);
  assert.deepEqual(await fs.readFile(optionsFile(tree.root)),optionsBefore,'the file is byte-identical');
  assert.equal((await fs.stat(optionsFile(tree.root))).mtimeMs,past.getTime(),'a repeat run does not rewrite options.txt');
  assert.equal((await fs.stat(displayRecordFile(tree.root))).mtimeMs,past.getTime(),'nor its record');
  assert.equal(transferStats().hashReads,0);
 }finally{await server.close();await tree.cleanup();}
});

test('an install seeds a tree that has already been played once, and a later player choice survives',async()=>{
 const body=Buffer.from('base-mod-jar');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  // The client this launcher already installed and the player has already launched:
  // the game wrote every key, including its own fullscreen:false and guiScale:4.
  await fs.writeFile(optionsFile(tree.root),PLAYED_OPTIONS);
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(body),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]};
  const published=chunkFixture({base:baseChunk});
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  const seededOnce=PLAYED_OPTIONS.replace('fullscreen:false','fullscreen:true').replace('guiScale:4','guiScale:2')+SEEDED_BINDS;
  assert.equal(await fs.readFile(optionsFile(tree.root),'utf8'),seededOnce,'seeded once, every other line kept exactly where it was, with the household binds added');
  assertDistinctBindings(seededOnce,'a played tree');
  assert.equal(await fs.stat(displayRecordFile(tree.root)).then(()=>'present',()=>'absent'),'present','the seed is remembered in the tree');
  const recordStat=await fs.stat(displayRecordFile(tree.root));
  // The player plays again and turns fullscreen back off in the game's own settings.
  const chosen=seededOnce.replace('fullscreen:true','fullscreen:false');
  await fs.writeFile(optionsFile(tree.root),chosen);
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  assert.equal(await fs.readFile(optionsFile(tree.root),'utf8'),chosen,'a later update never re-decides a player’s choice');
  assert.equal((await fs.stat(displayRecordFile(tree.root))).mtimeMs,recordStat.mtimeMs,'and the record is written only once');
  // A key that goes missing is repaired through the install path too, bindings included.
  await fs.writeFile(optionsFile(tree.root),'ao:true\nfullscreen:false\n');
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  const repairedUp='ao:true\nfullscreen:false\nguiScale:2\n'+SEEDED_BINDS;
  assert.equal(await fs.readFile(optionsFile(tree.root),'utf8'),repairedUp,'the missing keys came back, bindings included, and the present one was not touched');
  assertDistinctBindings(repairedUp,'a repair through the install path');
 }finally{await server.close();await tree.cleanup();}
});

// The rest of the approved set came after the first controls shipped, so a tree the
// previous build seeded carries a schema-2 record and, if the client has run with the mod
// since, the Shippy Ships hotkey the mod registered on Left Ctrl. The install path may add
// exactly the keys the record does not cover once, must take the mod's key off the Left
// Ctrl that crouch owns, and must not re-decide the guiScale and fullscreen the player has
// since chosen.
test('an install upgrades a schema-2 tree by adding only the keys it does not cover, once',async()=>{
 const body=Buffer.from('base-mod-jar');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  await fs.writeFile(path.join(tree.root,'.easter-client'),'');
  // A tree the earlier seed had already run on, since played with windowed mode and a
  // scale of the player's own, carrying the seven keys it covered and the mod's own key.
  const before=['version:4903','fullscreen:false','guiScale:1',...bindLines(SEVEN_KEYS),DEFERRED_VANILLA,'fov:0.5'].join('\n')+'\n';
  await fs.writeFile(optionsFile(tree.root),before);
  const appliedAt='2026-10-18T09:00:00.000Z';
  await fs.writeFile(displayRecordFile(tree.root),JSON.stringify({schema:2,values:{guiScale:'2',fullscreen:'true',...SEVEN_KEYS},appliedAt},null,2)+'\n',{mode:0o600});
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(body),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]};
  const published=chunkFixture({base:baseChunk});
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  const grown=IMMEDIATE_BINDINGS.filter(key=>!(key in SEVEN_KEYS));
  const expected=['version:4903','fullscreen:false','guiScale:1',...bindLines(SEVEN_KEYS),DEFERRED_SEEDED,'fov:0.5',...bindLines(Object.fromEntries(grown.map(key=>[key,WANTED_BINDS[key]])))].join('\n')+'\n';
  assert.equal(await fs.readFile(optionsFile(tree.root),'utf8'),expected,'exactly the keys the record did not cover, the mod’s hotkey moved in place, and the player’s own scale and window mode untouched');
  assertDistinctBindings(expected,'a schema-2 upgrade through the install path');
  const record=JSON.parse(await fs.readFile(displayRecordFile(tree.root),'utf8'));
  assert.equal(record.schema,3);
  assert.equal(record.appliedAt,appliedAt,'the seed time does not move');
  assert.deepEqual(record.values,{guiScale:'2',fullscreen:'true',...WANTED_BINDS},'and every key in the table is covered now');
  // Exactly once: the next update run rewrites neither file.
  const past=new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(optionsFile(tree.root),past,past);
  await fs.utimes(displayRecordFile(tree.root),past,past);
  const optionsBefore=await fs.readFile(optionsFile(tree.root));
  const repeat=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  assert.equal(repeat.unchanged,true);
  assert.deepEqual(await fs.readFile(optionsFile(tree.root)),optionsBefore,'byte-identical');
  assert.equal((await fs.stat(optionsFile(tree.root))).mtimeMs,past.getTime());
  assert.equal((await fs.stat(displayRecordFile(tree.root))).mtimeMs,past.getTime());
 }finally{await server.close();await tree.cleanup();}
});

// The one binding a mod owns is deferred: it does not exist in options.txt until the mod
// has registered it, and vanilla drops a key_ entry it never read. Through the install
// path that means a fresh tree gets everything else, and the Shippy hotkey is fixed on the
// first launcher run after the client has written the line — once, and never again.
test('an install seeds the Shippy Ships hotkey only once the client has written it',async()=>{
 const body=Buffer.from('base-mod-jar');
 const server=await fileServer({'/files/base.jar':body});
 const tree=await installedTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(body),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',body)]};
  const published=chunkFixture({base:baseChunk});
  // The client has never run with the mod: there is no such line, so none is invented.
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false});
  const first=await fs.readFile(optionsFile(tree.root),'utf8');
  assert.deepEqual(shown(first),['guiScale:2','fullscreen:true',...bindLines(immediateBinds())]);
  assert.equal(first.includes(DEFERRED_KEY),false,'the install does not invent the mod’s key');
  assert.equal(DEFERRED_KEY in JSON.parse(await fs.readFile(displayRecordFile(tree.root),'utf8')).values,false);
  // The client runs once with the mod, which registers the hotkey on its own default.
  const withMod=first+DEFERRED_VANILLA+'\n';
  await fs.writeFile(optionsFile(tree.root),withMod);
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  const seeded=await fs.readFile(optionsFile(tree.root),'utf8');
  assert.equal(seeded,withMod.replace(DEFERRED_VANILLA,DEFERRED_SEEDED),'only the mod’s own line changed: the hotkey is off Left Ctrl, and crouch keeps it');
  assertDistinctBindings(seeded,'the deferred key through the install path');
  const record=JSON.parse(await fs.readFile(displayRecordFile(tree.root),'utf8'));
  assert.equal(record.schema,3);
  assert.equal(record.values[DEFERRED_KEY],'key.keyboard.right.control','and the record covers it once it has been written');
  // Once only: the next run, and a player’s own rebind, are both left alone.
  const optionsStat=await fs.stat(optionsFile(tree.root));
  const recordStat=await fs.stat(displayRecordFile(tree.root));
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  assert.equal((await fs.stat(optionsFile(tree.root))).mtimeMs,optionsStat.mtimeMs,'a repeat run does not rewrite options.txt');
  assert.equal((await fs.stat(displayRecordFile(tree.root))).mtimeMs,recordStat.mtimeMs);
  const rebound=seeded.replace(DEFERRED_SEEDED,DEFERRED_VANILLA);
  await fs.writeFile(optionsFile(tree.root),rebound);
  await installClient({root:tree.root,published,origin:server.origin,includeGraphics:false,mode:'update'});
  assert.equal(await fs.readFile(optionsFile(tree.root),'utf8'),rebound,'a player’s own rebind of a covered key survives every update');
 }finally{await server.close();await tree.cleanup();}
});

test('the display defaults are written alongside the graphics step, not instead of it',async()=>{
 const base=Buffer.from('base-mod-jar'),graphics=Buffer.from('shader-bundle');
 const server=await fileServer({'/files/base.jar':base,'/files/graphics.zip':graphics});
 const tree=await installedTree();
 try{
  const baseChunk={id:'base',name:'Easter Co. client for Minecraft 26.2',optional:false,immutable:true,version:'sha256:'+sha256(base),files:[entry(server.origin+'/files/base.jar','mods/easter-navy.jar',base)]};
  const graphicsChunk={id:'graphics',name:'Enhanced graphics',optional:true,immutable:false,version:'sha256:'+sha256(graphics),files:[entry(server.origin+'/files/graphics.zip','shaderpacks/graphics.zip',graphics)]};
  const published=chunkFixture({base:baseChunk,graphics:graphicsChunk});
  const result=await installClient({root:tree.root,published,origin:server.origin,includeGraphics:true,hardware:{vramMB:8188,tier:'capable'}});
  const options=shown(await fs.readFile(optionsFile(tree.root),'utf8'));
  for(const line of ['guiScale:2','fullscreen:true','graphicsMode:fancy','renderDistance:16',...bindLines(immediateBinds())])assert(options.includes(line),line+' is in options.txt: '+JSON.stringify(options));
  assertDistinctBindings(await fs.readFile(optionsFile(tree.root),'utf8'),'the seed beside the graphics step');
  assert.equal(await fs.stat(displayRecordFile(tree.root)).then(()=>'present',()=>'absent'),'present');
  assert.deepEqual({...result.quality},{renderDistance:16,shadowDistance:12,shaders:true},'the quality report is unchanged by the display seed');
  assert.match(await fs.readFile(path.join(tree.root,'config','iris.properties'),'utf8'),/^enableShaders:true$/m);
 }finally{await server.close();await tree.cleanup();}
});
