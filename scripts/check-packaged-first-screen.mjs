// The one check no unit, browser or Electron suite performs: does the *packaged* build
// paint its first screen? doc/releasing.md 1a exists because 1.0.36 passed every suite
// and greeted a first launch with "Dispatches unavailable"; the unpackaged app was fine
// and only the package was wrong.
//
//   node scripts/check-packaged-first-screen.mjs [--app <executable>]
//
// With no --app it uses release/linux-unpacked/easter-company, which `npm run pack`
// writes. Two launches, both with an isolated HOME:
//
//   1. an empty HOME - the first launch a new player gets: the header, the hero asking
//      for the download, and the home cards loaded, with no "unavailable" sentence;
//   2. a seeded app-owned client tree - the Play Now stage: the server row is on screen
//      and reads one of the three sentences, and the enhanced graphics row is offered
//      while nobody is signed in.
//
// It prints one line per check and exits non-zero on any failure. It reads the page, not
// a screenshot, so it works on a machine with no image tooling.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const repo=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const playwright=process.env.PLAYWRIGHT_MODULE||'/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const {_electron:electron}=await import(playwright);

const args=process.argv.slice(2);
const appIndex=args.indexOf('--app');
const app=appIndex>=0?args[appIndex+1]:path.join(repo,'release','linux-unpacked','easter-company');
let failures=0;
const ok=(condition,message)=>{console.log((condition?'  ok   ':'  FAIL ')+message);if(!condition)failures++;};

async function launch(tag,prepare,inspect){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'easter-first-screen-'));
 try{
  await prepare(home);
  const instance=await electron.launch({executablePath:app,args:['--no-sandbox'],env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config')}});
  try{
   const page=await instance.firstWindow();
   page.setDefaultTimeout(30000);
   await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
   // The launcher checks for its own update on start; the hero is busy until that settles.
   await page.waitForFunction(()=>{const s=window.easterDesktop.status?.();return s&&s.launcherUpdate&&s.launcherUpdate.phase!=='checking';},{timeout:25000}).catch(()=>{});
   await page.waitForTimeout(1500);
   const status=await page.evaluate(()=>window.easterDesktop.status());
   const body=await page.locator('body').innerText();
   await page.screenshot({path:path.join(os.tmpdir(),'easter-first-screen-'+tag+'.png'),fullPage:true});
   return await inspect(page,status,body);
  }finally{
   await instance.close();
  }
 }finally{
  // The caller may want the tree kept for a closer look: EASTER_KEEP_FIRST_SCREEN=1.
  if(process.env.EASTER_KEEP_FIRST_SCREEN!=='1')await fs.rm(home,{recursive:true,force:true});
 }
}

const unavailable=body=>body.split('\n').filter(line=>/unavailable/i.test(line));

console.log('first screen, empty HOME (a new player)');
await launch('empty',async()=>{},async(page,status,body)=>{
 ok(status.install.installed===false,'no client is installed on a new machine');
 ok(unavailable(body).length===0,'no "unavailable" sentence anywhere: '+JSON.stringify(unavailable(body)));
 ok(await page.locator('[data-desktop-play]').isVisible().catch(()=>false),'the hero action is painted');
 ok(await page.locator('#desktop-install-details').isVisible().catch(()=>false),'the download details are painted');
 ok(/Download the game/i.test(await page.locator('[data-desktop-play]').innerText().catch(()=>'')),'the hero asks for the download');
 ok(await page.locator('.desktop-game-status').isHidden().catch(()=>false),'the server row is absent before the Play Now stage');
});

console.log('Play Now stage, seeded client tree, nobody signed in');
await launch('seeded',async home=>{
 const client=path.join(home,'minecraft'),version='fixture-fabric';
 await fs.mkdir(path.join(client,'versions',version),{recursive:true});
 await fs.writeFile(path.join(client,'.easter-client'),'');
 await fs.writeFile(path.join(client,'versions',version,version+'.json'),'{}');
 await fs.writeFile(path.join(client,'installed.json'),JSON.stringify({version,minecraft:'26.2',fabric:'0.19.5',java:path.join(client,'java'),game:{minecraft:'26.2',fabric:'0.19.5',verified:true},chunks:{},files:[]}));
 await fs.writeFile(path.join(client,'java'),'');
 await fs.mkdir(path.join(home,'.config','Easter Company'),{recursive:true});
 await fs.writeFile(path.join(home,'.config','Easter Company','settings.json'),JSON.stringify({memoryMB:4096,javaPath:'',location:client,includeGraphics:false,graphicsChosen:true,autoUpdateLauncher:true,autoUpdateGame:true,exitOnLaunch:false,trayOnLaunch:false,desktopShortcut:false,startMenuShortcut:false}));
},async(page,status,body)=>{
 ok(status.install.installed===true,'the seeded client tree is recognised');
 ok(unavailable(body).length===0,'no "unavailable" sentence anywhere: '+JSON.stringify(unavailable(body)));
 const row=await page.locator('.desktop-game-status .desktop-game-line').innerText().catch(()=>null);
 ok(row!==null,'the server row is painted at the Play Now stage');
 ok(/^Server (Online, \d+ active players?|Online|Offline)$/.test((row||'').trim()),'the row is one of the three sentences: '+JSON.stringify(row));
 ok(!/\(|asleep|zzz|starting|stopping|unknown|presses play/i.test(row||''),'with no bracket, reason or service detail');
 ok(await page.locator('.hero-graphics').isVisible().catch(()=>false),'the enhanced graphics row is offered with a client installed and nobody signed in');
});

console.log(failures===0?'PACKAGED FIRST SCREEN PASS: the built app paints its first screen and its Play Now stage':'PACKAGED FIRST SCREEN FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
