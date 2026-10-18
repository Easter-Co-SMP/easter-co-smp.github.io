import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'launcher-ui-'));
const images=process.env.EASTER_REVIEW_IMAGES||'/tmp/launcher-ui-after';
await fs.mkdir(images,{recursive:true});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),
 args:['--no-sandbox',path.resolve('tests/desktop/deslop-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_TEST_TRAY:'0'}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');await page.keyboard.press('Escape');
 const shot=async(name)=>page.screenshot({path:path.join(images,name+'.png'),animations:'disabled'});
 for(const [width,height] of [[1360,920],[800,600]]){
  await page.setViewportSize({width,height});await shot('first-run-'+width);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Home fits window');
 }
 await page.setViewportSize({width:1360,height:920});
 const initial=await page.evaluate(()=>window.easterDesktop.status());
 const send=state=>app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('launcher:state',state),state);
 await send({...initial,phase:'downloading',actions:['pause','signin'],bar:{visible:true},progress:{label:'Downloading client files',percent:47,bytesDone:470000000,bytesTotal:1000000000,bytesPerSecond:12000000,etaSeconds:44}});
 await shot('downloading');
 await send({...initial,phase:'error',message:'The download was interrupted. Check your connection and try again.',actions:['download']});
 await shot('error');
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),true,'operation errors are visible on Home');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'errors do not open unrelated settings');
 await send(initial);
 await page.locator('[data-desktop-play][data-action=download]').click();
 await page.locator('[data-desktop-play][data-action=signin]').waitFor();
 await app.evaluate(()=>global.easterTestDelayDevice=true);
 await page.locator('[data-desktop-play][data-action=signin]').click();
 // One action, one verb: the chooser offers the same "Sign in with Microsoft" the hero does, at
 // every width the review uses, in a dialog that fits each of them.
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  await page.locator('#desktop-company-signin').waitFor({state:'visible'});
  const chooserBox=await page.locator('#desktop-company-signin').boundingBox();
  assert(chooserBox.x>=0&&chooserBox.x+chooserBox.width<=width+1,'the chooser fits '+width+'px');
  assert(chooserBox.y>=0&&chooserBox.y+chooserBox.height<=height+1,'the chooser fits the window at '+width+'px');
  assert.equal(await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in with Microsoft',exact:true}).count(),1,'the chooser names the action "Sign in with Microsoft" at '+width+'px');
  assert.equal(await page.locator('#desktop-company-signin').getByRole('button',{name:/Link Microsoft|Login with Microsoft/}).count(),0,'and no other verb is left at '+width+'px');
  await shot('chooser-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-auth-wait').waitFor();await shot('sign-in-pending');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'pending authentication never flashes settings');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'pending authentication cancels cleanly');
 await page.locator('[data-desktop-play][data-action=signin]').click();await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-auth-wait').waitFor();
 await app.evaluate(()=>{global.easterTestDeviceReady();global.easterTestDelayDevice=false;});
 await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();await shot('sign-in');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'sign-in never displays settings');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'cancellation is not an error');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'cancellation does not reveal settings');
 await page.locator('[data-desktop-play][data-action=signin]').click();await page.locator('#desktop-company-signin').getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST'}).waitFor();
 await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 assert.equal(await page.locator('#launcher-bar').isVisible(),false,'one Play entry point on Home');
 for(const [width,height] of [[1360,920],[800,600]]){
  await page.setViewportSize({width,height});await shot('ready-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await app.evaluate(()=>global.easterTestFailPlay=true);
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('.desktop-page-notice').waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'Unable to start Minecraft. Try again.','main publishes a safe typed failure');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'a failed launch does not open settings');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'failure notice can be dismissed');
 await app.evaluate(()=>global.easterTestFailPlay=false);
 // One failure, one visible home — in the real app. A failed Play is announced twice by main (one
 // settled broadcast carrying `error`, and the rejected call), so this is the exact shape Owen
 // reported: one sentence that used to be painted on the page notice and inside Settings, and
 // that came back whenever a dialog opened or closed.
 // Every surface that carries a failure or a notice in this app, so "none visible" means none
 // anywhere in the document rather than none in the three places the last check looked.
 const errorSurfaces=['desktop-page-notice','desktop-auth-error','desktop-auth-notice','desktop-status','desktop-graphics-error','desktop-install-error','company-error'];
 const visibleErrorNodes=()=>page.evaluate(surfaces=>[...document.querySelectorAll(surfaces.map(name=>'.'+name).join(','))]
  .filter(node=>!node.hidden&&node.getClientRects().length>0&&node.textContent.trim())
  .map(node=>surfaces.find(name=>node.classList.contains(name))),errorSurfaces);
 // The notice is a fixed band. It must not be laid out over the hero card's crest and heading,
 // which is what it did at 390 wide before the page reserved the room it needs.
 const noticeGeometry=()=>page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom)};};
  const notice=document.querySelector('.desktop-page-notice');
  return {notice:box(notice),laidOut:Boolean(notice.getClientRects().length),crest:box(document.querySelector('.crest-frame')),heading:box(document.querySelector('.desktop-home-heading')),viewport:innerWidth};
 });
 // The reserved room is layout, so it is re-measured on the frame after the window changes.
 const settledNotice=async()=>{
  await page.waitForFunction(()=>{const notice=document.querySelector('.desktop-page-notice'),crest=document.querySelector('.crest-frame');
   return !notice||!crest||notice.getBoundingClientRect().bottom<=crest.getBoundingClientRect().top+1;},{timeout:4000}).catch(()=>{});
  return noticeGeometry();
 };
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 await app.evaluate(()=>global.easterTestFailPlay=true);
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('.desktop-page-notice').filter({hasText:'Unable to start Minecraft. Try again.'}).waitFor();
 assert.deepEqual(await visibleErrorNodes(),['desktop-page-notice'],'one failure is one visible surface');
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const notice=await page.locator('.desktop-page-notice').boundingBox();
  assert(notice.x>=0&&notice.x+notice.width<=width+1,'the failure notice fits '+width+'px');
  const geometry=await settledNotice();
  assert.equal(geometry.laidOut,true,'the failure notice is laid out at '+width+'px');
  assert(geometry.notice.bottom<=geometry.crest.top+1,'the failure notice reads above the hero crest at '+width+'px: '+JSON.stringify(geometry));
  assert(geometry.notice.bottom<=geometry.heading.top+1,'the failure notice reads above the hero heading at '+width+'px: '+JSON.stringify(geometry));
  await shot('one-failure-notice-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 // Settings opens over it. A modal <dialog> paints in the document's top layer and makes the
 // rest of the page inert, so a page notice under it is a message the player can neither read
 // (dimmed at 1440 and 800, covered outright at 390) nor dismiss: the notice is taken away
 // entirely while any modal dialog is open, and the last one to close gives it back once.
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.locator('#desktop-launcher').waitFor({state:'visible'});
 assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.open),true,'Settings is the open modal dialog');
 assert.deepEqual(await visibleErrorNodes(),[],'the settings dialog is never an error surface, and no page notice is painted behind it');
 assert.equal(await page.evaluate(()=>document.querySelectorAll('#desktop-launcher .desktop-status').length),0,'the settings dialog carries no error area at all');
 assert.equal(await page.locator('#desktop-launcher').evaluate(el=>el.innerText.includes('Unable to start Minecraft')),false,'no failure text is copied into settings');
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  assert.deepEqual(await visibleErrorNodes(),[],'no visible failure surface anywhere in the document at '+width+'px with Settings open');
  const geometry=await noticeGeometry();
  assert.equal(geometry.laidOut,false,'the page notice is not laid out behind the settings dialog at '+width+'px');
  assert.equal(await page.getByRole('button',{name:'Dismiss message'}).count(),0,'and its dismiss control is not left behind the modal at '+width+'px');
  await shot('one-failure-settings-open-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await page.keyboard.press('Escape');
 await page.locator('#desktop-launcher').waitFor({state:'hidden'});
 // The last modal closed: the same sentence comes back, once, with a dismiss control the
 // keyboard can reach now that the page is no longer inert.
 await page.locator('.desktop-page-notice').filter({hasText:'Unable to start Minecraft. Try again.'}).waitFor();
 assert.deepEqual(await visibleErrorNodes(),['desktop-page-notice'],'closing the last modal gives the failure back, once');
 assert.equal(await page.getByRole('button',{name:'Dismiss message'}).count(),1,'with exactly one dismiss control');
 assert.equal(await page.getByRole('button',{name:'Dismiss message'}).evaluate(button=>{button.focus();return document.activeElement===button;}),true,'and it is keyboard reachable');
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const geometry=await settledNotice();
  assert.equal(geometry.laidOut,true,'the returned notice is laid out at '+width+'px');
  assert(geometry.notice.bottom<=geometry.crest.top+1,'and still reads above the hero crest at '+width+'px: '+JSON.stringify(geometry));
  await shot('one-failure-returned-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 // Main keeps `error` set until the next ordinary message, so later broadcasts repeat the same
 // sentence; a delivered failure is not delivered again, and a dismissed one stays dismissed.
 const repeated={...await status(),error:'Unable to start Minecraft. Try again.'};
 await send(repeated);
 assert.deepEqual(await visibleErrorNodes(),['desktop-page-notice'],'a repeated broadcast does not deliver the failure twice');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 assert.deepEqual(await visibleErrorNodes(),[],'the notice dismisses');
 await send(repeated);
 assert.deepEqual(await visibleErrorNodes(),[],'a dismissed failure is not resurrected by the same broadcast');
 // A sign-in that is still running is never presented as failed: the code and the browser action
 // are what the player is waiting for, so a stale sentence is not painted over them.
 await send({...await status(),device:{code:'TEST-LIVE',url:'https://microsoft.com/link',expiresAt:Date.now()+300000},error:'Minecraft sign-in failed: the Xbox Live session was not accepted. Sign in again.'});
 await page.locator('.desktop-code').filter({hasText:'TEST-LIVE'}).waitFor();
 assert.equal(await page.locator('.desktop-code').filter({hasText:'TEST-LIVE'}).isVisible(),true,'the device code stays readable');
 assert.equal(await page.getByRole('button',{name:'Open the Microsoft page',exact:true}).isVisible(),true,'the sign-in page action stays readable');
 assert.deepEqual(await visibleErrorNodes(),[],'a live sign-in is never painted as failed');
 await shot('sign-in-live-no-stale-failure');
 await send({...await status(),device:null,error:null});
 await page.waitForFunction(()=>!document.querySelector('#desktop-signin').open);
 await app.evaluate(()=>global.easterTestFailPlay=false);
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false});});
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await app.evaluate(()=>global.easterTestGame.emit('error',new Error('fixture child failure')));
 await page.locator('.desktop-page-notice').filter({hasText:'Minecraft could not start'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'Minecraft could not start. Check Java and try again.','asynchronous game failure remains visible');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 const ready={...await page.evaluate(()=>window.easterDesktop.status()),error:null};
 await send({...ready,phase:'running'});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await shot('settings');
 await page.setViewportSize({width:800,height:600});await shot('settings-800');
 assert(await page.locator('#desktop-launcher').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'default settings fit compact window');
 await page.setViewportSize({width:1360,height:920});
 assert.equal(await page.locator('.desktop-settings').evaluate(el=>el.inert),false,'settings stay usable while playing');
 for(const input of await page.locator('.desktop-preference input').all()){
  assert(await input.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.previousElementSibling.getBoundingClientRect();return a.x>b.right&&Math.abs(a.y+a.height/2-b.y-b.height/2)<3;}),'switch aligns beside its label');
 }
 await page.locator('select[name=serverSelect]').selectOption('__custom__');
 await page.locator('input[name=server]').fill('keyboard.example:25565');
 await page.locator('input[name=server]').press('Enter');
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).settings.server,'keyboard.example:25565','Enter saves settings');
 // Owen's two linked launch behaviours: both off by default, and never both on.
 const exitToggle=page.locator('input[name=exitOnLaunch]');
 const trayToggle=page.locator('input[name=trayOnLaunch]');
 assert.equal(await exitToggle.isChecked(),false,'a fresh launcher does not close behind the game');
 assert.equal(await trayToggle.isChecked(),false,'and does not minimise to the tray either');
 await trayToggle.check();
 assert.equal(await exitToggle.isChecked(),false,'ticking the tray leaves close off');
 await exitToggle.check();
 assert.equal(await trayToggle.isChecked(),false,'ticking close unticks the tray');
 await trayToggle.check();
 assert.equal(await exitToggle.isChecked(),false,'ticking the tray unticks close again');
 await page.locator('[data-save-settings]').click();
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 const traySaved=(await page.evaluate(()=>window.easterDesktop.status())).settings;
 assert.equal(traySaved.trayOnLaunch,true,'the tray choice round-trips through the main process');
 assert.equal(traySaved.exitOnLaunch,false,'with the other one off');
 assert.equal(JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8')).trayOnLaunch,true,'and is written to the settings file');
 // The dialog fills itself from the status broadcast, so reopening shows the saved pair.
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 assert.equal(await trayToggle.isChecked(),true,'the saved tray choice is read back into the dialog');
 assert.equal(await exitToggle.isChecked(),false);
 await exitToggle.check();
 await page.locator('[data-save-settings]').click();
 await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
 const closeSaved=(await page.evaluate(()=>window.easterDesktop.status())).settings;
 assert.equal(closeSaved.exitOnLaunch,true,'the close choice round-trips too');
 assert.equal(closeSaved.trayOnLaunch,false,'and clears the tray choice in the main process');
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:false});});
 await page.locator('.desktop-advanced summary').click();await shot('settings-advanced');
 await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();await shot('profile');
 for(const action of await page.locator('[data-profile-action]:visible').all())assert(await action.isDisabled(),'account changes disabled while game runs');
 // The verified emails are the profile's own section: the line beneath the account states
 // which address signs it in, and the section behind the button lists what the account
 // service reports. Both are refused while the game runs, like every other account change.
 const emailButton=page.getByRole('button',{name:'Verified emails',exact:true});
 assert.equal(await emailButton.count(),1,'the profile offers the verified emails section');
 assert.equal(await emailButton.isDisabled(),true,'and cannot change the login email while the game runs');
 await page.locator('.desktop-profile-heading.desktop-email').filter({hasText:'Login email: captain@example.test'}).waitFor();
 await shot('profile-with-email');
 await page.keyboard.press('Escape');await send(ready);
 await page.locator('.desktop-account-nav').click();
 await emailButton.click();
 const emailsPanel=page.locator('#desktop-company-emails');
 await emailsPanel.locator('input[name=email]').first().waitFor();
 assert.equal(await emailsPanel.locator('input[name=email]').count(),2,'both verified addresses are listed');
 assert.equal(await emailsPanel.locator('input[name=email]').first().isChecked(),true,'the login address is the marked one');
 await shot('profile-emails');
 for(const [width,height] of [[1360,920],[800,600],[390,568]]){
  await page.setViewportSize({width,height});await shot('profile-emails-'+width);
  assert.equal(await emailsPanel.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'the email section has no horizontal overflow at '+width+'px');
  const box=await emailsPanel.boundingBox();
  assert(box.x>=0&&box.x+box.width<=width+1,'the email section fits '+width+'px');
  assert(box.y>=0&&box.y+box.height<=height+1,'the email section fits vertically at '+width+'px');
 }
 await page.setViewportSize({width:1360,height:920});
 await page.keyboard.press('Escape');await emailsPanel.waitFor({state:'hidden'});
 await page.getByRole('link',{name:'Wiki',exact:true}).click();await page.locator('.wiki-card').first().waitFor();await shot('wiki');
 assert.equal(await page.locator('#launcher-bar').isVisible(),true,'idle action stays available on Wiki');
 await send({...ready,error:'Unable to start Minecraft. Try again.'});
 assert.equal(await page.locator('.desktop-page-notice').isVisible(),true,'utility pages show failures');
 assert.equal(await page.locator('#desktop-launcher').isVisible(),false,'utility failures do not open settings');
 // A guide page has no hero card for Home's reservation to sit on, so until this pass the fixed
 // notice band covered the guide's eyebrow line at 1440 and the sidebar's brand and search box at
 // 800 and 390 — interactive controls, under a band whose Dismiss control was the only thing
 // reachable there. What must hold at every width is that the band reaches nothing: the guide's
 // first line reads below it, and no control — the brand, the search input, the topic links, the
 // header's own nav — is under it, asked both by box intersection and by elementFromPoint at the
 // point the band would have covered.
 const guideNotice=()=>page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)};};
  const notice=document.querySelector('.desktop-page-notice'),band=box(notice),controls=[];
  const add=(name,node)=>{if(node&&node.getClientRects().length)controls.push({name,box:box(node)});};
  add('brand',document.querySelector('.wiki-brand'));
  add('search',document.querySelector('.wiki-search input'));
  add('topics toggle',document.querySelector('.wiki-topics-toggle'));
  for(const link of document.querySelectorAll('#wiki-topics a'))add('topic link',link);
  for(const link of document.querySelectorAll('.site-header nav a, .site-header nav button'))add('nav',link);
  const under=controls.filter(control=>control.box.right>band.left&&control.box.left<band.right&&control.box.bottom>band.top&&control.box.top<band.bottom).map(control=>control.name);
  const reached=[];
  for(const control of controls){
   const x=Math.round((Math.max(control.box.left,band.left)+Math.min(control.box.right,band.right))/2);
   const y=Math.round((Math.max(control.box.top,band.top)+Math.min(control.box.bottom,band.bottom))/2);
   if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
   const hit=document.elementFromPoint(x,y);
   if(hit&&hit.closest('.desktop-page-notice'))reached.push(control.name);
  }
  const first=document.querySelector('.wiki-page-header');
  return {band,under,reached,first:first?box(first):null,content:box(document.querySelector('.wiki-content')),reserved:getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-space').trim(),overflow:document.documentElement.scrollWidth<=innerWidth+1};
 });
 const checkGuideNotice=async(where)=>{
  for(const [width,height] of [[1440,900],[800,600],[390,568]]){
   await page.setViewportSize({width,height});
   // The reserved room is layout, so it is re-measured on the frame after the window changes, and
   // the band itself re-wraps when the window narrows: wait for the reservation to settle before
   // reading it, exactly as the Home notice helper above does.
   await page.waitForFunction(()=>{
    const notice=document.querySelector('.desktop-page-notice'),brand=document.querySelector('.wiki-brand');
    return !notice||!brand||notice.getBoundingClientRect().bottom<=brand.getBoundingClientRect().top+1;
   },{timeout:4000}).catch(()=>{});
   const geometry=await guideNotice();
   assert.deepEqual(geometry.under,[],'the notice reaches no control on '+where+' at '+width+'px: '+JSON.stringify(geometry));
   assert.deepEqual(geometry.reached,[],'and elementFromPoint agrees on '+where+' at '+width+'px: '+JSON.stringify(geometry));
   assert(geometry.first&&geometry.first.top>=geometry.band.bottom+1,'the first line of '+where+' reads below the notice at '+width+'px: '+JSON.stringify(geometry));
   assert(geometry.overflow,'and the reserved room adds no horizontal overflow at '+width+'px');
   await shot('notice-wiki-'+where+'-'+width);
  }
  await page.setViewportSize({width:1360,height:920});
 };
 await checkGuideNotice('overview');
 // The same checks on an actual guide, which is the page the reviewer measured: the eyebrow
 // line the band used to sit on is the article's own header here.
 await page.locator('.wiki-card').first().click();
 await page.locator('.wiki-article-section').first().waitFor();
 await checkGuideNotice('guide');
 assert((await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-space').trim()))!=='0px','the guide page reserves the room the notice asks for');
 // An install/update failure, in the sentences that no longer print a status. The update gate's
 // own sentence, and a download failure on Home, at the same three widths: each says what stopped
 // and what to do, and neither carries an HTTP status or a provider code.
 const installFailure='The download stopped before it finished. Your installed files are unchanged.';
 const updateFailure='Launcher update required. The launcher update could not be checked. Check your connection and try again.';
 const noStatus=text=>assert(!/HTTP\s*\d|\b[45]\d\d\b|XErr/.test(text),'the sentence the player reads carries no status: '+text);
 await send({...ready,launcherUpdate:{phase:'blocked',percent:null,message:updateFailure}});
 await page.locator('#desktop-update').waitFor({state:'visible'});
 noStatus(await page.locator('#desktop-update [data-update-detail]').innerText());
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const gate=await page.locator('#desktop-update').boundingBox();
  assert(gate.x>=0&&gate.x+gate.width<=width+1&&gate.y>=0&&gate.y+gate.height<=height+1,'the update failure fits '+width+'px');
  await shot('update-failure-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await send({...ready,launcherUpdate:{phase:'current'},error:installFailure});
 await page.locator('.desktop-page-notice').filter({hasText:installFailure}).waitFor();
 noStatus(await page.locator('.desktop-page-notice').evaluate(el=>el.firstChild.textContent));
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const notice=await page.locator('.desktop-page-notice').boundingBox();
  assert(notice.x>=0&&notice.x+notice.width<=width+1,'the install failure notice fits '+width+'px');
  assert.equal(await page.locator('.desktop-page-notice').isVisible(),true,'the install failure is visible at '+width+'px');
  await shot('install-failure-'+width);
 }
 await page.setViewportSize({width:1360,height:920});
 await page.getByRole('button',{name:'Dismiss message'}).click();
 // The map is the other page the band crosses, and the same defect followed it: the key, the
 // drawing palette and the zoom controls are docked on top of a full-bleed chart, so the notice sat
 // on the key at 800 and on the key, the palette and both zoom buttons at 390 — and at 390 the key
 // could not even be clicked open, because the band took the pointer. The room is now measured from
 // the topmost dock the band reaches and published to site/desktop.css, which moves that strip, so
 // what is proven here is the same property as the guide: no control under the band, by box and by
 // elementFromPoint, and the key still opens with a real click.
 const mapFailure='The chart data could not be cached. Try again.';
 const mapNotice=()=>page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)};};
  const notice=document.querySelector('.desktop-page-notice'),band=box(notice),controls=[];
  const add=(name,node)=>{if(node&&node.getClientRects().length)controls.push({name,box:box(node)});};
  add('map key',document.querySelector('.map-key summary'));
  for(const label of document.querySelectorAll('.map-key .legend label'))add('legend',label);
  add('draw palette',document.querySelector('.map-drawing summary'));
  for(const id of ['zoom-in','zoom-out','home','fullscreen'])add(id,document.getElementById(id));
  add('compass',document.querySelector('.compass'));
  const under=controls.filter(control=>control.box.right>band.left&&control.box.left<band.right&&control.box.bottom>band.top&&control.box.top<band.bottom).map(control=>control.name);
  const reached=[];
  for(const control of controls){
   const x=Math.round((Math.max(control.box.left,band.left)+Math.min(control.box.right,band.right))/2);
   const y=Math.round((Math.max(control.box.top,band.top)+Math.min(control.box.bottom,band.bottom))/2);
   if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
   const hit=document.elementFromPoint(x,y);
   if(hit&&hit.closest('.desktop-page-notice'))reached.push(control.name);
  }
  const key=document.querySelector('.map-key'),footer=document.querySelector('.map-bottom'),keyBox=box(key);
  return {band,under,reached,open:key.open,keyBox,
   // The key grows downward once opened: with the strip moved down it must not slide under the
   // chart's own footer, so its content is capped by the room that is left.
   keyClearOfFooter:!footer||keyBox.bottom<=box(footer).top+1,
   legendInsideKey:[...document.querySelectorAll('.map-key .legend label')].every(label=>box(label).bottom<=keyBox.bottom+1),
   reserved:getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-space').trim(),
   overflow:document.documentElement.scrollWidth<=innerWidth+1};
 });
 await page.getByRole('link',{name:'Map',exact:true}).click();
 await page.waitForFunction(()=>!!document.getElementById('terrain'),{timeout:20000});
 await send({...ready,launcherUpdate:{phase:'current'},error:mapFailure});
 await page.locator('.desktop-page-notice').filter({hasText:mapFailure}).waitFor();
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  // The reservation is layout, so the strip is re-measured on the frame after the window changes.
  await page.waitForFunction(()=>{
   const notice=document.querySelector('.desktop-page-notice'),key=document.querySelector('.map-key');
   return !notice||!key||notice.getBoundingClientRect().bottom<=key.getBoundingClientRect().top+1;
  },{timeout:4000}).catch(()=>{});
  // A real click, with the pointer: this is the interaction the band used to swallow. The point is
  // on the summary's left edge because the chart's own drawing palette sits over its right half at
  // every width (map.js slides that palette aside only once the key is open) — a chart-internal
  // overlap, not this one.
  await page.locator('.map-key summary').click({position:{x:16,y:18}});
  await page.waitForFunction(()=>document.querySelector('.map-key').open);
  const geometry=await mapNotice();
  assert.equal(geometry.open,true,'the map key opens by click at '+width+'px');
  assert.deepEqual(geometry.under,[],'the notice reaches no map control at '+width+'px: '+JSON.stringify(geometry));
  assert.deepEqual(geometry.reached,[],'and elementFromPoint agrees on the map at '+width+'px: '+JSON.stringify(geometry));
  assert.equal(geometry.keyClearOfFooter,true,'the open key stays clear of the chart footer at '+width+'px: '+JSON.stringify(geometry.keyBox));
  assert.equal(geometry.legendInsideKey,true,'every legend row is inside the key at '+width+'px');
  assert(geometry.overflow,'the moved strip adds no horizontal overflow at '+width+'px');
  await shot('notice-map-'+width);
  await page.locator('.map-key summary').click({position:{x:16,y:18}});
  await page.waitForFunction(()=>!document.querySelector('.map-key').open);
 }
 await page.setViewportSize({width:1360,height:920});
 await page.getByRole('button',{name:'Dismiss message'}).click();
 // The launch-time pair, honestly. Main is told by EASTER_TEST_TRAY=0 that this desktop
 // has no status-notifier host, which is the state of the test seat, of a bare X session
 // and of Owen's own i3/polybar seat: polybar's tray is XEmbed, so no watcher owns the
 // StatusNotifier name and an Electron tray icon would never be drawn there.
 const windowVisible=()=>app.evaluate(({BrowserWindow})=>Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()));
 const waitVisible=async(wanted,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   if(await windowVisible()===wanted)return;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('timed out waiting for the window to '+(wanted?'come back':'step aside')+' ('+label+')');
 };
 const waitStatus=async(predicate,label)=>{
  for(let attempt=0;attempt<400;attempt++){
   const status=await page.evaluate(()=>window.easterDesktop.status());
   if(predicate(status))return status;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('timed out waiting for '+label);
 };
 await page.getByRole('link',{name:'Home',exact:true}).click();
 await page.locator('[data-desktop-play]').waitFor();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('[data-desktop-play]').disabled===false);
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 assert.equal(await windowVisible(),true,'the launcher is on screen before the game starts');
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await waitVisible(false,'the no-tray path');
 assert.equal((await page.evaluate(()=>window.easterDesktop.status())).error,'This desktop has no system tray, so start Easter Co. Launcher again to bring the window back.','one sentence says why the window went and how to bring it back, rather than the setting quietly doing nothing');
 // Starting the launcher again is the way back, and it is the same second-instance path
 // the game shortcut uses.
 await app.evaluate(({app})=>app.emit('second-instance',{},[],process.cwd()));
 await waitVisible(true,'a second instance');
 assert.equal(await page.evaluate(()=>document.visibilityState!=='hidden'),true,'the page is live again once the window is shown');
 // The sentence the player needs is on screen the moment they get back, not only in state.
 assert.equal(await page.locator('.desktop-page-notice').filter({hasText:'no system tray'}).isVisible(),true,'the way back is stated where the player can read it');
 await page.getByRole('button',{name:'Dismiss message'}).click();
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 const closed=await waitStatus(status=>status.message==='Minecraft closed. Ready to play.','the game exit to settle');
 assert.equal(closed.error,null,'the exit handler still settles its own message, not an error');
 assert.equal(await windowVisible(),true,'and the launcher window is on screen for the next launch');
 await shot('no-tray-host');
 // And the tray path itself. Electron creates a Tray object on this seat — the icon has
 // nowhere to be drawn, which is why the probe above is what decides — so telling main a
 // host exists exercises the real hide: the window goes away while the game runs and
 // comes back by itself when the game ends, with the exit message it always settles.
 await app.evaluate(()=>{process.env.EASTER_TEST_TRAY='1';});
 await page.evaluate(async()=>{const state=await window.easterDesktop.status();await window.easterDesktop.saveSettings({...state.settings,exitOnLaunch:false,trayOnLaunch:true});});
 await page.locator('[data-desktop-play][data-action=play]').click();
 await page.locator('[data-desktop-play][data-action=running]').waitFor();
 await waitVisible(false,'the tray path');
 const inTray=await page.evaluate(()=>window.easterDesktop.status());
 assert.equal(inTray.phase,'running','the game is still running while the launcher sits in the tray');
 assert.equal(inTray.error,null,'a desktop with a real tray needs no do-it-yourself sentence');
 await app.evaluate(()=>global.easterTestGame.emit('exit',0));
 await waitVisible(true,'the game exit');
 const restored=await waitStatus(status=>status.message==='Minecraft closed. Ready to play.','the exit to settle after the tray');
 assert.equal(restored.error,null,'the exit message is the same one, with the launcher back on screen');
 await shot('tray-restored');
 assert.deepEqual(errors,[]);
 console.log('Launcher UI state review PASS: first run, transfer, failure, sign-in, ready, settings, one failure on one surface (no page notice painted while any modal dialog is open, the last one to close handing the same sentence back once with its dismiss control keyboard reachable, the notice reading above the hero crest and heading at 1440, 800 and 390 wide, Settings never an error sink, a repeated broadcast delivered once, a dismissed failure left dismissed, a live sign-in never painted as failed), both linked launch behaviours, the no-tray hide and its way back, the tray path, profile, wiki, wiki guide pages whose notice band reserves its own height so nothing sits under it, and the map whose docked key, legend, zoom controls, compass and drawing palette all move clear of the band with the key still opening by a real click.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
