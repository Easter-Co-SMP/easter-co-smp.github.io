const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const config=require('../../desktop/config.cjs');
const {BUNDLED_DEPLOYMENT,DEPLOYMENT_PATH,validateDeployment,configureDeployment,serverAddress}=config;
const {syncDeployment,loadDeployment,checkForUpdates,launchOptions,resetTransferStats,transferStats}=require('../../desktop/install.cjs');
const {sanitizeGameStatus,wakeServer}=require('../../desktop/game.cjs');
const {AccountClient}=require('../../desktop/accounts.cjs');
test.afterEach(()=>configureDeployment(BUNDLED_DEPLOYMENT));
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'easter-deployment-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('deployment metadata has one strict public shape and is bundled with the launcher',()=>{
 assert.deepEqual(BUNDLED_DEPLOYMENT,require('../../deployment.json'));
 assert(require('../../package.json').build.files.includes('deployment.json'));
 for(const bad of [null,[],{}, {schema:2,serverAddress:'play.example.test'}, {schema:1,serverAddress:''}, {schema:1,serverAddress:'https://play.example.test'}, {schema:1,serverAddress:'play.example.test:0'}, {schema:1,serverAddress:'play.example.test',token:'private'}])assert.throws(()=>validateDeployment(bad));
});
test('a quiet update refreshes deployment without fetching or hashing unchanged content',async t=>{
 const root=await fixture(t),old={schema:1,serverAddress:'old.example.test:25565'},next={schema:1,serverAddress:'new.example.test:25566'};
 await syncDeployment(root,{deployment:old});
 const record={version:'fabric-fixture',minecraft:'26.2',fabric:'0.19.5',modSha256:'a'.repeat(64),dependencies:[]};
 const text=JSON.stringify(record);await fs.writeFile(path.join(root,'installed.json'),text);
 const published={minecraft:'26.2',mod:{sha256:record.modSha256},dependencies:[],deployment:next};
 resetTransferStats();const reports=[];
 const result=await checkForUpdates({root,fetchManifest:async()=>published,notify:value=>reports.push(value),install:()=>assert.fail('unchanged chunks must not install')});
 assert.equal(result.changed,false);assert.equal(result.applied,false);assert.deepEqual(reports,[]);
 assert.deepEqual(transferStats(),{hashReads:0,bytesFetched:0});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,DEPLOYMENT_PATH),'utf8')),next);
 assert.equal(await fs.readFile(path.join(root,'installed.json'),'utf8'),text);
 assert.equal(serverAddress(),next.serverAddress);
 const options=launchOptions({root,session:{profile:{id:'fixture',name:'Fixture'},accessToken:'fixture'}});
 assert.deepEqual(options.extraMCArgs,['--quickPlayMultiplayer',next.serverAddress]);
 assert.equal(sanitizeGameStatus({state:'running',ready:true,endpoint:next.serverAddress}).ready,true);
 assert.equal(sanitizeGameStatus({state:'running',ready:true,endpoint:old.serverAddress}).ready,false);
});
test('invalid published deployment preserves the previous installed configuration',async t=>{
 const root=await fixture(t),old={schema:1,serverAddress:'current.example.test:25565'};await syncDeployment(root,{deployment:old});
 await assert.rejects(syncDeployment(root,{deployment:{schema:1,serverAddress:'http://invalid'}}));
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,DEPLOYMENT_PATH),'utf8')),old);
 assert.equal(serverAddress(),old.serverAddress);
});
test('startup tolerates a missing or damaged local deployment and a published check repairs it',async t=>{
 const root=await fixture(t);assert.deepEqual(await loadDeployment(root),BUNDLED_DEPLOYMENT);
 await fs.mkdir(path.dirname(path.join(root,DEPLOYMENT_PATH)),{recursive:true});await fs.writeFile(path.join(root,DEPLOYMENT_PATH),'{broken');
 assert.deepEqual(await loadDeployment(root),BUNDLED_DEPLOYMENT);
 const next={schema:1,serverAddress:'migrated.example.test'};await syncDeployment(root,{deployment:next});assert.deepEqual(await loadDeployment(root),next);
});
test('a backend endpoint mismatch refuses Play before waking rather than redirecting or bare-joining',async()=>{
 configureDeployment({schema:1,serverAddress:'current.example.test:25565'});
 const api=new AccountClient({request:async()=>({ok:true,status:200,json:async()=>({state:'running',ready:true,endpoint:'stale.example.test:25565'})})});
 await assert.rejects(api.gameStatus('fixture'),{code:'game_target_mismatch'});
 await assert.rejects(api.wakeGame('fixture'),{code:'game_target_mismatch'});
 let wakes=0;
 await assert.rejects(wakeServer({read:async()=>({ok:false,code:'game_target_mismatch'}),wake:async()=>{wakes++;}}),{code:'game_target_mismatch'});
 assert.equal(wakes,0);
});
