// The account lock, on both surfaces the launcher puts account changes on.
//
// doc/launcher-states.md (*Launcher UI review*) disables account changes while the launcher is
// authenticating or playing. Two holes were left in that rule: `starting-game`, the server wake,
// was missing from the list the profile menu was disabled from, and the profile dialog's own
// controls - Save name, Choose picture, Remove picture, Connect and Sign out of Minecraft
// everywhere - never consulted the lock at all. Neither was reachable, because the hero offers
// no Play during a wake and the dialog opens only from a menu entry the lock disables; a guard
// that holds only because nobody has moved a button is not a guard.
//
// This drives the real site/desktop.js and site/company-profile.mjs through a stub of the
// existing easterDesktop bridge, so it proves the behaviour rather than the source.
//
//   python3 -m http.server 18133 --directory site &
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18133 node tests/profile-lock-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18133';
const images=process.env.EASTER_PROFILE_LOCK_IMAGES||'/tmp/easter-profile-lock';
await fs.mkdir(images,{recursive:true});

// The locked set the contract names, and the states that must stay open. `ready` is the ordinary
// state a player changes their account in; `downloading` is busy but is not the account's rule.
const LOCKED=['signing-in','refreshing','launching','running','starting-game'];
const UNLOCKED=['ready','downloading','uninstalled','paused','verifying','installing','updating'];
const notes=[];
const note=text=>{notes.push(text);console.log('  ok  '+text);};

// The rule has one home. A phase name written anywhere else is the drift this ticket closes.
const renderer=await fs.readFile(new URL('../site/desktop.js',import.meta.url),'utf8');
const dialogSource=await fs.readFile(new URL('../site/company-profile.mjs',import.meta.url),'utf8');
const occurrences=text=>text.match(/'signing-in'/g)?.length||0;
assert.equal(occurrences(renderer),1,'the renderer names the locked set exactly once, at the lock itself');
assert.match(renderer,/const LOCKED_PHASES=\['signing-in','refreshing','launching','running','starting-game'\];/,'the locked set is one named list and it includes the server wake');
assert.equal(occurrences(dialogSource),0,'the profile dialog carries no phase list of its own');
// A copied list would be quoted phase names, so those are what must not appear. The words may
// still appear in prose, which decides nothing.
for(const phase of LOCKED)assert(!dialogSource.includes(`'${phase}'`),'the dialog does not spell out the phase '+phase);
assert.match(dialogSource,/isAccountLocked/,'the dialog asks the launcher for the lock instead');
note('the locked set is one list in site/desktop.js and site/company-profile.mjs carries a copy of none of it');

const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const errors=[];
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  const state={version:'1.0.33',totalMemoryMB:16384,phase:'ready',startupReady:true,companyReady:true,microsoftConnected:true,canPlay:true,
   account:null,profile:null,device:null,activity:null,settings:{memoryMB:4096,javaPath:''},
   install:{installed:true,location:'/fixture/client',defaultLocation:'/fixture/client',version:'26.2'},actions:['play'],
   graphics:{enabled:false,recommended:true,tunable:true},game:{state:'running',ready:true},
   minecraftSession:{state:'server',serverHeld:true,checkedAt:'2026-10-19T00:00:00Z'},progress:null,bar:{visible:false}};
  window.__fixture={calls:[]};
  let notify=()=>{};
  window.pushState=patch=>{
   for(const [key,value] of Object.entries(patch))state[key]=value===null||typeof value!=='object'?value:structuredClone(value);
   notify({...state});
  };
  const record=(name,payload)=>window.__fixture.calls.push({name,payload});
  window.easterDesktop={
   mode:'desktop',status:async()=>({...state}),onState:callback=>{notify=callback;},
   signIn:async options=>{record('signIn',options);return {};},
   cancelSignIn:async()=>{record('cancelSignIn');},
   openMicrosoft:async()=>{record('openMicrosoft');},
   accountProviders:async()=>({providers:['microsoft','google']}),
   signInProvider:async(provider,link)=>{record('signInProvider',{provider,link});return {};},
   updateProfile:async name=>{record('updateProfile',name);return {ok:true};},
   setProfilePicture:async remove=>{record('setProfilePicture',remove);return {ok:true};},
   signOut:async()=>{record('signOut');},
   signOutMinecraft:async()=>{record('signOutMinecraft');return {revoked:true,message:'Signed Minecraft out everywhere.'};},
   profileEmails:async()=>({emails:[],loginEmail:null}),
   saveSettings:async values=>values,
   play:async()=>{record('play');}
  };
 });
 await page.goto(origin);
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>typeof window.pushState==='function');
 const pushState=patch=>page.evaluate(values=>window.pushState(values),patch);
 const recorded=()=>page.evaluate(()=>window.__fixture.calls.map(call=>call.name));

 // --- The profile menu, across the whole locked set --------------------------
 const ACCOUNT={id:'EC-31',username:'owen_captain',name:'Captain Owen',roles:['crew'],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],picture:null};
 await pushState({account:ACCOUNT,profile:null,phase:'ready',canPlay:true,actions:['play']});
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Captain Owen');
 await page.locator('.desktop-account-nav').click();
 const menu=page.locator('.desktop-profile-menu');
 await menu.waitFor({state:'visible'});
 const menuEntries=()=>page.evaluate(()=>[...document.querySelectorAll('.desktop-profile-menu [data-profile-action]')].map(button=>({action:button.dataset.profileAction,disabled:button.disabled,hidden:button.hidden})));
 const idleMenu=await menuEntries();
 assert.equal(idleMenu.length,4,'the account menu is the four account actions');
 assert(idleMenu.every(entry=>!entry.hidden),'every account action is offered while the launcher is idle');
 assert(idleMenu.every(entry=>entry.disabled===false),'an idle launcher leaves the account controls usable: '+JSON.stringify(idleMenu));
 for(const phase of LOCKED){
  await pushState({phase});
  await page.waitForFunction(()=>[...document.querySelectorAll('.desktop-profile-menu [data-profile-action]')].every(button=>button.disabled));
  const entries=await menuEntries();
  assert(entries.every(entry=>entry.disabled===true),'phase '+phase+' disables every account action: '+JSON.stringify(entries));
  assert.equal(entries.length,4,'and the whole account menu is still the four actions at '+phase);
 }
 note('signing-in, refreshing, launching, running and starting-game each disable the whole profile menu; the server wake is locked like every other launch state');
 for(const phase of UNLOCKED){
  await pushState({phase});
  await page.waitForFunction(()=>[...document.querySelectorAll('.desktop-profile-menu [data-profile-action]')].every(button=>button.disabled===false));
 }
 note('the states that are neither authentication nor gameplay leave the account controls usable');

 // --- The profile dialog's own controls --------------------------------------
 // While the launcher is idle the dialog works exactly as it did.
 await pushState({phase:'ready'});
 await page.waitForFunction(()=>document.querySelector('.desktop-profile-menu [data-profile-action]').disabled===false);
 await menu.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 const dialog=page.locator('#company-profile');
 await dialog.waitFor({state:'visible'});
 const CONTROL_NAMES=['Save name','Choose picture','Remove picture','Connect Google','Sign out of Minecraft everywhere'];
 const controlStates=()=>page.evaluate(names=>{
  const found={};
  for(const name of names){
   // A provider's Connect control is labelled by name rather than by its text, which is the
   // verb alone, so both are read.
   const button=[...document.querySelectorAll('#company-profile button')].find(node=>(node.getAttribute('aria-label')||node.textContent.trim())===name);
   found[name]=button?button.disabled:'missing';
  }
  return found;
 },CONTROL_NAMES);
 const closedStates=names=>Object.fromEntries(names.map(name=>[name,false]));
 const openStates=names=>Object.fromEntries(names.map(name=>[name,true]));
 const idleControls=await controlStates();
 assert.deepEqual(idleControls,closedStates(CONTROL_NAMES),'every account control in the dialog is usable while the launcher is idle: '+JSON.stringify(idleControls));
 assert.equal(await dialog.locator('.dialog-close').isDisabled(),false,'the close control is available while idle');
 note('an idle launcher leaves every control in the profile dialog usable');

 // The game running is the state the ticket names: the dialog is open, the lock goes on, and
 // the controls answer to the lock rather than to the disabled opener that let them open.
 await pushState({phase:'running'});
 await page.waitForFunction(()=>document.querySelector('#company-profile button[type=submit]').disabled===true);
 const runningControls=await controlStates();
 assert.deepEqual(runningControls,openStates(CONTROL_NAMES),'the running game disables Save name, both picture controls, Connect and Sign out of Minecraft everywhere: '+JSON.stringify(runningControls));
 assert.equal(await dialog.locator('.dialog-close').isDisabled(),false,'closing the dialog is not an account change and stays available');
 await page.screenshot({path:`${images}/profile-locked-running-1440.png`,animations:'disabled'});
 note('a running game disables every account control in the profile dialog, with the dialog already open');

 // Painted disabled is not the whole rule: an action that starts anyway is refused too.
 const beforeForced=await recorded();
 await dialog.locator('form').evaluate(form=>form.requestSubmit());
 for(const selector of ['[data-revoke-minecraft]','[data-picture=upload]','[data-picture=remove]']){
  await page.locator('#company-profile '+selector).evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
 }
 assert.deepEqual(await recorded(),beforeForced,'a save, a picture change and a sign-out everywhere forced past the disabled state reach main not once');
 assert.equal((await page.locator('#company-profile .company-status').innerText()).trim(),'','and nothing claims to have been saved');
 assert.equal((await page.locator('#company-profile .company-error').innerText()).trim(),'','and no failure is invented either');
 note('a forced save, picture change or sign-out is refused while the lock is on, and claims nothing');

 // The wake locks the same controls, which is the two holes closed together: a launch state the
 // hero does not offer Play on is still a state no account change happens in.
 await pushState({phase:'starting-game'});
 await page.waitForFunction(()=>document.querySelector('#company-profile button[type=submit]').disabled===true);
 assert.deepEqual(await controlStates(),openStates(CONTROL_NAMES),'a server wake disables the dialog\'s own controls too');
 note('a server wake locks the dialog\'s own controls as well');

 // And the lock comes off again on the broadcast that ends it.
 await pushState({phase:'ready'});
 await page.waitForFunction(()=>document.querySelector('#company-profile button[type=submit]').disabled===false);
 assert.deepEqual(await controlStates(),closedStates(CONTROL_NAMES),'the controls come back when the launcher is idle again');
 await dialog.getByRole('button',{name:'Save name',exact:true}).click();
 await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.name==='updateProfile'));
 const saved=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='updateProfile').at(-1));
 assert.deepEqual(saved,{name:'updateProfile',payload:'Captain Owen'},'an unlocked Save name still reaches main: '+JSON.stringify(saved));
 note('the lock is released on the broadcast that ends it, and the dialog works again');

 await dialog.locator('.dialog-close').click();
 await dialog.waitFor({state:'detached'});
 assert.deepEqual(errors,[],'the account lock raises no page error');
 console.log(`PROFILE LOCK PASS: ${notes.length} checks — the account lock is one named list in site/desktop.js that includes starting-game, the server wake, and the profile dialog asks the launcher for it instead of carrying a copy: the profile menu and the dialog's own controls are both disabled during signing-in, refreshing, launching, starting-game and running, a forced save, picture change or sign-out is refused while locked, and both surfaces come back when the launcher is idle. Screenshots: ${images}`);
}finally{
 await browser.close();
}
