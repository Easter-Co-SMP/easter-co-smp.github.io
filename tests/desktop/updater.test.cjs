const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {update,selected,validate,compare,relaunchOptions}=require('../../desktop/updater.cjs');
const bytes=Buffer.from('complete application payload'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
const manifest={schema:1,bootstrap:1,version:'1.0.12',platform:'linux',arch:'x64',runtime:'44.7.2',asset:'Easter-Company-Update-linux-x64.asar',size:bytes.length,sha256:sha};
const context={release:'1.0.12',platform:'linux',arch:'x64',runtime:'44.7.2'};
const fetchFor=(payload=bytes,meta=manifest)=>async url=>{
 if(url.endsWith('/latest'))return Response.json({tag_name:'launcher-v1.0.12'});
 if(url.endsWith('.json'))return Response.json(meta);
 return new Response(payload,{headers:{'content-length':String(payload.length)}});
};
async function fixture(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'updater-test-'));try{await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
test('strict version comparison never calls the same version newer',()=>{
 assert.equal(compare('1.0.10','1.0.10'),0);assert.equal(compare('1.0.10','1.0.9'),1);assert.equal(compare('1.0.9','1.0.10'),-1);
 for(const version of ['launcher-v1.0.10','1.0.10junk','1.0','999999999999999999999999.0.0'])assert.throws(()=>compare(version,'1.0.10'));
});
test('manifest pins device, runtime, protocol and exact asset; paths cannot escape',()=>{
 assert(validate(manifest,context).url.endsWith('/launcher-v1.0.12/'+manifest.asset));
 for(const patch of [{platform:'win32'},{arch:'arm64'},{runtime:'45.0.0'},{bootstrap:2},{asset:'../../other.asar'},{size:0},{size:201*1024*1024},{sha256:'wrong'},{version:'1.0.13'}])assert.throws(()=>validate({...manifest,...patch},context));
});
test('verified payload activates atomically and bootstrap selects it',()=>fixture(async root=>{
 const phases=[];
 const target=await update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:fetchFor(),notify:s=>phases.push(s.phase)});
 assert.deepEqual(await fs.readFile(target),bytes);assert.equal(JSON.parse(await fs.readFile(path.join(root,'current.json'))).version,'1.0.12');
 assert(phases.includes('downloading')&&phases.includes('verifying'));assert.equal(phases.at(-1),'restarting');
 assert.equal(selected(root,{bundled:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64'}),target);
 await fs.writeFile(target,'corrupt');
 assert.equal(selected(root,{bundled:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64'}),null);
}));
test('corrupt, truncated, oversized and interrupted downloads preserve previous selection',()=>fixture(async root=>{
 await fs.writeFile(path.join(root,'current.json'),'{"previous":true}');
 for(const payload of [Buffer.from('bad'),Buffer.alloc(bytes.length+1),Buffer.alloc(bytes.length)]){
  const fetch=async url=>url.endsWith('.asar')?new Response(payload):fetchFor()(url);
  await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch}));
  assert.equal(await fs.readFile(path.join(root,'current.json'),'utf8'),'{"previous":true}');
 }
 const stream=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,3));c.error(Error('connection lost'));}});
 const fetch=async url=>url.endsWith('.asar')?new Response(stream):fetchFor()(url);
 await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch}));
 assert.equal((await fs.readdir(root)).filter(file=>file.endsWith('.part')).length,0);
}));
test('failed identity inspection never activates otherwise valid bytes',()=>fixture(async root=>{
 await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:fetchFor(),inspect(){throw Error('wrong identity');}}));
 await assert.rejects(fs.stat(path.join(root,'current.json')));
}));
test('network and malformed feed errors propagate; no optional-update fallback',()=>fixture(async root=>{
 for(const fetch of [async()=>{throw Error('offline');},async()=>Response.json({tag_name:'bad'}),async()=>new Response('',{status:503})])
  await assert.rejects(update({current:'1.0.11',runtime:'44.7.2',root,fetch}));
}));
test('current release downloads nothing and AppImage relaunch preserves original executable',()=>fixture(async root=>{
 let calls=0;
 assert.equal(await update({current:'1.0.12',runtime:'44.7.2',platform:'linux',arch:'x64',root,fetch:async()=>{calls++;return Response.json(manifest);}}),null);assert.equal(calls,1);
 assert.deepEqual(relaunchOptions({platform:'linux',env:{APPIMAGE:'/apps/Launcher.AppImage'},execPath:'/tmp/mount/app'}),{execPath:'/apps/Launcher.AppImage',args:[]});
 assert.deepEqual(relaunchOptions({platform:'win32',env:{},execPath:'C:\\Launcher.exe'}),{execPath:'C:\\Launcher.exe',args:[]});
}));
