import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The account control's face has its own journey below; the fixture skin module already owns the
// only image this suite needs to be exact about.
import {pictureDataURL,skinDataURL,FACE_A,FACE_B,hatted} from './skin-fixture.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18104';
const api='https://jyjshd22z3.execute-api.us-east-2.amazonaws.com';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
// The display name is deliberately not the username: the nav shows the name a player is called,
// as the launcher does, so a fixture whose two names read the same would prove nothing.
const baseAccount={id:17,username:'fixture_player',displayName:'Captain Fixture',passwordRequired:false,microsoftLinked:false,providers:['steam'],roles:[],picture:null};
const product={key:'fixture-cosmetic',name:'Fixture cosmetic',amountMinor:500,currency:'USD',kind:'cosmetic',creditPence:0};
const signed=account=>({account,session:{token:'fixture-session-not-a-real-credential',expiresAt:new Date(Date.now()+3600000).toISOString()}});
let checks=0;
try{
 for(const width of [1440,834,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[];
  let account={...baseAccount},paid=false,providerSignup=false,finishCalls=0,checkoutCalls=0,loginHold=null,storeCalls=[];
  // The boot journeys below decide when /me answers and what it says. A hold is a promise the route
  // waits on, so a state that is only reachable while the read is in flight is measured on the route
  // rather than slept through after the load: the delay is where the player's 18-22 s Aurora resume
  // is, and a probe that raced it would prove nothing.
  let meHold=null,meStatus=200;
  page.on('pageerror',error=>errors.push(error.message));
  await context.route(api+'/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON?.();
   requests.push({path,method:request.method(),body,headers:request.headers()});
   let value,status=200;
   if(path.endsWith('/providers'))value={providers:['microsoft','steam','discord']};
   else if(path.endsWith('/providers/start')){assert.match(body.verifier,/^[-_A-Za-z0-9]{43}$/);value={flow:'f'.repeat(43),url:'https://steamcommunity.com/openid/login?fixture=1',expiresIn:600};}
   else if(path.endsWith('/providers/finish')){finishCalls++;account={...baseAccount,username:null,passwordRequired:true};value=signed(account);}
   else if(path.endsWith('/password/login')){if(body.password==='wrong'){status=401;value={error:'invalid_credentials'};}else{if(loginHold)await loginHold;value=signed(account);}}
   else if(path.endsWith('/username/available'))value={available:body.username!=='taken',reason:'taken'};
   else if(path.endsWith('/password')){account={...account,username:body.username||account.username,passwordRequired:false};value=signed(account);}
   else if(path.endsWith('/me')){if(meHold)await meHold;if(meStatus!==200){status=meStatus;value={error:'invalid_session'};}else value={account};}
   else if(path.endsWith('/emails'))value={emails:[],loginEmail:null};
   else if(path.endsWith('/profile')){account={...account,displayName:body.displayName};value={account};}
   // THE WEBSITE HAS NO STORE while the Easter Company app registration is reviewed (Owen,
   // 2026-10-27). These three routes still answer, because the cloud half does; what is asserted
   // below is that the website never asks them, so a request to one is recorded and fails the run.
   else if(path.endsWith('/store/catalogue')){storeCalls.push(path);value={products:[product]};}
   else if(path.endsWith('/store/orders')){storeCalls.push(path);value={orders:paid?[{sessionId:'fixture-order',product:product.key,amountMinor:500,currency:'USD',paid:true,delivered:false,creditPence:0,createdAt:'2026-10-26T12:00:00Z'}]:[]};}
   else if(path.endsWith('/checkout')){storeCalls.push(path);checkoutCalls++;assert.deepEqual(body,{product:product.key});value={url:'https://checkout.stripe.com/c/pay/fixture',sessionId:'fixture-order',product:product.key};}
   else if(path.endsWith('/logout'))value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  await context.route('https://steamcommunity.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Fixture provider complete</p>'}));
  await context.route('https://checkout.stripe.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture checkout</title><p>Fixture only</p>'}));
  // A picture reaches the control only as the data: URI the account document already carries:
  // publicAccount in site/account-client.mjs keeps a data:image/png;base64 picture and drops every
  // other form, so showing a face costs the page no request to any host. A picture that fails is
  // still reachable - it is a data URI this browser cannot decode - and that is state 6 below.
  const pictureURL=pictureDataURL(),damagedPictureURL='data:image/png;base64,AAAA';
  await page.goto(origin);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
  await page.locator('#desktop-company-signin input[name=identifier]').fill('fixture_player');
  await page.locator('#desktop-company-signin input[name=password]').fill('wrong');
  await page.locator('#desktop-company-signin button[type=submit]').click();
  await page.locator('#desktop-company-signin .company-error').waitFor({state:'visible'});
  assert.equal(await page.locator('#desktop-company-signin input[name=password]').inputValue(),'');
  await page.locator('#desktop-company-signin input[name=password]').fill('fixture-passphrase');
  await page.locator('#desktop-company-signin button[type=submit]').click();
  await page.getByRole('button',{name:'Account options'}).waitFor();
  // The control's own text now holds the avatar slot as well; the account's name is the span
  // inside it, and it is the DISPLAY NAME - not the username this assertion used to expect. Owen,
  // 2026-10-26: the launcher shows `OCEaster` where this site showed `oceaster`.
  assert.equal(await page.locator('.web-account-nav .web-account-name').textContent(),baseAccount.displayName);
  assert.notEqual(await page.locator('.web-account-nav .web-account-name').textContent(),baseAccount.username);
  assert.equal(await page.locator('.hero-copy h1').count(),1);
  assert.equal(await page.locator('[data-download-primary]').count(),1);
  assert.equal(await page.evaluate(()=>Boolean(window.easterDesktop)),false);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('desktop-mode')),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-session')),false);
  await page.getByRole('button',{name:'Account options'}).click();
  await page.getByRole('button',{name:'My Profile',exact:true}).click();
  await page.locator('#company-profile [data-name-form] input').fill('Updated fixture');
  await page.locator('#company-profile button[type=submit]').first().click();
  await page.locator('#company-profile .company-status').filter({hasText:'Saved.'}).waitFor();
  await page.getByRole('button',{name:'Close My Profile'}).click();
  // THE WEBSITE HAS NO STORE, signed in or not (Owen, 2026-10-27, while the app registration is
  // reviewed: "let's not remove, but disable the store on the website ... leave it inside the
  // launcher though"). What used to be here was the whole web shop - the Store link, its
  // catalogue, an Orders view, a Buy press that reached Stripe, and the #store-paid return. The
  // store itself is untouched and the launcher still sells; the website simply offers no way in.
  assert.equal(await page.getByRole('link',{name:'Store',exact:true}).count(),0,'the nav offers no Store entry on the website');
  assert.deepEqual(
    await page.evaluate(()=>[...document.querySelectorAll('a')].map(a=>a.href).filter(href=>href.includes('/store/'))),
    [],
    'and no link anywhere on the page reaches /store/');
  // The public store URL lands on the home page and asks the account service nothing about a store.
  await page.goto(origin+'/store/',{waitUntil:'networkidle'});
  assert.equal(new URL(page.url()).pathname,'/','/store/ on the website lands on the home page');
  assert.equal(await page.locator('.store-main,.store-product,.store-price,.store-order-record').count(),0,'and paints nothing of the store');
  // Stripe's return fragment is inert here now: it names a checkout the website cannot show, so it
  // stays where it is, records no order and claims no success.
  await page.goto(origin+'/#store-paid/forged');
  await page.waitForTimeout(150);
  assert.equal(new URL(page.url()).pathname,'/','the #store-paid fragment no longer routes into the store');
  assert.equal(await page.getByRole('heading',{name:'Payment Successful',exact:true}).count(),0);
  assert.equal(await page.locator('.store-order-record').count(),0);
  assert.deepEqual(storeCalls,[],'the website never called a store route: '+storeCalls.join(', '));
  assert.equal(checkoutCalls,0,'no checkout was started from the website');
  await page.getByRole('button',{name:'Account options'}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).waitFor();
  assert.equal(await page.locator('.store-order-record').count(),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
  await page.locator('#desktop-company-username[open]').waitFor();
  await page.locator('#desktop-company-username input').fill('new_fixture');
  await page.locator('#desktop-company-username button[type=submit]').click();
  await page.locator('#desktop-company-password[open]').waitFor();
  await page.locator('#desktop-company-password input[name=password]').fill('fixture-new-passphrase');
  await page.locator('#desktop-company-password input[name=confirm]').fill('fixture-new-passphrase');
  await page.locator('#desktop-company-password button[type=submit]').click();
  await page.locator('#desktop-company-password').waitFor({state:'hidden'});
  assert.equal(finishCalls,1);
  // A first-time provider signup says the name a player is called, never the handle just typed.
  assert.equal(await page.locator('.web-account-nav .web-account-name').textContent(),baseAccount.displayName);
  assert.notEqual(await page.locator('.web-account-nav .web-account-name').textContent(),'new_fixture');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/web-accounts-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
  assert(requests.every(r=>!new URL(api+r.path).search));
  console.log('PASS web login, profile, no store on the website and no store request made, inert #store-paid fragment, logout, provider signup, no overflow at '+width);
  checks++;

  // ---- The account control's face, in the states that matter -------------------------------
  // Owen, 2026-10-26, signed in on the live site: "there's no user image in the `oceaster` user
  // element". The face follows the account document and nothing else - the picture the account
  // already carries, else the head cropped from the skin it carries, else the tile - because the
  // launcher's other source, the Minecraft head by `minecraftUuid`, is not reachable from a page:
  // sessionserver.mojang.com answers with no Access-Control-Allow-Origin, so the page's own fetch
  // of it fails before any JSON exists. That is why the whole texture travels in the document and
  // this suite hands the control one. What is proved here is the precedence, the placeholder, and
  // that no state moves the control. The wipe in flight keeps username, password and roles and
  // drops every provider link, so the tile is the state a player meets first: it is measured like
  // a first-class state, not an error path.
  const facePage=await context.newPage();
  facePage.on('pageerror',error=>errors.push(error.message));
  // Nothing the face shows may cost a request to another host. Both images are data: URIs inside
  // the account document and the crop is local canvas work, so this listener must see the preview
  // origin and the API fixture and nothing else.
  const faceRequests=[];
  facePage.on('request',request=>faceRequests.push(request.url()));
  const snapshot=()=>facePage.evaluate(()=>{
   const nav=document.querySelector('.site-header nav'),button=document.querySelector('.web-account-nav');
   const rect=element=>element.getBoundingClientRect(),children=[...nav.children].map(rect);
   const face=document.querySelector('.web-account-face'),picture=document.querySelector('.web-account-picture');
   return {
    button:{width:+rect(button).width.toFixed(2),height:+rect(button).height.toFixed(2)},
    nav:{width:+rect(nav).width.toFixed(2),height:+rect(nav).height.toFixed(2)},
    // One row means no child's box reaches past the nav's own: the wrap test, which assumes
    // nothing about which child is tallest.
    oneRow:Math.max(...children.map(box=>box.bottom))-Math.min(...children.map(box=>box.top))<=rect(nav).height+1,
    face:{hidden:face.hidden,width:+rect(face).width.toFixed(2),height:+rect(face).height.toFixed(2)},
    // The launcher's geometry, measured rather than looked at: a 4px rounded square, never a disc.
    faceRadius:getComputedStyle(face).borderRadius,
    letter:document.querySelector('.web-account-initial').textContent,
    painted:face.classList.contains('has-picture'),
    mark:face.classList.contains('web-account-face-mark'),
    picture:{hidden:picture.hidden,natural:picture.naturalWidth,position:getComputedStyle(picture).position,src:picture.getAttribute('src'),rendering:getComputedStyle(picture).imageRendering},
    text:document.querySelector('.web-account-name').textContent,
    nameShown:document.querySelector('.web-account-name').getClientRects().length>0,
    nameTruncated:document.querySelector('.web-account-name').scrollWidth>document.querySelector('.web-account-name').clientWidth+1,
    label:button.getAttribute('aria-label'),disabled:button.disabled,
    overflow:document.documentElement.scrollWidth>innerWidth
   };
  });
  const signIn=async()=>{
   await facePage.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
   await facePage.locator('#desktop-company-signin input[name=identifier]').fill('oceaster');
   await facePage.locator('#desktop-company-signin input[name=password]').fill('fixture-passphrase');
   await facePage.locator('#desktop-company-signin button[type=submit]').click();
  };
  const signOut=async()=>{
   await facePage.getByRole('button',{name:'Account options'}).click();
   await facePage.locator('#web-account-menu button').filter({hasText:'Sign out'}).click();
   await facePage.getByRole('button',{name:'Sign in or create an Easter Company account'}).waitFor();
  };
  const box=state=>({width:state.button.width,height:state.button.height});
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:pictureURL};
  await facePage.goto(origin);
  // The earliest box the control ever has with a picture in it: the mutation that sets the
  // image's src is recorded with the button's box at that same tick, before the decoder has
  // painted anything. That makes "before the avatar paints" a measurement, not a race.
  await facePage.evaluate(()=>{
   window.__faceMarks=[];
   const button=document.querySelector('.web-account-nav');
   new MutationObserver(()=>{
    const picture=document.querySelector('.web-account-picture');
    if(!picture||!picture.getAttribute('src'))return;
    const box=button.getBoundingClientRect();
    window.__faceMarks.push({width:+box.width.toFixed(2),height:+box.height.toFixed(2),decoded:picture.complete});
   }).observe(button,{subtree:true,attributes:true,attributeFilter:['src']});
  });
  // 1. Signed out: no avatar at all, and the nav still says Sign in.
  const signedOut=await snapshot();
  assert.equal(signedOut.face.hidden,true,'signed out shows no avatar');
  assert.equal(await facePage.locator('.web-account-face').isVisible(),false);
  assert.equal(signedOut.text,'Sign in');
  assert.equal(signedOut.nameShown,true,'the signed-out control says Sign in at every width, never an empty pill');
  assert.equal(signedOut.label,'Sign in or create an Easter Company account');
  // 2. Signing in: the control is disabled and carries no avatar until there is an account to show.
  let openLogin=()=>{};
  loginHold=new Promise(resolve=>{openLogin=resolve;});
  await signIn();
  await facePage.waitForFunction(()=>document.querySelector('.web-account-nav').disabled);
  const signingIn=await snapshot();
  assert.equal(signingIn.disabled,true,'the control is disabled while a sign-in is in flight');
  assert.equal(signingIn.face.hidden,true,'no avatar before there is an account to show');
  assert.equal(signingIn.text,'Sign in');
  openLogin();loginHold=null;
  await facePage.getByRole('button',{name:'Account options'}).waitFor();
  await facePage.locator('.web-account-face.has-picture').waitFor();
  // 3. Signed in with a picture: the account's own picture is the avatar, and it is in the slot.
  const painted=await snapshot();
  assert.equal(painted.face.hidden,false,'a signed-in account always has the slot');
  // The width the report came from shows the whole name beside the face; below that the control
  // becomes the face alone rather than a word clipped to one letter.
  if(width>=390)assert.equal(painted.nameTruncated&&painted.nameShown,false,'the account name is not clipped at '+width);
  else assert.equal(painted.nameShown,false,'too little room for a face and a name, so the control is the face');
  assert.equal(painted.painted,true,'the account picture is what the control shows');
  assert.equal(painted.picture.natural,64,'and it is the picture itself, decoded');
  assert.equal(painted.text,'OCEaster','the label is the display name, not the username');
  assert.equal(painted.letter,'O','the letter comes from the name a player is called');
  assert.equal(painted.label,'Account options');
  assert.equal(await facePage.getByRole('button',{name:'Account options'}).count(),1,'the accessible name is still the account');
  assert.equal(painted.picture.position,'absolute','the image is out of the control layout, so a paint cannot move it');
  // 4. Measured at the tick the image arrived, before it was decoded, and again once it was: the
  // same control, the same box, the same row.
  const marks=await facePage.evaluate(()=>window.__faceMarks);
  assert(marks.length>=1,'the picture reached the control');
  const beforePaint=marks[0];
  assert.deepEqual({width:beforePaint.width,height:beforePaint.height},box(painted),'the control is the same size before the avatar paints as after');
  // The image fills the rounded square it is in (object-fit:cover inside overflow:hidden), so a
  // picture is cropped to the slot rather than inset in a disc: what Owen asked for when he said the
  // launcher's face was the better one.
  const filled=await facePage.evaluate(()=>{
   const face=document.querySelector('.web-account-face'),picture=document.querySelector('.web-account-picture');
   const outer=face.getBoundingClientRect(),inner=picture.getBoundingClientRect();
   return {overflow:getComputedStyle(face).overflow,width:+inner.width.toFixed(2),height:+inner.height.toFixed(2),slot:{width:+outer.width.toFixed(2),height:+outer.height.toFixed(2)}};
  });
  assert.equal(filled.overflow,'hidden','the rounded square crops the image');
  assert.deepEqual({width:filled.width,height:filled.height},filled.slot,'the face fills the slot edge to edge');
  // 5. Signed in with no picture at all: the tile is the avatar. This is the state the wipe leaves.
  await signOut();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:null};
  await signIn();
  await facePage.getByRole('button',{name:'Account options'}).waitFor();
  const noPicture=await snapshot();
  assert.equal(noPicture.painted,false);
  assert.equal(noPicture.picture.hidden,true,'with no picture nothing is asked for');
  assert.equal(noPicture.letter,'O','the placeholder is the initial tile, not a blank slot');
  assert.deepEqual(box(noPicture),box(painted),'no picture leaves the same box');
  // The tile is the launcher's own (site/desktop.js, "The player's face"): teal #536b66 with the
  // first letter in cream #eedbb2. Same face on both surfaces, and never a blank slot.
  const tile=await facePage.evaluate(()=>{
   const face=document.querySelector('.web-account-face'),style=getComputedStyle(face);
   return {background:style.backgroundColor,colour:style.color};
  });
  assert.deepEqual(tile,{background:'rgb(83, 107, 102)',colour:'rgb(238, 219, 178)'},'the placeholder is the teal letter tile');
  // 6. A picture that fails: the tile replaces it, no broken image, no size change, same name.
  await signOut();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:damagedPictureURL};
  await signIn();
  await facePage.getByRole('button',{name:'Account options'}).waitFor();
  await facePage.waitForFunction(()=>{
   const picture=document.querySelector('.web-account-picture');
   return Boolean(picture&&picture.getAttribute('src')&&picture.complete&&picture.hidden);
  }); // the src was set and the browser finished with it: a decode that failed, not a pending one
  const failed=await snapshot();
  assert.equal(failed.painted,false,'a failed picture never claims the slot');
  assert.equal(failed.picture.hidden,true,'no broken image is left in the control');
  assert.equal(failed.letter,'O','the tile takes the failed picture over');
  assert.deepEqual(box(failed),box(painted),'a failed picture leaves the same box');
  assert.equal(failed.label,'Account options');
  assert.equal(await facePage.getByRole('button',{name:'Account options'}).count(),1);
  // ---- The head the account document now carries -----------------------------------------
  // Owen, signed in on both surfaces: "I am logged in on both web and launcher, but web shows the
  // placeholder profile image while the launcher is showing my minecraft skin based one." The
  // whole skin texture travels in the account document - a page cannot ask sessionserver for it -
  // and the control crops the head from it in canvas, with the launcher's own arithmetic. The
  // fixture skin makes that arithmetic a measurement: the face at 8,8 is a two-colour checkerboard
  // and the hat at 40,8 is half-transparent blue over the right-hand two thirds of it, so at the
  // 4x the crop draws, one source pixel is one exact 4x4 block. Sampling the painted image back
  // through a canvas therefore proves the crop offset, the hat composited over the face, and that
  // no smoothing blurred either.
  const headPixels=()=>facePage.evaluate(async()=>{
   const picture=document.querySelector('.web-account-picture');
   const image=new Image();image.src=picture.src;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
   const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
   const at=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
   return {size:[image.naturalWidth,image.naturalHeight],faceA:at(2,2),faceB:at(6,2),hatOverA:at(17,2),hatOverB:at(13,2)};
  });
  // Canvas compositing rounds an 8-bit channel; the fixture's own arithmetic does not, so a
  // blended block is expected within one part in 128 rather than to the last bit. The hat is a
  // translucent overlay on an opaque face, so the three colours are what the fixture predicts and
  // the alpha stays fully opaque - no compositing artefact is being allowed for.
  const near=(actual,expected,what)=>{
   for(let channel=0;channel<3;channel++)assert(Math.abs(actual[channel]-expected[channel])<=3,what+': channel '+channel+' read '+actual[channel]+', expected '+expected[channel]);
   assert.equal(actual[3],255,what+': the composite stays opaque');
  };
  // 7. Signed in with a skin and no picture: the face is the CROPPED HEAD, not the texture and not
  // the tile, and the control is the same box it was with a picture in it.
  await signOut();
  const skinURL=skinDataURL();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:null,skin:skinURL};
  await signIn();
  await facePage.locator('.web-account-face.has-picture').waitFor();
  const skinOnly=await snapshot();
  assert.equal(skinOnly.painted,true,'the account skin gives the control a face');
  assert.equal(skinOnly.picture.natural,32,'and it is the 32px crop, not the whole texture');
  assert.notEqual(skinOnly.picture.src,skinURL,'the texture itself is not what the slot paints');
  assert.equal(skinOnly.picture.rendering,'pixelated','the head is drawn nearest-neighbour, as the launcher canvas is');
  assert.equal(skinOnly.letter,'O','the letter under the face is unchanged');
  assert.equal(skinOnly.label,'Account options');
  assert.deepEqual(box(skinOnly),box(painted),'the cropped head leaves the same box');
  const crop=await headPixels();
  assert.deepEqual(crop.size,[32,32],'the crop is a 32x32 canvas');
  assert.deepEqual(crop.faceA,[...FACE_A],'the 8x8 face at 8,8 is drawn, with no smoothing');
  assert.deepEqual(crop.faceB,[...FACE_B],'its neighbouring pixels stay exact 4x4 blocks');
  near(crop.hatOverA,hatted(FACE_A),'the hat at 40,8 is composited over the face');
  near(crop.hatOverB,hatted(FACE_B),'across the right-hand two thirds of it');
  // 8. Signed in with both: the uploaded picture wins, exactly as it does in the launcher.
  await signOut();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:pictureURL,skin:skinURL};
  await signIn();
  await facePage.locator('.web-account-face.has-picture').waitFor();
  const bothFaces=await snapshot();
  assert.equal(bothFaces.picture.natural,64,'the picture is what the control shows');
  assert.equal(bothFaces.picture.src,pictureURL,'and it is the picture itself, never the crop');
  assert.equal(bothFaces.picture.rendering,'auto','an uploaded picture keeps the ordinary smoothing');
  // The head stays nearest-neighbour at the launcher's size too (state 7), where 8x8 texture pixels
  // become 4x4 blocks of a 32px square rather than blocks of a 16px one.
  assert.equal(skinOnly.picture.rendering,'pixelated','the cropped head is still drawn nearest-neighbour at '+width);
  assert.equal(await facePage.locator('.web-account-picture.web-account-head').count(),0,'and claims no head rendering');
  assert.deepEqual(box(bothFaces),box(painted),'the picture over a skin leaves the same box');
  // 9. `skin: null` - no Minecraft identity to draw, which after the wipe is every account until it
  // links again: the tile, unchanged, in the launcher's own palette.
  await signOut();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:null,skin:null};
  await signIn();
  await facePage.getByRole('button',{name:'Account options'}).waitFor();
  const noSkin=await snapshot();
  assert.equal(noSkin.painted,false,'no skin means no face at all');
  assert.equal(noSkin.picture.hidden,true,'and nothing is asked for');
  assert.equal(noSkin.picture.natural,0,'the slot holds no image');
  assert.equal(noSkin.letter,'O','the placeholder is the initial tile');
  assert.deepEqual(box(noSkin),box(painted),'a null skin leaves the same box');
  const nullSkinTile=await facePage.evaluate(()=>{
   const style=getComputedStyle(document.querySelector('.web-account-face'));
   return {background:style.backgroundColor,colour:style.color};
  });
  assert.deepEqual(nullSkinTile,{background:'rgb(83, 107, 102)',colour:'rgb(238, 219, 178)'},'the same teal tile and cream letter the launcher draws');
  // 10. A skin that is not a decodable PNG: the crop cannot be made, so the tile stands and the
  // page raises nothing - the answer a picture that will not decode already gets. The settle wait
  // is bounded on purpose: a failed crop leaves no trace in the DOM by design (it never sets a
  // source), so the assertion is that the tile still holds once the decode has had its chance.
  await signOut();
  account={...baseAccount,username:'oceaster',displayName:'OCEaster',picture:null,skin:'data:image/png;base64,AAAA'};
  await signIn();
  await facePage.getByRole('button',{name:'Account options'}).waitFor();
  await facePage.waitForTimeout(300);
  const badSkin=await snapshot();
  assert.equal(badSkin.painted,false,'a skin the browser cannot decode never claims the slot');
  assert.equal(badSkin.picture.hidden,true,'no broken image is left in the control');
  assert.equal(badSkin.picture.natural,0,'and no crop was painted');
  assert.equal(badSkin.letter,'O','the tile is what the player sees instead');
  assert.deepEqual(box(badSkin),box(painted),'a failed crop leaves the same box');
  assert.equal(badSkin.label,'Account options');
  // 11. The label's precedence, asserted in the same place as the face: the display name, then the
  // Minecraft name, then the username - the account document's own order (publicAccount), which is
  // also the order the launcher's bar uses. Owen, 2026-10-26: "Launcher also shows `Display Name`
  // not username, which is correct."
  const called=async next=>{
   await signOut();
   account={...baseAccount,...next};
   await signIn();
   await facePage.getByRole('button',{name:'Account options'}).waitFor();
   return snapshot();
  };
  const bothNames=await called({username:'oceaster',displayName:'OCEaster',minecraftName:'CaptainFixture',picture:null});
  assert.equal(bothNames.text,'OCEaster','the display name wins over the Minecraft name and the username');
  const minecraftNameOnly=await called({username:'oceaster',displayName:null,minecraftName:'CaptainFixture',picture:null});
  assert.equal(minecraftNameOnly.text,'CaptainFixture','with no display name the Minecraft name is the label');
  assert.equal(minecraftNameOnly.letter,'C','and the letter comes from it');
  const usernameOnly=await called({username:'oceaster',displayName:null,minecraftName:null,picture:null});
  assert.equal(usernameOnly.text,'oceaster','with neither, the username is the last resort');
  assert.equal(usernameOnly.letter,'O','and the letter comes from it');
  // A long display name is the load the nav is measured under: one row, no sideways scroll, and the
  // name clipped inside the control rather than pushing the row apart.
  const longName=await called({username:'oceaster',displayName:'Captain Fixture of the Long Watch',picture:null});
  assert.equal(longName.text,'Captain Fixture of the Long Watch');
  assert.equal(longName.oneRow,true,'a long display name does not wrap the nav at '+width);
  assert.equal(longName.overflow,false,'a long display name does not scroll the page sideways at '+width);
  assert.equal(box(longName).height,box(painted).height,'a long display name keeps the control height');
  if(width>360){
   assert.equal(longName.nameShown,true,'the name is still shown beside the face at '+width);
   assert.equal(longName.nameTruncated,true,'the long name is clipped inside the control at '+width);
  }
  // 12. An account with no name of its own yet - the moment between a provider sign-in and a first
  // username - is the Easter Company mark, never an empty box. It is last because that state's
  // control opens the setup dialog rather than the menu, so it is not signed out again here.
  await signOut();
  account={...baseAccount,username:null,minecraftName:null,displayName:null,passwordRequired:true,picture:null};
  await signIn();
  await facePage.getByRole('button',{name:'Finish account setup'}).waitFor();
  const nameless=await snapshot();
  assert.equal(nameless.text,'Finish setup');
  assert.equal(nameless.letter,'','no letter is invented from a placeholder name');
  assert.equal(nameless.mark,true,'the mark stands in while there is no name to letter');
  // The label is longer than a username ("Finish setup"), so the control is wider here by design:
  // what the face may never change is the height, and the slot is the same rounded square.
  assert.equal(box(nameless).height,box(painted).height,'the face never changes the control height');
  const mark=await facePage.evaluate(()=>{
   const style=getComputedStyle(document.querySelector('.web-account-face'));
   return {image:style.backgroundImage,colour:style.backgroundColor};
  });
  assert.match(mark.image,/ec-logo\.svg/,'the mark is the Easter Company mark, not a blank slot');
  assert.equal(mark.colour,'rgb(83, 107, 102)','on the same teal tile');
  // The row stays one row, and 390 is the width the report came from.
  assert.equal(nameless.oneRow,true,'the nav does not wrap at '+width);
  assert.equal(failed.overflow,false,'the page does not scroll sideways at '+width);
  // The slot is one fixed rounded square in every state that has an account, at the size the
  // launcher draws it: 32x32 with a 4px radius, and 24x24 below the launcher's own 420px breakpoint
  // (site/desktop.css). Owen, 2026-10-26: "also on web, the profile image is a small circle not
  // fully shown like on the launcher, launcher style is better".
  const faceSize=width<=420?24:32;
  // The pill keeps the height it had with the 16px disc in it: 40px above the header's own narrow
  // rule and 44px under it. The face grew by 16px and the pill did not.
  const pillHeight=width<=600?44:40;
  for(const state of [painted,noPicture,failed,skinOnly,bothFaces,noSkin,badSkin,nameless]){
   assert.deepEqual(state.face,{hidden:false,width:faceSize,height:faceSize},'one fixed '+faceSize+'px slot at '+width);
   assert.equal(state.faceRadius,'4px','the slot is the launcher\'s rounded square, not a disc, at '+width);
   assert.equal(state.button.height,pillHeight,'the control is still '+pillHeight+'px tall with a '+faceSize+'px face at '+width);
  }
  // No third-party host is asked for a face, in any of the states above: the picture and the whole
  // skin are data: URIs inside the account document, and the crop is local canvas work.
  assert.deepEqual(faceRequests.filter(url=>!url.startsWith(origin)&&!url.startsWith(api)),[],'the avatar costs no request to a third party');
  await facePage.screenshot({path:'/tmp/web-account-avatar-'+width+'.png'});
  assert.deepEqual(errors,[]);
  const size=state=>state.button.width+'x'+state.button.height;
  console.log('PASS account avatar at '+width+': signed out (no face, '+size(signedOut)+'), '
   +'signing in ('+size(signingIn)+', disabled, no face), '
   +'picture (as the image arrived '+beforePaint.width+'x'+beforePaint.height+', once painted '+size(painted)+'), '
   +'no picture ('+size(noPicture)+'), failed load ('+size(failed)+'), '
   +'skin crop (32px head, '+size(skinOnly)+'), picture over skin ('+size(bothFaces)+'), '
   +'null skin ('+size(noSkin)+'), undecodable skin ('+size(badSkin)+'), no name ('+size(nameless)+', the mark); '
   +'labels '+bothNames.text+' / '+minecraftNameOnly.text+' / '+usernameOnly.text+' then "'+longName.text+'" clipped; '
   +'face '+faceSize+'x'+faceSize+' in a 4px square, pill '+pillHeight+'px, '
   +'one row, accessible name '+painted.label+', no third-party request');
  checks++;

  // ---- The cold load: what the control says before /me answers -------------------------------
  // THE DEFECT AS OWEN MET IT: "Even though I am signed in, I hit ctrl+shift+r and now it says
  // 'sign in'". The tab kept only {token,expiresAt}, so the first frame had nothing to paint and said
  // `Sign in` until /me answered - an 18-22 s Aurora resume on a cold start. Reproduced at 1440
  // against the base commit with /me held: t+1.2s label "Sign in or create an Easter Company
  // account", the dialog offering `Sign in with Microsoft`, and pressing it refusing with "Sign out
  // before using another account." while that refusal's own repaint turned the control into the
  // account - which is why it `fixed itself`. The tab now keeps the whole companySession document
  // ({token,expiresAt,account}), the shape the launcher's vault keeps, so the control is the account
  // on its very first frame and /me only reconciles it. The one load that cannot paint - a token with
  // no document, which is what every tab already open when this ships has - is inert instead of
  // offering a sign-in it would refuse.
  const SESSION_KEY='easter-company-web-session-v1';
  const TOKEN='fixture-session-not-a-real-credential';
  // The document must be one sanitizeAccount accepts, or the cache is no cache at all and the control
  // falls back to the very state this journey is about: `microsoftLinked:true` needs a 64-hex
  // microsoftSubject (site/account-client.mjs, sanitizeAccount).
  const cachedAccount={...baseAccount,username:'oceaster',displayName:'Captain Fixture',microsoftLinked:true,microsoftSubject:'a'.repeat(64),providers:['microsoft'],primaryProvider:'microsoft',picture:pictureURL};
  const reconciledAccount={...cachedAccount,displayName:'Reconciled Fixture'};
  const bootPage=await context.newPage();
  bootPage.on('pageerror',error=>errors.push(error.message));
  // Every animation frame's view of the control, from the first frame that has one: "before /me
  // answers" is measured, not assumed, and a state that only exists while the read is in flight is
  // reached by holding the read on the route rather than by sleeping after the load.
  await bootPage.addInitScript(()=>{
   window.__bootFrames=[];
   const look=()=>{
    const button=document.querySelector('.web-account-nav');
    if(button)window.__bootFrames.push({t:Math.round(performance.now()),text:document.querySelector('.web-account-name').textContent,
     label:button.getAttribute('aria-label'),disabled:button.disabled,busy:button.getAttribute('aria-busy'),
     face:!document.querySelector('.web-account-face').hidden,mark:document.querySelector('.web-account-face').classList.contains('web-account-face-mark')});
    if(window.__bootFrames.length<2400)requestAnimationFrame(look);
   };
   requestAnimationFrame(look);
  });
  const control=()=>bootPage.evaluate(()=>{
   const button=document.querySelector('.web-account-nav'),face=document.querySelector('.web-account-face');
   return {text:document.querySelector('.web-account-name').textContent,label:button.getAttribute('aria-label'),
    disabled:button.disabled,busy:button.getAttribute('aria-busy'),faceHidden:face.hidden,
    mark:face.classList.contains('web-account-face-mark'),painted:face.classList.contains('has-picture'),
    pillHeight:+button.getBoundingClientRect().height.toFixed(2)};
  });
  const openOnClick=()=>bootPage.evaluate(()=>({menu:Boolean(document.querySelector('#web-account-menu:popover-open')),dialog:Boolean(document.querySelector('#desktop-company-signin[open]'))}));
  const meRequests=()=>requests.filter(request=>request.path.endsWith('/me')).length;
  // Seed through the tab's own storage before the cold load, and never carry a previous journey's
  // held read into this one.
  const seedSession=async value=>{
   meHold=null;meStatus=200;
   await bootPage.goto(origin);
   await bootPage.evaluate(([key,stored])=>sessionStorage.setItem(key,JSON.stringify(stored)),[SESSION_KEY,value]);
  };
  const coldLoad=async()=>{
   await bootPage.reload({waitUntil:'commit'});
   await bootPage.waitForSelector('.web-account-nav',{state:'attached'});
   await bootPage.waitForFunction(()=>window.__bootFrames.length>2);
  };

  // (a) A saved session WITH the cached document, and /me held: the control is the account on the
  // first frame, offers no sign-in, and reconciles when the read answers.
  account=reconciledAccount;
  await seedSession({token:TOKEN,expiresAt:Date.now()+3600000,account:cachedAccount});
  let releaseMe=()=>{};
  meHold=new Promise(resolve=>{releaseMe=resolve;});
  const readsBefore=meRequests();
  await coldLoad();
  const bootFrames=await bootPage.evaluate(()=>window.__bootFrames.slice(0,3));
  const cachedBoot=await control();
  assert.equal(meRequests(),readsBefore+1,'the boot read is in flight, not answered');
  assert.equal(bootFrames[0].text,cachedAccount.displayName,'the first frame already says the name, never Sign in (at '+width+')');
  assert.equal(bootFrames[0].label,'Account options','and it is already the account, on that same frame');
  assert.equal(bootFrames[0].disabled,false,'a cached account is interactive from the first frame');
  assert.equal(bootFrames[0].face,true,'the face slot is there on that first frame');
  assert.equal(cachedBoot.text,cachedAccount.displayName);
  assert.equal(cachedBoot.painted,true,'the cached document paints the face without asking anyone');
  assert.equal(cachedBoot.mark,false);
  assert.equal(cachedBoot.busy,'false');
  assert.equal(cachedBoot.pillHeight,width<=600?44:40,'the face does not grow the pill at '+width);
  assert.equal(await bootPage.getByRole('button',{name:'Sign in or create an Easter Company account'}).count(),0,'no sign-in is offered while the account is being read');
  await bootPage.locator('.web-account-nav').click();
  assert.deepEqual(await openOnClick(),{menu:true,dialog:false},'that click reaches the account menu, the click Owen made reaches no refused sign-in');
  await bootPage.keyboard.press('Escape');
  releaseMe();meHold=null;
  await bootPage.waitForFunction(name=>document.querySelector('.web-account-name').textContent===name,reconciledAccount.displayName);
  const afterRead=await control();
  assert.equal(afterRead.text,reconciledAccount.displayName,'and /me reconciles the name when it answers');
  assert.equal(afterRead.disabled,false);
  const kept=await bootPage.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),SESSION_KEY);
  assert.deepEqual(Object.keys(kept).sort(),['account','expiresAt','token'],'the tab keeps the whole companySession document, as the launcher vault does');
  assert.equal(kept.account.displayName,reconciledAccount.displayName,'and what the read reconciled is what is kept');
  assert(!JSON.stringify(kept).includes('MicrosoftAccessToken'),'still no Microsoft token of any kind');
  // (b) A saved session with NO cached document - the one load after this change ships: the control
  // is non-interactive until /me settles, and it never offers the sign-in a click would refuse.
  account=cachedAccount;
  await seedSession({token:TOKEN,expiresAt:Date.now()+3600000});
  let releaseWaiting=()=>{};
  meHold=new Promise(resolve=>{releaseWaiting=resolve;});
  await coldLoad();
  const waiting=await control();
  const waitingFrame=(await bootPage.evaluate(()=>window.__bootFrames))[0];
  assert.equal(waitingFrame.text,'','the first frame invents no name and offers no Sign in');
  assert.equal(waitingFrame.disabled,true,'the control is non-interactive until the read settles');
  assert.equal(waiting.text,'','nothing is claimed about an account this load has not read');
  assert.equal(waiting.label,'Account options');
  assert.equal(waiting.busy,'true','and it says it is still reading');
  assert.equal(waiting.disabled,true);
  assert.equal(waiting.faceHidden,false,'the slot stands in for the account it cannot name yet');
  assert.equal(waiting.mark,true,'it is the Easter Company mark');
  assert.equal(waiting.pillHeight,width<=600?44:40);
  assert.equal(await bootPage.getByRole('button',{name:'Sign in or create an Easter Company account'}).count(),0,'a sign-in that a click would refuse is never offered');
  assert.equal(await bootPage.locator('.web-account-nav').isDisabled(),true);
  await bootPage.evaluate(()=>document.querySelector('.web-account-nav').click());
  assert.deepEqual(await openOnClick(),{menu:false,dialog:false},'so a click there opens nothing at all');
  releaseWaiting();meHold=null;
  await bootPage.waitForFunction(name=>document.querySelector('.web-account-name').textContent===name,cachedAccount.displayName);
  const settledBoot=await control();
  assert.equal(settledBoot.text,cachedAccount.displayName,'and the account appears when the read answers');
  assert.equal(settledBoot.disabled,false);
  assert.equal(settledBoot.busy,'false');
  assert.equal(settledBoot.painted,true);
  // (c) A 401 from /me signs out: the cached document goes with the token, and the control returns to
  // the sign-in that is now honest to offer.
  account=cachedAccount;
  await seedSession({token:TOKEN,expiresAt:Date.now()+3600000,account:cachedAccount});
  // After the seed, because seeding clears a previous journey's refusal to answer.
  meStatus=401;
  await coldLoad();
  await bootPage.getByRole('button',{name:'Sign in or create an Easter Company account'}).waitFor();
  const signedOutAgain=await control();
  assert.equal(signedOutAgain.text,'Sign in');
  assert.equal(signedOutAgain.faceHidden,true,'the face goes with the session');
  assert.equal(signedOutAgain.disabled,false);
  assert.equal(await bootPage.evaluate(key=>sessionStorage.getItem(key),SESSION_KEY),null,'a 401 drops the cached document with the token');
  meStatus=200;
  await bootPage.screenshot({path:'/tmp/web-account-boot-'+width+'.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS cold load at '+width+': cached document first frame "'+bootFrames[0].text+'" (face, no sign-in offered, menu on click) '
   +'then reconciles to "'+afterRead.text+'"; no document first frame "" (disabled, aria-busy, the mark) then "'+settledBoot.text+'"; '
   +'401 -> "'+signedOutAgain.text+'" with the document dropped; pill '+cachedBoot.pillHeight+'px');
  checks++;
  await context.close();
 }
}finally{await browser.close();}
console.log(checks+' responsive journeys passed; all credentials and purchases were fixtures.');
