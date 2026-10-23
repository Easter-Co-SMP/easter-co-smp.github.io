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
//      and reads exactly one of the four sentences desktop/game.cjs owns, with the tone
//      and the LED that sentence is drawn with, and the enhanced graphics row is offered
//      while nobody is signed in.
//
// The four sentences are the product's own, and this file carries no fifth rule: the list
// lives in desktop/game.cjs (the `MESSAGES` table and `gameStatusLine`), doc/launcher-states.md
// tabulates it, and doc/releasing.md step 1a names it so that a copy change moves this file
// in the same commit. It was *three* sentences until 1.0.44, when `Status pending…` arrived
// with its rotating ring, and this gate silently kept the older rule (2026-10-23) because
// nothing named the list here. So the row is now checked as words *and* as painting:
// `data-tone` must be a tone `gameStatusLine` can publish for that very sentence,
// `Status pending…` must be the unfilled ring with one transparent quadrant and
// `game-led-spin` actually running, and every other sentence the filled, still dot. A
// sentence paired with the wrong LED fails, which the words alone never caught.
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
const seen=message=>console.log('  seen '+message);

// The four sentences desktop/game.cjs can print, and - for each - the tones
// `gameStatusLine` may publish beside it. Nothing here is a shape the product cannot
// produce, so this is stricter than a wildcard rather than looser: `Server Online` is the
// sentence for a service that sent no count (tone `online` only), the counted sentence
// belongs to every known state, and the other two each have exactly one tone.
const SENTENCES={
 'Server Online, N active players':['online','asleep','starting','stopping'],
 'Server Online':['online'],
 'Status pending…':['pending'],
 'Server Offline':['offline']
};
// The one sentence, matched exactly. The count is a real canonical integer and one player
// is singular, exactly as `playerCount` writes it: no leading zero, no `1 active players`,
// no extra word, and no bracket or reason smuggled in beside it.
function sentenceOf(line){
 const text=String(line||'').trim();
 if(text==='Server Online'||text==='Server Offline'||text==='Status pending…')return text;
 const counted=/^Server Online, (\d+) active players?$/.exec(text);
 if(counted){
  const players=Number(counted[1]);
  if(String(players)===counted[1]&&text==='Server Online, '+players+' active player'+(players===1?'':'s'))return 'Server Online, N active players';
 }
 return null;
}
// What the row and its LED are actually painted with, read from the live page and returned
// raw: the log says what it saw, not only that a rule held.
async function ledFacts(page){
 return page.evaluate(()=>{
  const row=document.querySelector('.desktop-game-status');
  const led=row?.querySelector('.desktop-game-led');
  if(!row||!led)return null;
  const css=getComputedStyle(led);
  return {
   tone:row.dataset.tone??null,
   state:row.dataset.state??null,
   background:css.backgroundColor,
   animation:css.animationName,
   borderWidths:[css.borderTopWidth,css.borderRightWidth,css.borderBottomWidth,css.borderLeftWidth],
   borderColors:[css.borderTopColor,css.borderRightColor,css.borderBottomColor,css.borderLeftColor],
   reducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches
  };
 });
}
// A CSS colour that paints nothing: `transparent`, or a rgba() whose alpha is zero.
const transparent=value=>{const css=String(value).replace(/\s+/g,'').toLowerCase();return css==='transparent'||/^rgba\([^)]*,0(?:\.0+)?\)$/.test(css);};
// The unfilled ring: no filled background, a real border on all four sides with exactly one
// quadrant left transparent, so the turning box reads as a gap.
const ringDrawn=facts=>facts!==null&&transparent(facts.background)&&facts.borderWidths.every(width=>parseFloat(width)>0)&&facts.borderColors.filter(transparent).length===1;
// The filled dot: a painted background and no transparent quadrant anywhere.
const dotDrawn=facts=>facts!==null&&!transparent(facts.background)&&facts.borderColors.every(colour=>!transparent(colour));
const ledSummary=facts=>facts===null?'no LED is painted':'background '+facts.background+', border '+facts.borderWidths.join('/')+' '+JSON.stringify(facts.borderColors)+', animation '+JSON.stringify(facts.animation);

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
console.log('the server row may read: '+Object.keys(SENTENCES).map(sentence=>JSON.stringify(sentence)).join(' or ')+' (desktop/game.cjs)');

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
 const sentence=sentenceOf(row);
 ok(sentence!==null,'the row is one of the four sentences desktop/game.cjs owns: '+JSON.stringify(row));
 ok(row!==null&&!/\(|asleep|zzz|starting|stopping|unknown|presses play/i.test(row),'with no bracket, reason or service detail: '+JSON.stringify(row));
 // The painting, read from the page: the tone the row carries and the LED's computed
 // style. `data-tone` is what the stylesheet turns into an LED, so it is checked against
 // the sentence before the shape of the LED is judged at all.
 const led=await ledFacts(page);
 const tones=sentence?(SENTENCES[sentence]||[]):[];
 seen('the row says '+JSON.stringify(row)+' - '+JSON.stringify(sentence)+' - with data-tone '+JSON.stringify(led?.tone)+' and data-state '+JSON.stringify(led?.state));
 seen('the LED: '+ledSummary(led)+(led?.reducedMotion?' (prefers-reduced-motion: reduce)':''));
 ok(led!==null,'the row carries its LED');
 ok(led!==null&&tones.includes(led.tone),'data-tone '+JSON.stringify(led?.tone)+' is one of '+JSON.stringify(tones)+' beside '+JSON.stringify(sentence));
 const wantRing=sentence?sentence==='Status pending…':led?.tone==='pending';
 if(wantRing){
  // Pending is the one sentence that is not a claim about the server: nothing has been
  // asked yet, so the LED waits instead of reporting, and waiting is drawn, not written.
  ok(ringDrawn(led),'the pending sentence is drawn as the unfilled ring with a transparent quadrant: '+ledSummary(led));
  // Reduced motion stops the rotation in the stylesheet but keeps the ring; with motion
  // allowed the same ring has to be turning, so a still ring and a spinning dot both fail.
  const turning=led!==null&&(led.reducedMotion?led.animation==='none':led.animation==='game-led-spin');
  ok(turning,'the ring turns with game-led-spin: '+JSON.stringify(led?.animation)+(led?.reducedMotion?' (reduced motion is on, so it must be stopped)':''));
 }else{
  ok(dotDrawn(led),'the '+JSON.stringify(sentence)+' sentence is drawn as the filled dot: '+ledSummary(led));
  // A dot may carry the stylesheet's own pulse for a state that is still coming up, and
  // nothing else: the ring's rotation on a known sentence is the failure this forbids.
  const still=led!==null&&led.animation!=='game-led-spin'&&(led.animation==='none'||(led.tone==='starting'&&led.animation==='game-led-pulse'));
  ok(still,"the dot is still, never the ring's rotation: "+JSON.stringify(led?.animation)+' with tone '+JSON.stringify(led?.tone));
 }
 ok(await page.locator('.hero-graphics').isVisible().catch(()=>false),'the enhanced graphics row is offered with a client installed and nobody signed in');
});

console.log(failures===0?'PACKAGED FIRST SCREEN PASS: the built app paints its first screen and its Play Now stage':'PACKAGED FIRST SCREEN FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
