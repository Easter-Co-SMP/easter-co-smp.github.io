const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {downloadVerified,launchOptions,generateArguments}=require('../../desktop/install.cjs');
const {localFile,cleanSettings,publicProfile,externalURL,trustedFrame}=require('../../desktop/security.cjs');
test('download checksum mismatch preserves last good file; retries atomically replace it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easter-download-test-'));const file=path.join(dir,'client.jar'),original=global.fetch;
 await fs.writeFile(file,'previous');const data=Buffer.from('verified'),hash=crypto.createHash('sha256').update(data).digest('hex');
 try{
  global.fetch=async()=>new Response('corrupt');
  await assert.rejects(downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),/checksum/);assert.equal(await fs.readFile(file,'utf8'),'previous');assert.deepEqual(await fs.readdir(dir),['client.jar']);
  global.fetch=async()=>new Response(data);
  assert.equal(await downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),true);
  assert.equal(await fs.readFile(file,'utf8'),'verified');
  global.fetch=()=>{throw Error('should use verified cache');};
  assert.equal(await downloadVerified('https://cdn.modrinth.com/test.jar',file,hash),false);
 }finally{global.fetch=original;await fs.rm(dir,{recursive:true,force:true});}
});
test('only safe app paths and HTTPS external links are accepted',()=>{
 assert.equal(localFile('easter://easter/map/map.js','/app/site'),'/app/site/map/map.js');
 assert.throws(()=>localFile('https://easter/map','/app/site'));assert.throws(()=>localFile('easter://easter/%2f..%2fprivate','/app/site'));assert.throws(()=>localFile('easter://easter/map%5c..%5cprivate','/app/site'));
 assert.equal(externalURL('https://modrinth.com/'),'https://modrinth.com/');
 for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:password@example.com/'])assert.throws(()=>externalURL(url));
 const main={url:'easter://easter/'};assert(trustedFrame({senderFrame:main,sender:{mainFrame:main}}));assert(!trustedFrame({senderFrame:{url:'easter://easter/'},sender:{mainFrame:main}}));
});
test('settings reject command strings; public account view omits all tokens',()=>{
 assert.deepEqual(cleanSettings({memoryMB:4096,server:'play.example.com:25565',javaPath:''}),{memoryMB:4096,server:'play.example.com:25565',javaPath:'',autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true});
 // A player's automation choices survive validation, and a stray value cannot turn one off.
 assert.deepEqual(
  (({autoUpdateLauncher,autoUpdateGame,exitOnLaunch})=>({autoUpdateLauncher,autoUpdateGame,exitOnLaunch}))(
   cleanSettings({memoryMB:4096,server:'',autoUpdateLauncher:false,autoUpdateGame:false,exitOnLaunch:false})),
  {autoUpdateLauncher:false,autoUpdateGame:false,exitOnLaunch:false});
 assert.deepEqual(
  (({autoUpdateLauncher,autoUpdateGame,exitOnLaunch})=>({autoUpdateLauncher,autoUpdateGame,exitOnLaunch}))(
   cleanSettings({memoryMB:4096,server:'',autoUpdateLauncher:'yes',autoUpdateGame:0,exitOnLaunch:null})),
  {autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true});
 for(const server of ['host;rm -rf /','$(command)','server:65536','--argument'])assert.throws(()=>cleanSettings({memoryMB:4096,server}));
 assert.throws(()=>cleanSettings({memoryMB:90000,server:''}));assert.throws(()=>cleanSettings({memoryMB:4096,server:'',javaPath:'/bin/bash'}));
 const profile=publicProfile({profile:{id:'test',name:'Captain',accessToken:'private'},accessToken:'secret'});assert.deepEqual(profile,{id:'test',name:'Captain',skin:null});
});
test('launch arguments carry the authenticated identity and Quick Play without a shell',async()=>{
 const session={profile:{id:'1234567890abcdef1234567890abcdef',name:'Captain'},accessToken:'test-secret',clientId:'easter-app',xuid:'1234'};
 const version={id:'fabric-test',minecraftVersion:'26.2',type:'release',assets:'26',mainClass:'net.fabricmc.loader.impl.launch.knot.KnotClient',libraries:[],arguments:{jvm:['-cp','${classpath}'],game:['--username','${auth_player_name}','--accessToken','${auth_access_token}','--clientId','${clientid}','--xuid','${auth_xuid}']}};
 const options=launchOptions({root:'/tmp/easter-game',version,javaPath:'/java/bin/java',session,settings:{memoryMB:4096,server:'server.example:25565'}});
 const args=await generateArguments(options);
 assert.equal(options.extraExecOption.shell,false);assert(args.includes('test-secret'));assert(args.includes('Captain'));assert(args.includes('easter-app'));assert(args.includes('1234'));assert(args.includes('--quickPlayMultiplayer'));assert(args.includes('server.example:25565'));assert(!args.some(arg=>arg.includes('${')));
});
