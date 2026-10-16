const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {apiOrigin,DEFAULT_API_ORIGIN}=require('../../desktop/config.cjs');
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

test('the account path writes nothing outside the app data directory',async()=>{
 // The launcher runs with the user's privileges, so a fixed path outside app data
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
