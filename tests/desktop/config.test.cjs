const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {apiOrigin,DEFAULT_API_ORIGIN,serverList,DEFAULT_SERVER,LOCAL_SERVER}=require('../../desktop/config.cjs');
const {cleanSettings,includeGraphicsValue,checkServer}=require('../../desktop/security.cjs');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('the API base URL is a build-time constant with an environment override',async()=>{
 assert.match(DEFAULT_API_ORIGIN,/^https:\/\//);
 assert.equal(apiOrigin(undefined),DEFAULT_API_ORIGIN);
 assert.equal(apiOrigin(''),DEFAULT_API_ORIGIN);
 assert.equal(apiOrigin('   '),DEFAULT_API_ORIGIN);
 assert.equal(apiOrigin('https://api.example.test'),'https://api.example.test');
 assert.equal(apiOrigin('https://api.example.test/'),'https://api.example.test');
 assert.equal(apiOrigin('https://api.example.test///'),'https://api.example.test');
 assert.equal(apiOrigin('https://api.example.test:8443/base/'),'https://api.example.test:8443/base');
});

test('a non-HTTPS or unusable override is refused, never silently used',async()=>{
 for(const value of ['http://api.example.test','api.example.test','file:///tmp/api','ftp://api.example.test','not a url'])assert.throws(()=>apiOrigin(value),/EASTER_API_BASE_URL/);
});

test('the renderer keeps connect-src self and no renderer network access',async()=>{
 const main=read('desktop/main.cjs');
 const csp=/const CSP="([^"]+)"/.exec(main);
 assert(csp,'main.cjs must define the CSP');
 assert.match(csp[1],/connect-src 'self'/);
 assert.match(csp[1],/default-src 'self'/);
 assert.match(csp[1],/object-src 'none'/);
 assert.match(csp[1],/frame-src 'none'/);
 // The account API origin must not be reachable from the renderer policy.
 assert.equal(csp[1].includes('https://'),false);
 assert.equal(csp[1].includes('accounts.'),false);
 for(const file of ['site/desktop.js','desktop/preload.cjs']){
  const source=read(file);
  assert.equal(/\bfetch\s*\(/.test(source),false,file+' must not call fetch');
  assert.equal(/XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(source),false,file+' must not open a network channel');
 }
 // Only the main process may construct an account client, and only for HTTPS.
 const clientUses=fs.readdirSync(path.join(root,'desktop')).filter(name=>name.endsWith('.cjs')).filter(name=>read('desktop/'+name).includes('AccountClient'));
 assert.deepEqual(clientUses.sort(),['accounts.cjs','main.cjs']);
 assert.match(read('desktop/main.cjs'),/new AccountClient\(\{baseUrl:apiOrigin\(\)/);
});

test('no token or response body can be logged from the account path',async()=>{
 const source=['desktop/main.cjs','desktop/accounts.cjs','desktop/vault.cjs','desktop/preload.cjs'].map(read).join('\n');
 assert.equal(/console\.(log|info|warn|error|debug)/.test(source),false,'the launcher must not log account material');
 assert.equal(/process\.stdout\.write|process\.stderr\.write/.test(source),false);
 // safeError must stay ahead of the generic message path for account failures.
 const main=read('desktop/main.cjs');
 assert.match(main,/if\(error\.name==='AccountError'\)return error\.message/);
 assert.match(main,/function safeError/);
 assert.equal(main.indexOf("error.name==='AccountError'")>main.indexOf('function safeError'),true);
});

test('the server list is published in display order, with the pending entry marked',()=>{
 const servers=serverList();
 assert.deepEqual(servers.map(entry=>entry.address),['100.100.1.0:25565','127.0.0.1:25565','smp.easter.company:25565']);
 assert.deepEqual(servers.map(entry=>entry.pending),[false,false,true],'only the name without a DNS record is pending');
 assert.equal(servers[0].address,DEFAULT_SERVER);
 assert.equal(servers[1].address,LOCAL_SERVER);
 for(const entry of servers){
  for(const field of ['id','label','address','note','pending'])assert.equal(field in entry,true,'servers[] entries carry '+field);
  assert.equal(typeof entry.id,'string');
  assert.equal(typeof entry.label,'string');
  assert.equal(typeof entry.address,'string');
  assert.equal(typeof entry.note,'string','a pending entry says why rather than failing silently');
  assert.equal(typeof entry.pending,'boolean');
  assert.equal(checkServer(entry.address),entry.address,entry.address+' is a valid server setting');
 }
 // The list is a copy: no caller can rewrite the published entries.
 const copy=serverList();
 copy[0].address='elsewhere:25565';
 assert.equal(serverList()[0].address,DEFAULT_SERVER);
});

test('settings.server stays one plain string and a typed value is never rewritten',()=>{
 // Whatever a player types round-trips unchanged: the launcher never substitutes an
 // entry id or an address from its own list.
 for(const typed of ['100.100.1.0:25565','127.0.0.1:25565','smp.easter.company:25565','my.friend.example:25566','play.example.org','10.0.0.7:25565']){
  assert.equal(cleanSettings({memoryMB:4096,server:typed}).server,typed);
 }
 assert.equal(cleanSettings({memoryMB:4096,server:'  100.100.1.0:25565  '}).server,'100.100.1.0:25565','only surrounding whitespace is trimmed');
 assert.equal(cleanSettings({memoryMB:4096,server:''}).server,'');
 for(const wrong of ['http://example.com','not a server','example.com:0','example.com:70000','example.com:port','../etc/passwd','-bad.example'])
  assert.throws(()=>cleanSettings({memoryMB:4096,server:wrong}),/server|port/i,wrong+' must be refused');
 // The enhanced graphics toggle is a boolean or it is absent; nothing coerces a
 // stray value into re-deciding a player's own choice.
 assert.equal(includeGraphicsValue({includeGraphics:true},false),true);
 assert.equal(includeGraphicsValue({includeGraphics:false},true),false);
 assert.equal(includeGraphicsValue({},true),true);
 assert.equal(includeGraphicsValue({includeGraphics:'yes'},false),false);
 assert.equal(includeGraphicsValue(null,true),true);
});

test('the account path writes nothing outside the app data directory',async()=>{ // The launcher runs with the user's privileges, so a fixed path outside app data
 // is both a stray artefact and a symlink hazard. Vault writes go to
 // app.getPath('userData') through the paths main.cjs builds from configRoot().
 const source=['desktop/main.cjs','desktop/accounts.cjs','desktop/vault.cjs','desktop/config.cjs','desktop/security.cjs','desktop/preload.cjs'].map(read).join('\n');
 assert.equal(/['"`]\/tmp/.test(source),false,'no fixed /tmp path in the account path');
 assert.equal(/tmpdir\(/.test(source),false,'the account path must not use a temporary directory');
 assert.equal(/appendFileSync|writeFileSync|writeSync|createWriteStream/.test(source),false,'no synchronous or stream writes in the account path');
 const vault=read('desktop/vault.cjs');
 assert.match(vault,/require\('node:fs\/promises'\)/);
 assert.equal(/require\('node:fs'\)/.test(vault),false,'vault writes must be async');
 assert.match(read('desktop/main.cjs'),/const configRoot=\(\)=>app\.getPath\('userData'\)/);
 assert.match(read('desktop/main.cjs'),/const companyFile=\(\)=>path\.join\(configRoot\(\),companyVaultName\(\)\)/);
});
