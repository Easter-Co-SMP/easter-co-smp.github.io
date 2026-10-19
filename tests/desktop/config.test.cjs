const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const config=require('../../desktop/config.cjs');
const {apiOrigin,DEFAULT_API_ORIGIN,PRODUCTION_SERVER,SERVER_ADDRESS_ENV,serverAddress}=config;
const {cleanSettings,cleanLaunchPreferences,migrateLaunchPreferences,includeGraphicsValue,checkServer}=require('../../desktop/security.cjs');
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

test('the launcher targets one fixed production server and publishes no choices at all',()=>{
 // Owen's instruction of 2026-10-18: the server address is not a setting any more, so the
 // launcher has exactly one target and it is in the code, not in a settings file.
 assert.equal(PRODUCTION_SERVER,'smp.easter.company:25565');
 // The hostname, never the Elastic IP behind it: the name survives an address change.
 assert.equal(/^\d+\.\d+\.\d+\.\d+/.test(PRODUCTION_SERVER),false,'the constant is a hostname, not an IP');
 // With nothing in the environment, that constant is the answer, and nothing else is.
 for(const value of [undefined,'','   ',null])assert.equal(serverAddress(value),PRODUCTION_SERVER,JSON.stringify(value));
 // The three legacy entries are gone from the bundled constants, not merely unrendered:
 // the tailnet address, the 127.0.0.1 'this machine' entry and the pending placeholder.
 for(const name of ['DEFAULT_SERVER','LOCAL_SERVER','SERVER_ENTRIES','serverList'])
  assert.equal(name in config,false,name+' must not exist any more');
 const source=read('desktop/config.cjs');
 // (127.0.0.1 stays in this module for its own reason: the loopback exception on the API
 // and client origins, which has nothing to do with a server choice.)
 for(const stale of ['100.100.1.0','Easter Co. SMP\'','This machine','no DNS record yet'])
  assert.equal(source.includes(stale),false,'config.cjs must not still carry '+JSON.stringify(stale));
});

test('the test-only address override is the same hostname/port rule as before',()=>{
 // EASTER_SERVER_ADDRESS exists because the suites need an address that is not
 // production. It is validated by the rule the settings field used, and a bad value is
 // refused rather than launched against.
 assert.equal(SERVER_ADDRESS_ENV,'EASTER_SERVER_ADDRESS');
 assert.equal(serverAddress('127.0.0.1:25566'),'127.0.0.1:25566');
 assert.equal(serverAddress('  local.test:25565  '),'local.test:25565');
 assert.equal(serverAddress('play.example.org'),'play.example.org');
 const previous=process.env.EASTER_SERVER_ADDRESS;
 try{
  process.env.EASTER_SERVER_ADDRESS='127.0.0.1:25599';
  assert.equal(serverAddress(),'127.0.0.1:25599','the environment is the only place it is read from');
  process.env.EASTER_SERVER_ADDRESS='';
  assert.equal(serverAddress(),PRODUCTION_SERVER,'an empty variable is no override');
 }finally{
  if(previous===undefined)delete process.env.EASTER_SERVER_ADDRESS;
  else process.env.EASTER_SERVER_ADDRESS=previous;
 }
 for(const wrong of ['http://example.com','not a server','example.com:0','example.com:70000','example.com:port','../etc/passwd','-bad.example','host;rm -rf /','--argument'])
  assert.throws(()=>serverAddress(wrong),/EASTER_SERVER_ADDRESS/,JSON.stringify(wrong)+' must be refused');
 // Nothing a player can reach names it: it is not in renderer state, not in the preload
 // and not in the settings dialog.
 for(const file of ['desktop/main.cjs','desktop/preload.cjs','site/desktop.js'])
  assert.equal(read(file).includes('EASTER_SERVER_ADDRESS'),false,file+' must not expose the override');
 // checkServer is still the one rule, exported once.
 assert.equal(checkServer('play.example.org:25565'),'play.example.org:25565');
 assert.throws(()=>checkServer('not a server'),/hostname/);
});

test('a settings file that still carries a server address is accepted, and the value is ignored',()=>{
 // Both household machines carry server:'100.100.1.0:25565' verbatim. Refusing that file
 // would send the player through setup again for a field they can no longer edit, so it
 // loads and the value simply is not part of the settings any more.
 assert.equal('server' in cleanSettings({memoryMB:4096,server:'100.100.1.0:25565'}),false,'the stored address is dropped');
 // Even a value the old rule refused is accepted now: nothing reads it, and a damaged
 // field must not be able to stop the launcher starting.
 for(const stored of ['100.100.1.0:25565','smp.easter.company:25565','','   ','not a server at all','http://example.com','../etc/passwd',null,42])
  assert.equal('server' in cleanSettings({memoryMB:4096,server:stored}),false,JSON.stringify(stored)+' is accepted and dropped');
 // The rest of the file is unaffected: the fields the player can still edit are cleaned
 // exactly as before, and the memory limit is still enforced.
 assert.equal(cleanSettings({memoryMB:4096,server:'100.100.1.0:25565'}).memoryMB,4096);
 assert.throws(()=>cleanSettings({memoryMB:90000,server:'100.100.1.0:25565'}));
});

test('an enhanced graphics answer is a boolean or it is absent',()=>{
 // The enhanced graphics toggle is a boolean or it is absent; nothing coerces a
 // stray value into re-deciding a player's own choice.
 assert.equal(includeGraphicsValue({includeGraphics:true},false),true);
 assert.equal(includeGraphicsValue({includeGraphics:false},true),false);
 assert.equal(includeGraphicsValue({},true),true);
 assert.equal(includeGraphicsValue({includeGraphics:'yes'},false),false);
 assert.equal(includeGraphicsValue(null,true),true);
});

test('the launch-time preferences default off and can never both be on',()=>{
 const pick=settings=>({exitOnLaunch:settings.exitOnLaunch,trayOnLaunch:settings.trayOnLaunch});
 // A fresh install: no settings file, so no fields, so the launcher stays exactly where
 // the player left it. Both of Owen's launch behaviours are off until he asks for one.
 assert.deepEqual(pick(cleanSettings({memoryMB:4096,server:''})),{exitOnLaunch:false,trayOnLaunch:false});
 // desktop/main.cjs's own defaults agree with the cleaner, so a fresh settings file and
 // a settings payload that omits the fields resolve to the same thing.
 const defaults=/const defaultSettings=\{([^}]*)\}/.exec(read('desktop/main.cjs'));
 assert(defaults,'main.cjs must define defaultSettings');
 assert.match(defaults[1],/(^|,)exitOnLaunch:false(,|$)/);
 assert.match(defaults[1],/(^|,)trayOnLaunch:false(,|$)/);
 // The pair is linked in the main process, not only in the view: either one on turns
 // the other off, in both directions.
 assert.deepEqual(pick(cleanSettings({memoryMB:4096,server:'',exitOnLaunch:true})),{exitOnLaunch:true,trayOnLaunch:false});
 assert.deepEqual(pick(cleanSettings({memoryMB:4096,server:'',trayOnLaunch:true})),{exitOnLaunch:false,trayOnLaunch:true});
 // A payload that claims both is resolved by the documented rule rather than refused:
 // both are resolved off. After the one-time migration a both-true file can only be
 // hand-edited or damaged, so neither do-anything-visible behaviour is inferred from it,
 // and quitting behind the game is never read out of an ambiguous pair.
 assert.deepEqual(pick(cleanSettings({memoryMB:4096,server:'',exitOnLaunch:true,trayOnLaunch:true})),{exitOnLaunch:false,trayOnLaunch:false});
 // Malformed values fall back to the documented default instead of throwing or being
 // coerced into a preference the player never chose.
 for(const wrong of ['yes','true',1,0,null,{},[]]){
  assert.deepEqual(pick(cleanSettings({memoryMB:4096,server:'',exitOnLaunch:wrong,trayOnLaunch:wrong})),{exitOnLaunch:false,trayOnLaunch:false},JSON.stringify(wrong)+' is not a saved preference');
 }
 // The rule is shared, so a caller can ask for the cleaned pair without a memory limit.
 assert.deepEqual(cleanLaunchPreferences({exitOnLaunch:true,trayOnLaunch:true}),{exitOnLaunch:false,trayOnLaunch:false});
 assert.deepEqual(cleanLaunchPreferences({}),{exitOnLaunch:false,trayOnLaunch:false});
});

// The update has to reach the machines the feature was asked for: both household settings
// files carry "exitOnLaunch": true verbatim from cleanSettings on the old default, with no
// trayOnLaunch at all. Those files are migrated once, on load.
test('a settings file written before the tray setting existed is migrated once, to both off',()=>{
 // The old default, exactly as the household files carry it: no trayOnLaunch field.
 const oldDefault={memoryMB:4096,javaPath:'',server:'100.100.1.0:25565',location:'',includeGraphics:true,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:true,graphicsChosen:true};
 assert.deepEqual(migrateLaunchPreferences(oldDefault),{migrated:true,exitOnLaunch:false,trayOnLaunch:false});
 // The written-back file is the proof that the migration already happened, so loading it
 // again migrates nothing and leaves the pair exactly as it was saved.
 assert.deepEqual(migrateLaunchPreferences({...oldDefault,exitOnLaunch:false,trayOnLaunch:false}),{migrated:false,exitOnLaunch:false,trayOnLaunch:false});
 // A player's own choice from this build sticks, in both directions, forever.
 assert.deepEqual(migrateLaunchPreferences({...oldDefault,exitOnLaunch:true,trayOnLaunch:false}),{migrated:false,exitOnLaunch:true,trayOnLaunch:false});
 assert.deepEqual(migrateLaunchPreferences({...oldDefault,exitOnLaunch:false,trayOnLaunch:true}),{migrated:false,exitOnLaunch:false,trayOnLaunch:true});
 assert.deepEqual(migrateLaunchPreferences({exitOnLaunch:false,trayOnLaunch:true}),{migrated:false,exitOnLaunch:false,trayOnLaunch:true});
 // Nothing read (a fresh install) and unreadable content are not migrations; the ordinary
 // load path owns them, and the first-run write puts the fields in place.
 assert.deepEqual(migrateLaunchPreferences(null),{migrated:false,exitOnLaunch:false,trayOnLaunch:false});
 assert.deepEqual(migrateLaunchPreferences(undefined),{migrated:false,exitOnLaunch:false,trayOnLaunch:false});
 // A file that is not a settings object at all is not this build's either, but the
 // ordinary load path already replaces it with defaults and the first-run write puts the
 // fields in place, so the migration leaves it to that path rather than writing twice.
 assert.deepEqual(migrateLaunchPreferences(7),{migrated:false,exitOnLaunch:false,trayOnLaunch:false});
 // A malformed field means the file predates the field, so it is migrated rather than trusted.
 assert.deepEqual(migrateLaunchPreferences({...oldDefault,trayOnLaunch:'true'}),{migrated:true,exitOnLaunch:false,trayOnLaunch:false});
 // And the main process is what calls it, on the saved file, writing the result back once.
 const main=read('desktop/main.cjs');
 assert.match(main,/const migration=migrateLaunchPreferences\(savedFile\?stored:null\)/);
 assert.match(main,/if\(migration\.migrated\)\{/);
 assert.match(main,/await atomicJSON\(settingsFile\(\),stored&&stored\.graphicsChosen===true\?\{\.\.\.settings,graphicsChosen:true\}:settings\);/, 'the migration write keeps a chosen graphics answer');
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
