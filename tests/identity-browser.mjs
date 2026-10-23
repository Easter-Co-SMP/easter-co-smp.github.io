// The player's own name and face, and a truthful linked-provider row.
//
// Owen's first real sign-up with Hannah's account showed her sign-in username where her
// name belongs, drew a teal letter tile instead of her Minecraft head, and offered a
// Verify button on an account that was already linked - a control that could only ever
// fail. This drives the real site/desktop.js and site/company-profile.mjs through a stub
// of the existing easterDesktop bridge, reads the canvas pixels back, and records the
// visual pass at 1440 and 390.
//
//   python3 -m http.server 18107 --directory site &
//   EASTER_PUBLIC_ORIGIN=http://127.0.0.1:18107 node tests/identity-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import {skinDataURL,pictureDataURL,faceColour,hatted,hatCovers,FACE_A,FACE_B} from './skin-fixture.mjs';

const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18107';
const images=process.env.EASTER_IDENTITY_IMAGES||'/tmp/easter-identity';
await fs.mkdir(images,{recursive:true});
const SKIN=skinDataURL(),PICTURE=pictureDataURL();

const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const errors=[];
const notes=[];
const note=text=>{notes.push(text);console.log('  ok  '+text);};
// Nothing the header or the hero draws may be fetched by the view: the head arrives as a data
// URL in state, exactly like the skin, so no request of any kind leaves the renderer for it.
const requests=[];
try{
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>requests.push(request.url()));
 await page.addInitScript(({skin,picture})=>{
  const state={version:'1.0.31',totalMemoryMB:16384,phase:'ready',startupReady:true,companyReady:true,microsoftConnected:true,canPlay:true,
   account:null,profile:null,device:null,activity:null,settings:{memoryMB:4096,javaPath:''},
   install:{installed:true,location:'/fixture/client',defaultLocation:'/fixture/client',version:'26.2'},actions:['play'],
   graphics:{enabled:false,recommended:true,tunable:true},game:{state:'running',ready:true},progress:null,bar:{visible:false}};
  window.__fixture={skin,picture,calls:[]};
  // The providers answer, and the one thing the Linked Accounts section waits for. Every case that
  // is not about the wait answers at once; the wait cases hold this promise open and release or
  // fail it by hand, so a busy state is proven by the answer not existing rather than by watching
  // a clock. `hold` gives each call its own pending promise, so a case can close the dialog
  // mid-wait and open it again.
  const providers={mode:'answer',answer:{providers:['microsoft','google']},pending:null};
  window.__fixture.holdProviders=()=>{providers.mode='hold';};
  window.__fixture.releaseProviders=answer=>{providers.mode='answer';providers.answer=answer||{providers:['microsoft','google']};const pending=providers.pending;providers.pending=null;if(pending)pending.resolve(providers.answer);};
  window.__fixture.failProviders=()=>{providers.mode='fail';const pending=providers.pending;providers.pending=null;if(pending)pending.reject(new Error('The account service could not be reached.'));};
  const providersAnswer=()=>{
   if(providers.mode==='answer')return Promise.resolve(providers.answer);
   if(providers.mode==='fail')return Promise.reject(new Error('The account service could not be reached.'));
   return new Promise((resolve,reject)=>{providers.pending={resolve,reject};});
  };
  let notify=()=>{};
  const push=patch=>{for(const [key,value] of Object.entries(patch))state[key]=value===null||typeof value!=='object'?value:structuredClone(value);notify({...state});};
  window.sendState=push;
  const record=(name,payload)=>window.__fixture.calls.push({name,payload});
  window.easterDesktop={
   mode:'desktop',status:async()=>({...state}),onState:callback=>{notify=callback;},
   signIn:async options=>{record('signIn',options);return {};},
   cancelSignIn:async()=>{record('cancelSignIn');},
   openMicrosoft:async()=>{record('openMicrosoft');},
   accountProviders:providersAnswer,
   signInProvider:async(provider,link)=>{record('signInProvider',{provider,link});return {};},
   updateProfile:async name=>{record('updateProfile',name);},
   setProfilePicture:async remove=>{record('setProfilePicture',remove);return {cancelled:true};},
   saveSettings:async values=>values,
   play:async()=>{record('play');}
  };
 },{skin:SKIN,picture:PICTURE});
 await page.goto(origin);
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.__fixture);

 // Reading the face back off the header canvas, pixel by pixel.
 const facePixels=()=>page.evaluate(()=>{
  const canvas=document.querySelector('.desktop-account-nav canvas');
  const context=canvas.getContext('2d');
  const pixels=row=>[...context.getImageData(0,row,32,1).data];
  return {size:[canvas.width,canvas.height],row0:pixels(0),row16:pixels(16)};
 });
 const header=()=>page.locator('.desktop-account-nav').evaluate(button=>({text:button.innerText.trim(),label:button.getAttribute('aria-label'),canvasHidden:button.querySelector('canvas').hidden}));
 const menu=()=>page.evaluate(()=>{
  const name=document.querySelector('.desktop-profile-heading.desktop-account .desktop-account-name');
  const signIn=document.querySelector('.desktop-profile-heading.desktop-account .desktop-account-signin');
  return {name:name&&!name.hidden?name.textContent:'',signIn:signIn&&!signIn.hidden?signIn.textContent:'',raw:document.querySelector('.desktop-account').textContent};
 });

 // --- The name the player is called leads ------------------------------------
 // The account's own display name, with the username kept as the sign-in line.
 await page.evaluate(skin=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:['crew'],passwordRequired:false,microsoftLinked:true,picture:null},profile:{id:'skin-owner',name:'HannahMC',skin},microsoftConnected:true}),SKIN);
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Hannah Easter');
 assert.deepEqual(await header(),{text:'Hannah Easter',label:'Account: Hannah Easter',canvasHidden:false},'the header shows the display name, not the username');
 await page.locator('.desktop-account-nav').click();
 assert.deepEqual(await menu(),{name:'Hannah Easter',signIn:'hannah_e',raw:'Hannah Easterhannah_e'},'the account view leads with the display name and prints the bare username under it, with no prefix (Owen, 2026-10-22)');
 note('header and account view: display name first, username as the sign-in identifier');

 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const box=await page.locator('.desktop-profile-menu').boundingBox();
  assert(box.x>=0&&box.x+box.width<=width+1,'the account menu fits '+width+'px');
  assert(box.y>=0&&box.y+box.height<=height+1,'the account menu fits vertically at '+width+'px');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'a long display name adds no horizontal overflow at '+width+'px');
  await page.screenshot({path:`${images}/account-menu-display-name-${width}.png`,animations:'disabled'});
 }
 await page.setViewportSize({width:1440,height:900});
 await page.keyboard.press('Escape');

 // The two ways an account can carry no separate name: a name that *is* the username,
 // and a fresh Microsoft signup that has not claimed a username yet. Neither prints an
 // empty line, a placeholder or "undefined".
 await page.evaluate(()=>sendState({account:{id:'EC-10',username:'owen_o',name:'owen_o',roles:[],passwordRequired:false,microsoftLinked:true,picture:null},profile:null}));
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='owen_o');
 await page.locator('.desktop-account-nav').click();
 assert.deepEqual(await menu(),{name:'owen_o',signIn:'',raw:'owen_o'},'an account whose name is its username does not repeat it as a sign-in line');
 await page.keyboard.press('Escape');
 // An account that has not claimed a username yet (a fresh Microsoft signup) is asked for
 // one by the existing setup dialog, so the header is asserted while that dialog is up.
 await page.evaluate(()=>sendState({account:{id:'EC-11',username:null,name:'Hannah Easter',roles:[],passwordRequired:true,microsoftLinked:true,picture:null},profile:null}));
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Hannah Easter');
 assert.equal((await header()).text,'Hannah Easter','a company account with no username yet still leads with the display name');
 await page.locator('#desktop-company-username').waitFor({state:'visible'});
 note('an account with no username yet shows its display name in the header (its setup dialog is the one on screen)');
 // The setup step is the account's own business and stays open until the player dismisses it;
 // the checks below are about the header, so it is closed here rather than left over the page.
 await page.locator('#desktop-company-username .dialog-close').click();
 await page.locator('#desktop-company-username').waitFor({state:'hidden'});
 // A main process that publishes no name at all (an older build) still gets the username.
 await page.evaluate(()=>sendState({account:{id:'EC-12',username:'legacy_user',roles:[],passwordRequired:false,microsoftLinked:false,picture:null},profile:null}));
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='legacy_user');
 assert.equal((await menu()).signIn,'','and no invented sign-in line appears when there is nothing but a username');
 note('display name, name-is-username and no-name accounts all read truthfully');

 // --- The face: picture, then Minecraft skin head, then the letter tile -------
 await page.evaluate(skin=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,picture:null},profile:{id:'skin-owner',name:'HannahMC',skin}}),SKIN);
 // The head is drawn from state.profile.skin alone: no request leaves the renderer.
 await page.waitForFunction(color=>{
  const context=document.querySelector('.desktop-account-nav canvas').getContext('2d');
  const pixel=[...context.getImageData(0,0,1,1).data];
  return pixel[0]===color[0]&&pixel[1]===color[1]&&pixel[2]===color[2];
 },faceColour(8,8));
 const head=await facePixels();
 assert.deepEqual(head.size,[32,32],'the header canvas stays 32x32');
 // Nearest neighbour: each of the 8 face pixels owns an exact 4x4 block of the 32px canvas,
 // so every pixel is either the face colour or that colour with the hat composited over it —
 // never an in-between value from smoothing.
 const expected=(row,column)=>{
  const skinX=8+Math.floor(column/4),skinY=8+Math.floor(row/4),colour=faceColour(skinX,skinY);
  // Face column 8+k is covered by hat column 40+k: that is where the overlay lives on the skin.
  return hatCovers(40+(skinX-8))?hatted(colour):colour;
 };
 for(let row=0;row<32;row+=4){
  const pixels=row===0?head.row0:row===16?head.row16:null;
  if(!pixels)continue;
  for(let column=0;column<32;column++){
   const got=pixels.slice(column*4,column*4+4),want=expected(row,column);
   for(let channel=0;channel<3;channel++)assert(Math.abs(got[channel]-want[channel])<=2,'the face is drawn nearest-neighbour ('+row+','+column+') in channel '+channel+': got '+[...got]+' want '+want);
  }
 }
 // The two halves of the head are visibly different: the un-hatted face on the left, the
 // same face with the hat layer over it from canvas column 8 rightwards.
 assert.deepEqual(head.row0.slice(0,3),[...FACE_A.slice(0,3)],'the left of the head is the face colour itself');
 assert.equal(head.row0[8*4]>=90&&head.row0[8*4]<=110&&head.row0[8*4+2]>150,true,'the hat overlay is composited over it (blue-dominant blend): '+[...head.row0.slice(32,35)]);
 note('the Minecraft skin head is drawn from state.profile.skin: face 8x8 at 8,8, hat at 40,8, nearest-neighbour');

 // A picture the player uploaded wins over the skin.
 await page.evaluate(picture=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,picture},profile:{id:'skin-owner',name:'HannahMC',skin:window.__fixture.skin}}),PICTURE);
 await page.waitForFunction(()=>{
  const pixel=[...document.querySelector('.desktop-account-nav canvas').getContext('2d').getImageData(16,16,1,1).data];
  return pixel[0]===180&&pixel[1]===60&&pixel[2]===120;
 });
 note('an uploaded picture still wins over the skin');
 await page.screenshot({path:`${images}/header-picture-1440.png`,animations:'disabled',clip:await page.locator('.site-header').boundingBox()});

 // Neither a picture nor a skin: the letter tile, and only then.
 await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,picture:null},profile:null}));
 await page.waitForFunction(()=>{
  const pixel=[...document.querySelector('.desktop-account-nav canvas').getContext('2d').getImageData(1,1,1,1).data];
  return pixel[0]===83&&pixel[1]===107&&pixel[2]===102;
 });
 const tile=await page.evaluate(()=>{
  const context=document.querySelector('.desktop-account-nav canvas').getContext('2d');
  const data=[...context.getImageData(0,0,32,32).data];
  // The tile is #536b66; the letter is #eedbb2. Many pixels are antialiased between them,
  // so the letter is counted as pixels clearly brighter than the tile.
  let letter=0;
  for(let index=0;index<data.length;index+=4)if(data[index]>150&&data[index+1]>150)letter++;
  return letter;
 });
 assert(tile>8,'the letter tile draws the name\'s first letter: '+tile+' letter pixels');
 note('with neither a picture nor a skin the initial-letter tile returns');

 // A skin is only the head of a *connected* Microsoft account: an account with no
 // Microsoft link has no Minecraft skin to draw, so it keeps the tile.
 await page.evaluate(skin=>sendState({account:{id:'EC-13',username:'google_user',name:'Google Player',roles:[],passwordRequired:false,microsoftLinked:false,picture:null},profile:{id:'skin-owner',name:'HannahMC',skin}}),SKIN);
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Google Player');
 await page.waitForFunction(()=>{
  const pixel=[...document.querySelector('.desktop-account-nav canvas').getContext('2d').getImageData(1,1,1,1).data];
  return pixel[0]===83&&pixel[1]===107&&pixel[2]===102;
 });
 note('an account with no Microsoft link keeps the letter tile rather than borrowing a skin');

 // --- The head a password sign-in still has ----------------------------------
 // Owen's report of 2026-10-19: he signed in with his Easter Company username and password,
 // and the header fell back to the letter tile because a password sign-in restores no
 // Microsoft session and therefore no skin. The account document knows the Minecraft uuid, so
 // main fetches the head and publishes it as state.minecraftHead. The renderer draws a data
 // URL and asks nobody anything, exactly as it does for state.profile.skin.
 const PASSWORD_ACCOUNT={id:'EC-30',username:'owen_e',name:'Owen Easter',minecraftName:'OwenMC',roles:[],passwordRequired:false,microsoftLinked:true,picture:null};
 const awaitingFace=async(colour,point=[0,0])=>page.waitForFunction(({colour,point})=>{
  const pixel=[...document.querySelector('.desktop-account-nav canvas').getContext('2d').getImageData(point[0],point[1],1,1).data];
  return pixel[0]===colour[0]&&pixel[1]===colour[1]&&pixel[2]===colour[2];
 },{colour,point});
 await page.evaluate(({account,head})=>sendState({account,profile:null,minecraftHead:head}),{account:PASSWORD_ACCOUNT,head:SKIN});
 await awaitingFace(faceColour(8,8));
 const stateHead=await facePixels();
 assert.deepEqual(stateHead.size,[32,32],'the header canvas stays 32x32');
 for(let column=0;column<32;column++){
  const got=stateHead.row0.slice(column*4,column*4+4),want=expected(0,column);
  for(let channel=0;channel<3;channel++)assert(Math.abs(got[channel]-want[channel])<=2,'the head from state.minecraftHead is drawn nearest-neighbour ('+column+') in channel '+channel+': got '+[...got]+' want '+want);
 }
 await page.screenshot({path:`${images}/header-minecraft-head-1440.png`,animations:'disabled',clip:await page.locator('.site-header').boundingBox()});
 note('with no session skin the Minecraft head is drawn from state.minecraftHead, by the same crop and the same pixels');

 // A picture still wins, and nothing else is invented from a head that is not this account's.
 await page.evaluate(({account,head,picture})=>sendState({account:{...account,picture},profile:null,minecraftHead:head}),{account:PASSWORD_ACCOUNT,head:SKIN,picture:PICTURE});
 await awaitingFace([180,60,120],[16,16]);
 note('an uploaded picture still wins over the head from state');

 // A read that failed, an account with no Microsoft link, and a value that is not a data URL
 // all leave the tile: the head is never borrowed, guessed at or fetched by the view.
 await page.evaluate(account=>sendState({account,profile:null,minecraftHead:null}),PASSWORD_ACCOUNT);
 await awaitingFace([83,107,102],[1,1]);
 await page.evaluate(({account,head})=>sendState({account:{...account,microsoftLinked:false,minecraftName:null},profile:null,minecraftHead:head}),{account:PASSWORD_ACCOUNT,head:SKIN});
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Owen Easter');
 await awaitingFace([83,107,102],[1,1]);
 await page.evaluate(({account})=>sendState({account,profile:null,minecraftHead:'https://textures.minecraft.net/texture/deadbeef'}),{account:PASSWORD_ACCOUNT});
 await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Owen Easter');
 await awaitingFace([83,107,102],[1,1]);
 note('a failed read, an unlinked account and a value that is not a data URL all leave the letter tile');

 // --- What the hero says about the Minecraft session -------------------------
 // The hero used to read "Sign in to Minecraft / Use your linked Microsoft account", which is the
 // first-time-connect sentence. Then 1.0.39 told Owen — signed in, Microsoft account linked — to
 // "Sign in with Microsoft" again, over a pause icon, because `connect-microsoft` shared its words
 // with a signed-out screen. His rule: a player who is signed in and linked is never asked to
 // sign in with Microsoft again; the press reconnects a Minecraft session, it does not log him in.
 // So every shape `minecraftSession.state` can take is asserted here, with the words and the
 // glyph, and the two shapes that used to fall through to the Microsoft demand (a session the
 // launcher could not read, and the wait while it asks) are asserted to say something else.
 const paused='M8 5v14M16 5v14';
 const heroNow=()=>page.locator('[data-desktop-play]').evaluate(node=>({
  action:node.dataset.action,
  text:node.innerText.replace(/\s+/g,' ').trim(),
  icon:node.querySelector('svg').innerHTML
 }));
 const heroFor=async(patch,action)=>{
  await page.evaluate(values=>sendState(values),patch);
  await page.waitForFunction(action=>document.querySelector('[data-desktop-play]')?.dataset.action===action,action);
  return heroNow();
 };
 // Every shape starts from the same base: a client that is installed, a signed-in Easter Company
 // account with a linked Microsoft account, and no Play until the session says so.
 const sessionShapes=async(patch,action)=>{
  const hero=await heroFor({account:PASSWORD_ACCOUNT,profile:null,minecraftHead:null,microsoftConnected:false,companyReady:true,canPlay:false,actions:[],minecraftAccess:'owned',install:INSTALLED,minecraftSession:null,...patch},action);
  assert(!hero.icon.includes(paused),'no hero shape wears the two-bar pause glyph ('+action+'): '+hero.icon);
  return hero;
 };
 const INSTALLED={installed:true,location:'/fixture/client',defaultLocation:'/fixture/client',version:'26.2'};
 // 1. A mint is in flight: the launcher is asking, so the hero says what it is waiting for and
 //    never names a provider it has not established anything about.
 const probing=await sessionShapes({actions:['connect-microsoft'],minecraftSession:{state:'checking',serverHeld:false,checkedAt:null}},'busy');
 assert.deepEqual({action:probing.action,text:probing.text},{action:'busy',text:'Checking your Minecraft session… Asking your Easter Company account'},'while the account service is being asked the hero says so: '+probing.text);
 // The same words for the state a linked account has before the first answer: nothing is known,
 // so nothing may be demanded. `checkedAt` is what tells this from an answer nobody could read.
 const unasked=await sessionShapes({minecraftSession:{state:'unknown',serverHeld:false,checkedAt:null}},'busy');
 assert.deepEqual({action:unasked.action,text:unasked.text},{action:'busy',text:'Checking your Minecraft session… Asking your Easter Company account'},'a session nobody has asked about yet is not a Microsoft demand either: '+unasked.text);
 // 2. An answer the launcher could not read: the retry, and never a Microsoft prompt.
 const unreadable=await sessionShapes({actions:['connect-microsoft'],minecraftSession:{state:'unknown',serverHeld:false,checkedAt:'2026-10-22T07:48:00Z'}},'retry-minecraft');
 assert.deepEqual({action:unreadable.action,text:unreadable.text},{action:'retry-minecraft',text:'Try again Your Minecraft session could not be checked'},'an unreadable answer earns a retry, not a sign-in: '+unreadable.text);
 assert(!/Microsoft/i.test(unreadable.text),'and it never names Microsoft: '+unreadable.text);
 // 3. A dead Easter Company session — the account is gone, so the account's own sign-in is the
 //    answer. This is the state main publishes after a mint answers 401 invalid_session: no
 //    account, companyReady false, and no session word at all.
 const deadCompany=await sessionShapes({account:null,companyReady:false,actions:['signin'],minecraftSession:null},'signin');
 assert.deepEqual({action:deadCompany.action,text:deadCompany.text},{action:'signin',text:'Sign in Easter Company account required'},'a dead Easter Company session asks for the account, not for Microsoft: '+deadCompany.text);
 assert(!/Microsoft/i.test(deadCompany.text),'the account\'s own sign-in is not a provider\'s: '+deadCompany.text);
 // 4. A linked account whose Minecraft session must be made again — the reconnect, with the
 //    Minecraft identity that will start the game named. Owen's own 07:48 screen, corrected.
 const reconnect=await sessionShapes({actions:['connect-microsoft'],minecraftSession:{state:'reauth',serverHeld:false,checkedAt:'2026-10-22T07:48:00Z'}},'connect-microsoft');
 assert.deepEqual({action:reconnect.action,text:reconnect.text},{action:'connect-microsoft',text:'Reconnect Microsoft Starts Minecraft as OwenMC'},'a signed-in linked account reconnects its Minecraft session and names the identity: '+reconnect.text);
 assert(!/Sign in with Microsoft/i.test(reconnect.text),'a signed-in, linked account is never told to sign in with Microsoft: '+reconnect.text);
 assert(!/sign in to minecraft|use your linked microsoft account/i.test(reconnect.text),'the first-time-connect sentence is gone too: '+reconnect.text);
 await page.screenshot({path:`${images}/hero-reconnect-1440.png`,animations:'disabled',clip:await page.locator('.hero-copy').boundingBox()});
 // The link state from the account's own document says the same thing as the session word.
 const linkedHero=await sessionShapes({actions:['connect-microsoft']},'connect-microsoft');
 assert.deepEqual(linkedHero,reconnect,'the linked-but-nothing-asked shape reads the same reconnect sentence');
 const namelessHero=await sessionShapes({account:{...PASSWORD_ACCOUNT,minecraftName:null},actions:['connect-microsoft'],minecraftSession:{state:'required',serverHeld:false,checkedAt:null}},'connect-microsoft');
 assert.deepEqual({action:namelessHero.action,text:namelessHero.text},{action:'connect-microsoft',text:'Reconnect Microsoft Starts Minecraft with your linked Microsoft account'},'a linked account with no Minecraft name gets the same sentence with no blank in it');
 // 5. An account with no Microsoft link at all attaches one.
 const unlinkedHero=await sessionShapes({account:{...PASSWORD_ACCOUNT,microsoftLinked:false,minecraftName:null},actions:['connect-microsoft'],minecraftSession:{state:'unlinked',serverHeld:false,checkedAt:null}},'link-microsoft');
 assert.deepEqual({action:unlinkedHero.action,text:unlinkedHero.text},{action:'link-microsoft',text:'Link Microsoft Attach the Microsoft account that owns Minecraft'},'an account with no Microsoft link offers the action that links one');
 await page.screenshot({path:`${images}/hero-unlinked-1440.png`,animations:'disabled',clip:await page.locator('.hero-copy').boundingBox()});
 for(const [width,height] of [[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  await page.screenshot({path:`${images}/hero-unlinked-${width}.png`,animations:'disabled',clip:await page.locator('.hero-copy').boundingBox()});
  const unlinkedBox=await page.locator('[data-desktop-play]').boundingBox();
  assert(unlinkedBox.x>=0&&unlinkedBox.x+unlinkedBox.width<=width+1,'the unlinked action fits '+width+'px');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'the longer note adds no horizontal overflow at '+width+'px');
 }
 await page.setViewportSize({width:1440,height:900});
 assert.notEqual(reconnect.text,unlinkedHero.text,'the two situations can never produce the same words');
 assert.notEqual(reconnect.action,unlinkedHero.action,'and they are not the same action either');
 // The five shapes are five different screens, and none of them is another one's words.
 const shapes=[probing,unreadable,deadCompany,reconnect,unlinkedHero];
 assert.equal(new Set(shapes.map(hero=>hero.action)).size,shapes.length,'every shape is its own action: '+shapes.map(hero=>hero.action).join(', '));
 assert.equal(new Set(shapes.map(hero=>hero.text)).size,shapes.length,'and its own words: '+shapes.map(hero=>hero.text).join(' | '));
 assert.equal(new Set(shapes.map(hero=>hero.icon)).size,shapes.length,'and its own glyph, so no two actions share an icon');
 note('probing, unreadable, dead-company, reconnect and unlinked are five different screens: their own words, their own actions, their own glyphs, and no pause anywhere');


 // Both kinds run the Microsoft link sign-in, because reconnecting a session and linking one
 // are the same flow: one attaches the account that is already known, the other attaches a new
 // one. Nothing here opens a Microsoft prompt on its own, and neither enables Play.
 await page.locator('[data-desktop-play]').click();
 await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.name==='signIn'));
 assert.deepEqual(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signIn').at(-1)),{name:'signIn',payload:{link:true}},'the unlinked action runs the Microsoft link sign-in');
 await page.keyboard.press('Escape');
 await page.evaluate(values=>sendState(values),{account:PASSWORD_ACCOUNT,profile:null,minecraftHead:null,microsoftConnected:false,canPlay:false,actions:['connect-microsoft'],minecraftSession:{state:'reauth',serverHeld:false,checkedAt:'2026-10-22T07:48:00Z'}});
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]')?.dataset.action==='connect-microsoft');
 await page.locator('[data-desktop-play]').click();
 await page.waitForFunction(()=>window.__fixture.calls.filter(call=>call.name==='signIn').length>=2);
 assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signIn').length),2,'the reconnect action runs the same sign-in, once');
 for(const dialog of await page.locator('dialog[open]').all())await dialog.evaluate(node=>node.close());
 note('both hero actions run the same Microsoft sign-in with the link intent');
 // --- The last known answer, while the launcher confirms it -------------------
 // Owen's first-launch complaint (ticket 19e51885): "Checking your Minecraft session…" for a mint
 // that may take three minutes. Main publishes the answer it last knew with `sessionCached: true`
 // and the moment it was written in `minecraftSession.cachedAt`, and the hero draws that word's
 // action with one sentence under it. The sentence is the whole of this feature's copy, and it is
 // gone the moment the real answer lands — which is what the second half of each pair below shows.
 const CACHED_AT=new Date(Date.now()-2*60*60*1000).toISOString();
 const cachedHero=async(patch,action)=>{
  const hero=await heroFor({account:PASSWORD_ACCOUNT,profile:null,minecraftHead:null,microsoftConnected:false,companyReady:true,canPlay:false,actions:[],minecraftAccess:'owned',install:INSTALLED,minecraftSession:null,sessionCached:true,...patch},action);
  assert(!hero.icon.includes(paused),'a cached action wears no pause glyph ('+action+'): '+hero.icon);
  return hero;
 };
 const cachedPlay=await cachedHero({minecraftSession:{state:'server',serverHeld:true,checkedAt:CACHED_AT,cachedAt:CACHED_AT}},'play');
 assert.deepEqual(cachedPlay,{action:'play',text:'PLAY NOW Last checked 2 hours ago · confirming now',icon:cachedPlay.icon},'a cached answer the launcher last knew draws Play and says how old the answer is and that it is being confirmed: '+cachedPlay.text);
 // The account's own Java profile is not there yet on a cold start, and the note must never grow
 // a name it does not have: the sentence is the whole note.
 const cachedPlayNamed=await cachedHero({profile:{name:'OwenTheCaptain',id:'1234567890abcdef1234567890abcdef',skin:null},minecraftSession:{state:'server',serverHeld:true,checkedAt:CACHED_AT,cachedAt:CACHED_AT}},'play');
 assert.equal(cachedPlayNamed.text,'PLAY NOW Last checked 2 hours ago · confirming now','a cached Play note is the sentence alone, with no profile name appended: '+cachedPlayNamed.text);
 const cachedLocal=await cachedHero({minecraftSession:{state:'local',serverHeld:false,checkedAt:null,cachedAt:CACHED_AT}},'play');
 assert.equal(cachedLocal.text,cachedPlay.text,'a cached local session draws the same Play and the same sentence');
 const cachedReauth=await cachedHero({actions:['connect-microsoft'],minecraftSession:{state:'reauth',serverHeld:false,checkedAt:CACHED_AT,cachedAt:CACHED_AT}},'connect-microsoft');
 assert.deepEqual({action:cachedReauth.action,text:cachedReauth.text},{action:'connect-microsoft',text:'Reconnect Microsoft Last checked 2 hours ago · confirming now'},'a cached answer that needs the reconnect draws Reconnect Microsoft and says it is last known: '+cachedReauth.text);
 assert(!/Sign in with Microsoft/i.test(cachedReauth.text),'and is still never told to sign in with Microsoft: '+cachedReauth.text);
 const cachedUnlinked=await cachedHero({account:{...PASSWORD_ACCOUNT,microsoftLinked:false,minecraftName:null},actions:['link-microsoft'],minecraftSession:{state:'unlinked',serverHeld:false,checkedAt:null,cachedAt:CACHED_AT}},'link-microsoft');
 assert.equal(cachedUnlinked.text,'Link Microsoft Last checked 2 hours ago · confirming now','a cached unlinked account draws Link Microsoft and the same sentence');
 const cachedBusy=await cachedHero({actions:['connect-microsoft'],minecraftSession:{state:'busy',serverHeld:false,checkedAt:CACHED_AT,cachedAt:CACHED_AT}},'retry-minecraft');
 assert.equal(cachedBusy.text,'Try again Last checked 2 hours ago · confirming now','a cached busy answer draws the retry, never a Microsoft prompt');
 assert(!/Microsoft/i.test(cachedBusy.text),'and names no provider: '+cachedBusy.text);
 // The age is the cache's own moment, in the launcher's quiet voice, and it never counts days:
 // the bound it can never exceed is 24 hours (doc/launcher-states.md).
 const fresh=await cachedHero({minecraftSession:{state:'server',serverHeld:true,checkedAt:new Date().toISOString(),cachedAt:new Date().toISOString()}},'play');
 assert.equal(fresh.text,'PLAY NOW Last checked just now · confirming now','an answer a moment old reads just now: '+fresh.text);
 const older=await cachedHero({minecraftSession:{state:'server',serverHeld:true,checkedAt:CACHED_AT,cachedAt:new Date(Date.now()-11*60*60*1000).toISOString()}},'play');
 assert.equal(older.text,'PLAY NOW Last checked 11 hours ago · confirming now','and a morning-old one counts hours: '+older.text);
 // The answer lands and contradicts the cache: today's screen, word for word, with no note left.
 const corrected=await heroFor({account:PASSWORD_ACCOUNT,profile:null,minecraftHead:null,microsoftConnected:false,companyReady:true,canPlay:false,actions:['connect-microsoft'],minecraftAccess:'owned',install:INSTALLED,sessionCached:false,minecraftSession:{state:'reauth',serverHeld:false,checkedAt:'2026-10-22T07:48:00Z'}},'connect-microsoft');
 assert.deepEqual({action:corrected.action,text:corrected.text,icon:corrected.icon},{action:reconnect.action,text:reconnect.text,icon:reconnect.icon},'the settled state is character for character the screen it was before this feature: '+corrected.text);
 assert(!/confirming|Last checked/.test(corrected.text),'and no part of the note survives the answer: '+corrected.text);
 // A build that does not publish the flag renders exactly as it did, and a cache that somehow
 // claims the wait falls through to today's wait rather than inventing a screen.
 const unflagged=await heroFor({account:PASSWORD_ACCOUNT,profile:null,minecraftHead:null,microsoftConnected:false,companyReady:true,canPlay:false,actions:['connect-microsoft'],minecraftAccess:'owned',install:INSTALLED,sessionCached:undefined,minecraftSession:{state:'checking',serverHeld:false,checkedAt:null}},'busy');
 assert.equal(unflagged.text,'Checking your Minecraft session… Asking your Easter Company account','an older main process, or a cache that claims the wait, renders the waiting screen exactly as it is today: '+unflagged.text);
 const cachedChecking=await cachedHero({actions:['connect-microsoft'],minecraftSession:{state:'checking',serverHeld:false,checkedAt:null,cachedAt:CACHED_AT}},'busy');
 assert.equal(cachedChecking.text,unflagged.text,'a cache word of checking is never a screen of its own');
 await page.screenshot({path:`${images}/hero-cached-1440.png`,animations:'disabled',clip:await page.locator('.hero-copy').boundingBox()});
 note('a cached answer draws its own action — Play, Reconnect Microsoft, Link Microsoft or Try again — with the last-checked sentence under it, the age taken from the moment the file was written, and the note leaves with the flag so the settled screen is character for character the one it was before');

 // The recorded visual pass: the header with a skin and without, at 1440 and 390.
 for(const [width,height] of [[1440,900],[390,568]]){
  await page.setViewportSize({width,height});
  await page.evaluate(skin=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,picture:null},profile:{id:'skin-owner',name:'HannahMC',skin}}),SKIN);
  await page.waitForFunction(()=>document.querySelector('.desktop-account-nav').innerText.trim()==='Hannah Easter');
  await page.waitForTimeout(120);
  const headerBox=await page.locator('.site-header').boundingBox();
  await page.screenshot({path:`${images}/header-skin-${width}.png`,animations:'disabled',clip:headerBox});
  const navBox=await page.locator('.desktop-account-nav').boundingBox();
  assert(navBox.x>=0&&navBox.x+navBox.width<=width+1,'the header account control fits '+width+'px');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'the header adds no horizontal overflow at '+width+'px');
  await page.locator('.desktop-account-nav').click();
  await page.screenshot({path:`${images}/account-menu-skin-${width}.png`,animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,picture:null},profile:null}));
  await page.waitForTimeout(120);
  await page.screenshot({path:`${images}/header-initial-tile-${width}.png`,animations:'disabled',clip:headerBox});
 }
 await page.setViewportSize({width:1440,height:900});
 note('visual pass recorded in '+images);

 // A display name is the player's own text and the account service allows 64 characters, so
 // the header has to hold the longest one without widening the page or clipping the nav.
 await page.setViewportSize({width:390,height:568});
 const longName='Bartholomew Montgomery Featherstonehaugh Eastwood III';
 await page.evaluate(name=>sendState({account:{id:'EC-14',username:'bartholomew_mf',name,roles:[],passwordRequired:false,microsoftLinked:false,picture:null},profile:null}),longName);
 await page.waitForFunction(name=>document.querySelector('.desktop-account-nav').innerText.trim()===name,longName);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'a long display name adds no horizontal overflow at 390px');
 const longNav=await page.locator('.desktop-account-nav').boundingBox();
 assert(longNav.x>=0&&longNav.x+longNav.width<=391,'the header account control stays inside a 390px window with a long name');
 await page.screenshot({path:`${images}/header-long-name-390.png`,animations:'disabled',clip:await page.locator('.site-header').boundingBox()});
 await page.setViewportSize({width:1440,height:900});
 note('a 50-character display name still fits the header at 390px');

 // --- A linked provider offers nothing that can only fail --------------------
 const profileRows=()=>page.evaluate(()=>[...document.querySelectorAll('#company-linked-accounts .company-provider-link')].map(row=>({
  label:row.querySelector('span')?.textContent||'',
  buttons:[...row.querySelectorAll('button')].map(button=>({text:button.textContent,label:button.getAttribute('aria-label'),disabled:button.disabled}))
 })));
 await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],picture:null},profile:null}));
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 const linked=await profileRows();
 const microsoftRow=linked.find(row=>row.label.startsWith('Microsoft'));
 assert.deepEqual(microsoftRow,{label:'Microsoft / Xbox · linked',buttons:[]},'an already-linked Microsoft account is described and not offered');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:/verify/i}).count(),0,'no Verify control exists on any provider row');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Google',exact:true}).count(),1,'an unlinked provider keeps its Connect action');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Steam',exact:true}).isDisabled(),true,'a provider this build cannot offer is not pressable');
 // The unlink rule made structural (Owen, 2026-10-23): all four rows are present, the linked one
 // carries no control of any kind, and the unlinked ones carry one Connect and nothing else - so a
 // control that could remove a link cannot be added to a row without failing here.
 assert.deepEqual(linked.map(row=>row.label),['Microsoft / Xbox · linked','Google','Steam','Discord'],'all four provider rows are drawn, in their fixed order, with linked state in the label: '+JSON.stringify(linked));
 for(const row of linked){
  const named=row.buttons.map(button=>button.label||button.text);
  if(row.label.includes('· linked'))assert.deepEqual(row.buttons,[],'a linked row carries no button at all: '+JSON.stringify(row));
  else assert.deepEqual(named,['Connect '+row.label],'an unlinked row carries one Connect and nothing else: '+JSON.stringify(row));
 }
 assert.equal(await page.locator('#company-linked-accounts [data-unlink],#company-linked-accounts [data-remove],#company-linked-accounts [data-disconnect]').count(),0,'and no row or control carries an unlink, remove or disconnect attribute');
 // Owen, 2026-10-23: the third-party link is the verification that a person is one person, so a
 // link cannot be removed and the dialog says so and why. The old sentence ended "from the launcher
 // yet", which promised a removal that is not coming; this asserts the sentence itself, and that
 // nothing in it reads as a promise.
 const linkedText=await page.locator('#company-linked-accounts').innerText();
 assert.match(linkedText,/Links stay with this Easter Company account and cannot be removed\. Your linked account is how we know you are you\./,'the dialog says plainly that a link cannot be removed and that the link is the verification: '+linkedText.replace(/\s+/g,' '));
 assert(!/\byet\b|for now|temporarily|coming soon|in future|later release/i.test(linkedText),'and nothing in it promises a removal later: '+linkedText.replace(/\s+/g,' '));
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:/unlink|un-link|disconnect|remove|delete/i}).count(),0,'no control offers to unlink, disconnect or remove a provider');
 assert.equal(await page.locator('#company-linked-accounts a[href]').count(),0,'and no link in the dialog points at one either');
 await page.screenshot({path:`${images}/profile-linked-1440.png`,animations:'disabled'});
 for(const [width,height] of [[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  assert.equal(await page.locator('#company-linked-accounts').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the profile dialog has no horizontal overflow at '+width+'px');
  const box=await page.locator('#company-linked-accounts').boundingBox();
  assert(box.x>=0&&box.x+box.width<=width+1,'the profile dialog fits '+width+'px');
  await page.screenshot({path:`${images}/profile-linked-${width}.png`,animations:'disabled'});
 }
 await page.setViewportSize({width:1440,height:900});
 // Connect is what an unlinked provider offers, and it is the link flow that can work.
 await page.getByRole('button',{name:'Connect Google',exact:true}).click();
 const providerCall=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signInProvider').at(-1));
 assert.deepEqual(providerCall,{name:'signInProvider',payload:{provider:'google',link:true}},'Connect runs the provider link flow');
 note('a linked provider is described with no action; only an unlinked one offers Connect, and no control in the dialog could unlink, disconnect or remove a provider');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});

 // --- A linked provider's own details ----------------------------------------
 // Owen's specification: under a linked provider, its own values as labelled lines. The state
 // below is the screenshot case - two providers carrying details, one linked provider that
 // knows nothing - and the Minecraft name is the account's own field, not the display name
 // the player may edit and not the copy the cloud may send inside providerDetails.
 const detailRows=()=>page.evaluate(()=>[...document.querySelectorAll('#company-linked-accounts .company-provider-link')].map(row=>({
  label:row.querySelector('.company-provider-name')?.textContent||'',
  lines:[...row.querySelectorAll('.company-provider-detail')].map(line=>line.innerText),
  blocks:row.querySelectorAll('.company-provider-details').length
 })));
 const LINKED_ACCOUNT={id:'EC-20',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,providers:['microsoft','google','steam'],minecraftName:'HannahMC',picture:null};
 await page.evaluate(account=>sendState({account:{...account,providerDetails:{microsoft:{gamertag:'Hannah Wren'},google:{email:'hannah@example.test'},steam:{persona:null}}},profile:null}),LINKED_ACCOUNT);
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 assert.deepEqual(await detailRows(),[
  {label:'Microsoft / Xbox · linked',lines:['Xbox Gamer Tag: Hannah Wren','Minecraft Username: HannahMC'],blocks:1},
  {label:'Google · linked',lines:['Gmail: hannah@example.test'],blocks:1},
  {label:'Steam · linked',lines:[],blocks:0},
  {label:'Discord',lines:[],blocks:0}
 ],'each linked provider draws its own labelled lines, a linked provider with nothing known draws none, and an unlinked provider has no detail block at all');
 const detailText=await page.locator('#company-linked-accounts').innerText();
 assert(!/undefined|\bnull\b|\{|\}/.test(detailText),'no placeholder, brace, null or undefined reaches the dialog: '+JSON.stringify(detailText.slice(detailText.indexOf('Linked accounts'))));
 for(const line of (await detailRows()).flatMap(row=>row.lines))assert.match(line,/^[A-Za-z][^:]*: \S/,'a drawn line is a label and a value: '+JSON.stringify(line));
 // The section keeps its shape: the sentence, the wording, and Connect only where it can work.
 assert.match(detailText,/Links stay with this Easter Company account/);
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Discord',exact:true}).count(),1,'the one unlinked provider still offers Connect');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:/^Connect (Microsoft|Google|Steam)/}).count(),0,'a linked provider offers no control');
 await page.screenshot({path:`${images}/profile-provider-details-1440.png`,animations:'disabled'});
 for(const [width,height] of [[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  assert.equal(await page.locator('#company-linked-accounts').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the detail lines add no horizontal overflow at '+width+'px');
  await page.screenshot({path:`${images}/profile-provider-details-${width}.png`,animations:'disabled'});
 }
 await page.setViewportSize({width:1440,height:900});
 note('two providers with details and one linked provider with nothing known, at 1440, 800 and 390');

 // The values are another party's text, so they are only ever text: markup in a value draws
 // nothing, and a record this launcher cannot read renders exactly as the dialog did before
 // providerDetails existed.
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 await page.evaluate(account=>sendState({account:{...account,providerDetails:{steam:{persona:'<b>Wren</b>'}}},profile:null}),LINKED_ACCOUNT);
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 assert.equal(await page.locator('#company-linked-accounts .company-provider-detail b, #company-linked-accounts .company-provider-detail img').count(),0,'a value that looks like markup draws no element');
 assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('#company-linked-accounts .company-provider-detail-value')].map(node=>node.textContent)),['HannahMC','<b>Wren</b>'],'each value is shown as the text it is');
 assert.deepEqual((await detailRows())[0],{label:'Microsoft / Xbox · linked',lines:['Minecraft Username: HannahMC'],blocks:1},'the gamertag this state does not carry draws no line, while the account\'s own Minecraft name still does');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 // A document with no providerDetails at all - the live one, until the cloud ships the field -
 // is today's dialog plus the one line the account state already answers from: the Minecraft
 // name. Nothing else appears, and nothing breaks. (Address validation is the main process's
 // job and is proven in tests/desktop/provider-details.test.cjs; this view shows what it is
 // given and never judges it.)
 const TODAY=[{label:'Microsoft / Xbox · linked',lines:['Minecraft Username: HannahMC'],blocks:1},
  {label:'Google · linked',lines:[],blocks:0},
  {label:'Steam · linked',lines:[],blocks:0},
  {label:'Discord',lines:[],blocks:0}];
 for(const broken of ['details',['microsoft'],[{gamertag:'x'}],{microsoft:'x'},{microsoft:null},{microsoft:{gamertag:5}},{microsoft:{gamertag:'   '}}]){
  await page.evaluate(({account,broken})=>sendState({account:{...account,providerDetails:broken},profile:null}),{account:LINKED_ACCOUNT,broken});
  await page.locator('.desktop-account-nav').click();
  await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
  await page.locator('#company-linked-accounts').waitFor({state:'visible'});
  assert.deepEqual(await detailRows(),TODAY,'a record this launcher cannot read renders as today: '+JSON.stringify(broken));
  await page.locator('#company-linked-accounts .dialog-close').click();
  await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 }
 await page.evaluate(account=>sendState({account,profile:null}),LINKED_ACCOUNT);
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 assert.deepEqual(await detailRows(),TODAY,'a live document with no providerDetails renders as today');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 // An account with no Minecraft profile has no Minecraft name to show, and the row falls back
 // to nothing rather than to the display name the player may set to anything.
 await page.evaluate(account=>sendState({account:{...account,minecraftName:null,providerDetails:{microsoft:{gamertag:'Hannah Wren'}}},profile:null}),LINKED_ACCOUNT);
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 assert.deepEqual((await detailRows())[0].lines,['Xbox Gamer Tag: Hannah Wren'],'with no Minecraft name on the account the row shows only the gamertag - never the display name');
 assert.deepEqual(errors,[],'rendering a malformed record raises no page error');
 note('a value is text and never markup, and a missing or malformed record draws nothing at all');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});

 // The same for a Microsoft account that is not linked yet: one Connect, which links.
 await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:false,providers:[],picture:null},profile:null}));
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
 await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Microsoft / Xbox',exact:true}).count(),1,'an unlinked Microsoft account offers Connect');
 await page.screenshot({path:`${images}/profile-unlinked-1440.png`,animations:'disabled'});
 await page.getByRole('button',{name:'Connect Microsoft / Xbox',exact:true}).click();
 await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.name==='signIn'));
 const signInCall=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signIn').at(-1));
 assert.deepEqual(signInCall,{name:'signIn',payload:{link:true}},'Connect Microsoft runs the link sign-in');
 note('Connect Microsoft links; the control is offered only when there is something to link');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});

 // --- The account service being cold ------------------------------------------
 // Owen, 2026-10-23, with this dialog open against a cold account API: "when the api is cold, we
 // need a loading spinner for the account section here." The dialog used to await the providers
 // answer before it built anything, so on the cold path it opened with an empty section and no
 // word about it for the whole wait (measured on the tree before this change: the dialog on
 // screen 295 ms after the press, then 12 s held with 0 provider rows, 0 busy marks and 0 live
 // regions carrying text), and the rows it did eventually draw offered Connect for providers the
 // launcher had not heard about yet.
 //
 // Nothing here watches a clock: the answer is held open on a promise, so the busy state is
 // proven by the answer not existing, and the rows are proven absent while it does not.
 const BUSY_LINE='Checking your linked accounts…';
 const busyState=()=>page.evaluate(()=>{
  const dialog=document.querySelector('#company-linked-accounts');
  if(!dialog)return null;
  const host=dialog.querySelector('.company-wait'),mark=dialog.querySelector('.company-wait .wait-feedback-mark');
  return {
   rows:dialog.querySelectorAll('.company-provider-link').length,
   connects:dialog.querySelectorAll('.company-provider-link button').length,
   waitVisible:Boolean(host&&!host.hidden),
   waitText:host?host.textContent.trim():'',
   markHidden:mark?mark.getAttribute('aria-hidden'):null,
   markAnimation:mark?getComputedStyle(mark).animationName:'',
   // Every live region in the dialog that is on screen and actually says something. One busy
   // state means exactly one of these, and no aria-busy arguing with it.
   announcing:[...dialog.querySelectorAll('[role=status],[aria-live]')]
    .filter(node=>!node.hidden&&node.textContent.trim()).map(node=>({role:node.getAttribute('role'),text:node.textContent.trim()})),
   ariaBusy:dialog.getAttribute('aria-busy'),
   failures:[...dialog.querySelectorAll('.company-error')].filter(node=>!node.hidden).map(node=>node.textContent.trim()),
   closeDisabled:dialog.querySelector('.dialog-close').disabled
  };
 });
 const COLD_ACCOUNT={...LINKED_ACCOUNT,providerDetails:{microsoft:{gamertag:'Hannah Wren'},google:{email:'hannah@example.test'},steam:{persona:null}}};
 const COLD_ROWS=[
  {label:'Microsoft / Xbox · linked',lines:['Xbox Gamer Tag: Hannah Wren','Minecraft Username: HannahMC'],blocks:1},
  {label:'Google · linked',lines:['Gmail: hannah@example.test'],blocks:1},
  {label:'Steam · linked',lines:[],blocks:0},
  {label:'Discord',lines:[],blocks:0}
 ];
 await page.evaluate(account=>sendState({account,profile:null}),COLD_ACCOUNT);
 await page.evaluate(()=>window.__fixture.holdProviders());
 const openLinkedAccounts=async()=>{
  await page.locator('.desktop-account-nav').click();
  await page.getByRole('button',{name:'Linked Accounts',exact:true}).click();
  await page.locator('#company-linked-accounts').waitFor({state:'visible'});
 };
 await openLinkedAccounts();
 const busy=await busyState();
 assert.equal(busy.waitVisible,true,'the dialog shows the busy state while the providers answer is outstanding');
 assert(busy.waitText.startsWith(BUSY_LINE),'and it says what it is doing, in one plain sentence: '+JSON.stringify(busy.waitText));
 assert.equal(busy.markHidden,'true','the ring is decorative, beside the sentence that carries the state');
 assert.equal(busy.markAnimation,'update-spin','the ring is the launcher\'s existing indeterminate progress, not a new look: '+busy.markAnimation);
 assert.deepEqual(busy.announcing.map(region=>region.role),['status'],'the busy state is announced once, by one role=status region: '+JSON.stringify(busy.announcing));
 assert(busy.announcing[0].text.startsWith(BUSY_LINE),'and the region that announces it carries the sentence');
 assert.equal(busy.ariaBusy,null,'aria-busy is not set as well: one announcement, not two fighting');
 assert.equal(busy.rows,0,'no provider row is drawn before the answer is in');
 assert.equal(busy.connects,0,'and no row offers Connect on a guess');
 assert.deepEqual(busy.failures,[],'a wait is not a failure and prints no failure sentence');
 assert.equal(busy.closeDisabled,false,'the close control keeps working while it waits');
 await page.screenshot({path:`${images}/profile-linked-busy-1440.png`,animations:'disabled'});

 // The wait is not a trap: the close control works on it, and reopening asks again.
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 // Reduced motion keeps the ring still (site/wait-feedback.mjs, .wait-feedback-mark) and the
 // sentence carries the state exactly as before.
 await page.emulateMedia({reducedMotion:'reduce'});
 await openLinkedAccounts();
 const still=await busyState();
 assert.equal(still.waitVisible,true,'the busy state is still shown under reduced motion');
 assert.equal(still.markAnimation,'none','and its ring is still there and not animating: '+still.markAnimation);
 assert.equal(still.rows,0,'with still no row before the answer');
 await page.emulateMedia({reducedMotion:'no-preference'});

 // The answer arrives while the dialog is open: the rows are painted where the wait was, with no
 // reload and no second spinner.
 await page.evaluate(()=>window.__fixture.releaseProviders());
 await page.waitForFunction(()=>document.querySelectorAll('#company-linked-accounts .company-provider-link').length>0);
 const settled=await busyState();
 assert.equal(settled.waitVisible,false,'the busy state leaves when the answer arrives');
 assert.deepEqual(await detailRows(),COLD_ROWS,'and the rows are drawn exactly as they are on the warm path');
 assert.equal(await page.locator('#company-linked-accounts .wait-feedback-mark:visible').count(),0,'no spinner is left behind');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Discord',exact:true}).count(),1,'the unlinked provider keeps its Connect');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Discord',exact:true}).isDisabled(),true,'and it answers to the availability the launcher actually reported: Discord is not in it');
 assert.equal(await page.locator('#company-linked-accounts').getByRole('button',{name:'Connect Google',exact:true}).count(),0,'a provider this account already plays through offers no Connect');
 assert.deepEqual(settled.failures,[],'settling is not a failure');
 await page.screenshot({path:`${images}/profile-linked-settled-1440.png`,animations:'disabled'});
 note('cold path: the dialog opens at once on one busy sentence and no rows, and settles into today\'s rows when the answer lands');
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});

 // A read that failed is one sentence and no spinner: never a permanent wait, and never an empty
 // list, which would say nothing is linked when the truth is that nobody could read it.
 await page.evaluate(()=>window.__fixture.failProviders());
 await openLinkedAccounts();
 await page.waitForFunction(()=>{const node=document.querySelector('#company-linked-accounts .company-error');return node&&!node.hidden;});
 const failed=await busyState();
 assert.deepEqual(failed.failures,['Your linked accounts could not be read.'],'a failed answer is one sentence naming the read: '+JSON.stringify(failed.failures));
 assert.equal(failed.waitVisible,false,'and the busy state is gone rather than spinning for ever');
 assert.equal(await page.locator('#company-linked-accounts .wait-feedback-mark:visible').count(),0,'no spinner is left behind');
 assert.equal(failed.rows,0,'and no empty row set implying nothing is linked');
 assert.equal(failed.closeDisabled,false,'the close control still works on the failure');
 assert.equal(await page.locator('#company-linked-accounts .company-error').getAttribute('role'),'alert','the sentence is announced as a failure');
 await page.screenshot({path:`${images}/profile-linked-failed-1440.png`,animations:'disabled'});
 await page.locator('#company-linked-accounts .dialog-close').click();
 await page.locator('#company-linked-accounts').waitFor({state:'detached'});
 note('cold path: a failed providers answer is one sentence in the dialog\'s existing failure slot, with no spinner and no row set');

 assert.deepEqual(errors,[],'the launcher raises no page error');
 assert.deepEqual(requests.filter(url=>!/^data:/.test(url)&&!url.startsWith(origin)),[],'the renderer reads nothing over the network of its own: every request it made was for the page itself');
 console.log(`IDENTITY PASS: ${notes.length} checks — display name first in the header and the account view, the Minecraft head from state.profile.skin or state.minecraftHead with the initial tile last, five Minecraft-session shapes with their own words, action and glyph (probing, unreadable answer, dead Easter Company session, reconnect, unlinked) and no pause icon and no "Sign in with Microsoft" over a signed-in linked account, no provider control that can only fail and no control at all that could unlink, disconnect or remove a provider (a linked row carries none, an unlinked row carries its Connect only), the dialog's own sentence that a link cannot be removed and why with no "yet" in it, each linked provider's own details drawn as text with no line where there is no value, and a cold account API answered by one honest busy state that settles into those same rows or one failure sentence. Screenshots: ${images}`);
}finally{
 await browser.close();
}
