const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {configureVisuals,GRASS_CACHE,GRASS_ACTIVE,PACKS}=require('../../desktop/visuals.cjs');
const {installClient,applyGraphics,checkForUpdates,SHADERS_WITHHELD}=require('../../desktop/install.cjs');
const {MARKER}=require('../../desktop/config.cjs');
const VERSION='26.2-fabric0.19.5';
const SHADER_FILES=['mods/iris.jar','mods/sodium.jar','shaderpacks/ComplementaryUnbound_r5.9.3.zip'];
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'easter-visuals-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'config'),{recursive:true});await fs.mkdir(path.join(root,'mods'));
 await fs.writeFile(path.join(root,MARKER),'');
 await fs.writeFile(path.join(root,'options.txt'),'fov:0.5\nresourcePacks:["vanilla","file/personal.zip"]\n');
 const record={version:VERSION,minecraft:'26.2',fabric:'0.19.5',java:path.join(root,'java'),game:{minecraft:'26.2',fabric:'0.19.5',verified:true},chunks:{}};
 await fs.writeFile(record.java,'');
 await fs.mkdir(path.join(root,'versions',VERSION),{recursive:true});
 await fs.writeFile(path.join(root,'versions',VERSION,VERSION+'.json'),'{}');
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify(record));
 return {root,record};
}
async function seed(root,record){
 record.chunks.visuals={version:'visuals-1',files:PACKS};
 record.chunks.graphics={version:'graphics-1',files:[GRASS_CACHE,...SHADER_FILES]};
 for(const file of [...PACKS,GRASS_CACHE,...SHADER_FILES]){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'verified-payload');}
 await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders=true\nshaderPack=ComplementaryUnbound_r5.9.3.zip\nshadowDistance=8\n');
}
test('managed packs remain selected in dependency order and personal packs and options survive',async t=>{
 const {root,record}=await fixture(t);await seed(root,record);
 await configureVisuals(root,{record,includeGraphics:true});
 let text=await fs.readFile(path.join(root,'options.txt'),'utf8');
 assert.match(text,/fov:0.5/);
 const selected=JSON.parse(text.match(/^resourcePacks:(.*)$/m)[1]);
 assert.deepEqual(selected,['vanilla','file/personal.zip',...PACKS.map(p=>'file/'+path.basename(p))]);
 assert.ok(selected.indexOf('file/fa-player-extension.zip')>selected.indexOf('file/fresh-animations.zip'));
 assert.equal(await fs.readFile(path.join(root,GRASS_ACTIVE),'utf8'),'verified-payload');
 const before=await fs.stat(path.join(root,GRASS_ACTIVE));
 await configureVisuals(root,{record,includeGraphics:true});
 assert.equal((await fs.stat(path.join(root,GRASS_ACTIVE))).mtimeMs,before.mtimeMs,'quiet launch does not recopy cached foliage');
 await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders=false\n');
 assert.equal((await configureVisuals(root,{record,includeGraphics:true})).grass,false,'shaders must actually be enabled');
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(root,'options.txt'),'utf8'),text,'always-on packs survive');
});
test('switching off works offline, disables Iris and foliage, and keeps caches, distances and always-on packs',async t=>{
 const {root,record}=await fixture(t);await seed(root,record);
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify(record));
 await configureVisuals(root,{record,includeGraphics:true});
 const result=await applyGraphics({root,enabled:false,fetchManifest:()=>{throw Error('Must not contact network');}});
 assert.equal(result.includeGraphics,false);
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(root,GRASS_CACHE),'utf8'),'verified-payload');
 const iris=await fs.readFile(path.join(root,'config','iris.properties'),'utf8');
 assert.match(iris,/enableShaders=false/);assert.match(iris,/shadowDistance=8/);
 assert.match(await fs.readFile(path.join(root,'options.txt'),'utf8'),/dramatic-skys/);
});
test('real chunk installation activates foliage only for shader-capable hardware and updates its cached version',async t=>{
 const {root,record}=await fixture(t),requests=[];
 const payload=Buffer.from('foliage-release-one');
 const server=http.createServer((req,res)=>{requests.push(req.url);res.end(payload);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const file={id:'grassier-grass',name:'Grassier Grass',version:'1',path:GRASS_CACHE,url:origin+'/foliage',size:payload.length,hash:'sha256:'+crypto.createHash('sha256').update(payload).digest('hex')};
 const chunk={id:'graphics',name:'Graphics',version:'v1',optional:true,immutable:false,files:[file,...SHADER_FILES.map(p=>({...file,id:p,path:p}))]};
 const published={minecraft:'26.2',fabric:'0.19.5',dependencies:[],chunks:[chunk]};
 await installClient({root,published,origin,includeGraphics:true,hardware:{tier:'weak',vramMB:8192}});
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 assert.match(await fs.readFile(path.join(root,'config','iris.properties'),'utf8'),/enableShaders[:=]false/);
 await applyGraphics({root,published,origin,enabled:true,hardware:{tier:'capable',vramMB:8192}});
 assert.equal(await fs.readFile(path.join(root,GRASS_ACTIVE),'utf8'),payload.toString());
 assert.equal(requests.length,4,'enabling a cached chunk does not download it again');
 await applyGraphics({root,published,origin,enabled:true,hardware:{tier:'unknown',vramMB:null}});
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 await applyGraphics({root,published,origin,enabled:true,hardware:{tier:'capable',vramMB:8192}});
 payload.fill(65);chunk.version='v2';file.hash='sha256:'+crypto.createHash('sha256').update(payload).digest('hex');
 await checkForUpdates({root,origin,includeGraphics:true,hardware:{tier:'capable',vramMB:8192},fetchManifest:async()=>published});
 assert.equal(await fs.readFile(path.join(root,GRASS_ACTIVE),'utf8'),payload.toString(),'active foliage follows the verified new chunk');
 assert.equal(requests.length,5);
});
test('unowned trees and malformed pack selections are refused without discarding personal settings',async t=>{
 const {root,record}=await fixture(t);await seed(root,record);
 await fs.writeFile(path.join(root,'options.txt'),'resourcePacks:not-json\nfov:0.5\n');
 await assert.rejects(configureVisuals(root,{record,includeGraphics:false}),/selection is invalid/);
 assert.equal(await fs.readFile(path.join(root,'options.txt'),'utf8'),'resourcePacks:not-json\nfov:0.5\n');
 await fs.rm(path.join(root,MARKER));
 await assert.rejects(configureVisuals(root,{record,includeGraphics:true}));
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
});

test('missing or deselected shader payload cannot activate foliage and a scoped enable still configures cached graphics',async t=>{
 const {root,record}=await fixture(t);await seed(root,record);
 await configureVisuals(root,{record,includeGraphics:true});
 await fs.rm(path.join(root,SHADER_FILES[2]));
 assert.equal((await configureVisuals(root,{record,includeGraphics:true})).grass,false);
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 await fs.writeFile(path.join(root,SHADER_FILES[2]),'pack');
 await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders=true\nshaderPack=missing.zip\n');
 assert.equal((await configureVisuals(root,{record,includeGraphics:true})).grass,false);
 await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders=false\n');
 const file=p=>({id:p,name:p,version:'1',path:p,url:'https://cdn.modrinth.com/'+p,hash:'sha256:'+'a'.repeat(64),size:1});
 const graphics={id:'graphics',name:'Graphics',version:'graphics-1',optional:true,immutable:false,files:[GRASS_CACHE,...SHADER_FILES].map(file)};
 const visuals={id:'visuals',name:'Animations',version:'visuals-2',optional:false,immutable:true,files:PACKS.map(file)};
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify(record));
 const result=await applyGraphics({root,enabled:true,published:{minecraft:'26.2',fabric:'0.19.5',dependencies:[],chunks:[graphics,visuals]},hardware:{tier:'capable',vramMB:8192}});
 assert.equal(result.quality.shaders,true);
 assert.equal(await fs.readFile(path.join(root,GRASS_ACTIVE),'utf8'),'verified-payload');
 assert.deepEqual(result.skipped,['visuals'],'pending required content remains for the regular update');
});

test('what configureVisuals could not enable is what the launcher reports, and says so',async t=>{
 // The chunk names one pack and the pack and its loaders are on disk, but the cached
 // foliage module the effect is activated with is not part of it. configureVisuals
 // therefore withholds shaders, and that answer — not the request — is what the player
 // is told: the tuned report says off, the loader is not switched on, no pack name is
 // left behind, and the sentence is the honest one.
 const {root,record}=await fixture(t);
 record.chunks.graphics={version:'graphics-1',files:SHADER_FILES};
 for(const file of SHADER_FILES){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'verified-payload');}
 await fs.writeFile(path.join(root,'installed.json'),JSON.stringify(record));
 const file=p=>({id:p,name:p,version:'1',path:p,url:'https://cdn.modrinth.com/'+p,hash:'sha256:'+'a'.repeat(64),size:1});
 const graphics={id:'graphics',name:'Complementary Shaders - Unbound and Iris Shaders for Minecraft 26.2',version:'graphics-1',optional:true,immutable:false,files:SHADER_FILES.map(file)};
 const published={minecraft:'26.2',fabric:'0.19.5',dependencies:[],chunks:[graphics]};
 const result=await applyGraphics({root,enabled:true,published,hardware:{tier:'capable',vramMB:8192}});
 assert.equal(result.quality.shaders,false,'the tuned report is what configureVisuals could enable');
 assert.equal(result.graphicsMessage,SHADERS_WITHHELD,'and the sentence says the shaders were left off');
 assert.equal(result.message.includes(graphics.name+' installed.'),false,'nothing claims the effect was installed');
 await assert.rejects(fs.access(path.join(root,GRASS_ACTIVE)),{code:'ENOENT'});
 const iris=await fs.readFile(path.join(root,'config','iris.properties'),'utf8');
 assert.match(iris,/enableShaders[:=]false/,'the loader is not switched on');
 assert.equal(/shaderPack/.test(iris),false,'and no pack is named: '+JSON.stringify(iris.split('\n')));
});
test('a detected low-memory first install tunes vanilla graphics even with enhanced effects off',async t=>{
 const {root}=await fixture(t);
 const body=Buffer.from('required visual payload');
 const server=http.createServer((req,res)=>res.end(body));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 const entry={id:'camera',name:'Camera',version:'1',path:'mods/camera.jar',url:origin+'/camera',size:body.length,hash:'sha256:'+crypto.createHash('sha256').update(body).digest('hex')};
 const published={minecraft:'26.2',fabric:'0.19.5',dependencies:[],chunks:[{id:'visuals',name:'Camera',version:'v1',optional:false,immutable:true,files:[entry]}]};
 await installClient({root,published,origin,includeGraphics:false,hardware:{tier:'weak',vramMB:1024,tunable:true}});
 const options=await fs.readFile(path.join(root,'options.txt'),'utf8');
 assert.match(options,/^ao:false$/m);assert.match(options,/^mipmapLevels:2$/m);assert.match(options,/^renderDistance:6$/m);
 assert.match(options,/^fov:0.5$/m);
 assert.match(await fs.readFile(path.join(root,'config','iris.properties'),'utf8'),/enableShaders[:=]false/);
});

test('graphics disable refuses a foreign installed marker before touching any file',async t=>{
 const {root}=await fixture(t);
 await fs.writeFile(path.join(root,GRASS_ACTIVE),'foreign contents');
 await fs.writeFile(path.join(root,'config','iris.properties'),'enableShaders=true\n');
 await fs.rm(path.join(root,MARKER));
 await assert.rejects(applyGraphics({root,enabled:false}));
 assert.equal(await fs.readFile(path.join(root,GRASS_ACTIVE),'utf8'),'foreign contents');
 assert.equal(await fs.readFile(path.join(root,'config','iris.properties'),'utf8'),'enableShaders=true\n');
});
