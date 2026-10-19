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
try{
 const page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({skin,picture})=>{
  const state={version:'1.0.31',totalMemoryMB:16384,phase:'ready',startupReady:true,companyReady:true,microsoftConnected:true,canPlay:true,
   account:null,profile:null,device:null,activity:null,settings:{memoryMB:4096,javaPath:''},
   install:{installed:true,location:'/fixture/client',defaultLocation:'/fixture/client',version:'26.2'},actions:['play'],
   graphics:{enabled:false,recommended:true,tunable:true},game:{state:'running',ready:true},progress:null,bar:{visible:false}};
  window.__fixture={skin,picture,calls:[]};
  let notify=()=>{};
  const push=patch=>{for(const [key,value] of Object.entries(patch))state[key]=value===null||typeof value!=='object'?value:structuredClone(value);notify({...state});};
  window.sendState=push;
  const record=(name,payload)=>window.__fixture.calls.push({name,payload});
  window.easterDesktop={
   mode:'desktop',status:async()=>({...state}),onState:callback=>{notify=callback;},
   signIn:async options=>{record('signIn',options);return {};},
   cancelSignIn:async()=>{record('cancelSignIn');},
   openMicrosoft:async()=>{record('openMicrosoft');},
   accountProviders:async()=>({providers:['microsoft','google']}),
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
 assert.deepEqual(await menu(),{name:'Hannah Easter',signIn:'Signs in as hannah_e',raw:'Hannah EasterSigns in as hannah_e'},'the account view leads with the display name and keeps the username as the sign-in line');
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
 const profileRows=()=>page.evaluate(()=>[...document.querySelectorAll('#company-profile .company-provider-link')].map(row=>({
  label:row.querySelector('span')?.textContent||'',
  buttons:[...row.querySelectorAll('button')].map(button=>({text:button.textContent,label:button.getAttribute('aria-label'),disabled:button.disabled}))
 })));
 await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:true,providers:['microsoft'],picture:null},profile:null}));
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 await page.locator('#company-profile').waitFor({state:'visible'});
 const linked=await profileRows();
 const microsoftRow=linked.find(row=>row.label.startsWith('Microsoft'));
 assert.deepEqual(microsoftRow,{label:'Microsoft / Xbox · linked',buttons:[]},'an already-linked Microsoft account is described and not offered');
 assert.equal(await page.locator('#company-profile').getByRole('button',{name:/verify/i}).count(),0,'no Verify control exists on any provider row');
 assert.equal(await page.locator('#company-profile').getByRole('button',{name:'Connect Google',exact:true}).count(),1,'an unlinked provider keeps its Connect action');
 assert.equal(await page.locator('#company-profile').getByRole('button',{name:'Connect Steam',exact:true}).isDisabled(),true,'a provider this build cannot offer is not pressable');
 assert.match(await page.locator('#company-profile').innerText(),/cannot be removed from the launcher yet/,'the dialog says plainly why a linked account carries no control');
 await page.screenshot({path:`${images}/profile-linked-1440.png`,animations:'disabled'});
 for(const [width,height] of [[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  assert.equal(await page.locator('#company-profile').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the profile dialog has no horizontal overflow at '+width+'px');
  const box=await page.locator('#company-profile').boundingBox();
  assert(box.x>=0&&box.x+box.width<=width+1,'the profile dialog fits '+width+'px');
  await page.screenshot({path:`${images}/profile-linked-${width}.png`,animations:'disabled'});
 }
 await page.setViewportSize({width:1440,height:900});
 // Connect is what an unlinked provider offers, and it is the link flow that can work.
 await page.getByRole('button',{name:'Connect Google',exact:true}).click();
 const providerCall=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signInProvider').at(-1));
 assert.deepEqual(providerCall,{name:'signInProvider',payload:{provider:'google',link:true}},'Connect runs the provider link flow');
 note('a linked provider is described with no action; only an unlinked one offers Connect');
 await page.locator('#company-profile .dialog-close').click();
 await page.locator('#company-profile').waitFor({state:'detached'});

 // The same for a Microsoft account that is not linked yet: one Connect, which links.
 await page.evaluate(()=>sendState({account:{id:'EC-9',username:'hannah_e',name:'Hannah Easter',roles:[],passwordRequired:false,microsoftLinked:false,providers:[],picture:null},profile:null}));
 await page.locator('.desktop-account-nav').click();
 await page.getByRole('button',{name:'Profile & linked accounts',exact:true}).click();
 await page.locator('#company-profile').waitFor({state:'visible'});
 assert.equal(await page.locator('#company-profile').getByRole('button',{name:'Connect Microsoft / Xbox',exact:true}).count(),1,'an unlinked Microsoft account offers Connect');
 await page.screenshot({path:`${images}/profile-unlinked-1440.png`,animations:'disabled'});
 await page.getByRole('button',{name:'Connect Microsoft / Xbox',exact:true}).click();
 await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.name==='signIn'));
 const signInCall=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.name==='signIn').at(-1));
 assert.deepEqual(signInCall,{name:'signIn',payload:{link:true}},'Connect Microsoft runs the link sign-in');
 note('Connect Microsoft links; the control is offered only when there is something to link');

 assert.deepEqual(errors,[],'the launcher raises no page error');
 console.log(`IDENTITY PASS: ${notes.length} checks — display name first in the header and the account view, Minecraft skin head from state.profile.skin, initial tile last, and no provider control that can only fail. Screenshots: ${images}`);
}finally{
 await browser.close();
}
