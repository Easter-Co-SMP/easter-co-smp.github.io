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
 // The chart's footer is not the only thing under the key: the launcher's own sticky bar floats
 // above that footer, and at 390 it spans the window. Round-three review measured the open key's
 // last line — "Drag to pan · scroll to zoom / Arrow keys move · + / − zoom" — under the bar with
 // elementFromPoint answering #launcher-bar-body, because the key was capped by the room above the
 // footer and did not know the bar existed. The room a long sentence leaves is now measured from
 // whichever edge the key meets first, so what is proven here is that the key's content stops above
 // the bar, that its last line reads inside the key once the capped legend is scrolled to it, and
 // that at 800 and 1440 — where the bar is not the nearer edge, or does not sit over the key's own
 // columns — a key that already fits is left exactly as it was, with no cap and no scrollbar.
 const keyBarGeometry=()=>page.evaluate(()=>{
  const box=node=>{if(!node||!node.getClientRects().length)return null;const r=node.getBoundingClientRect();
   return {left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom),height:Math.round(r.height)};};
  const bar=document.getElementById('launcher-bar'),key=document.querySelector('.map-key');
  const content=document.querySelector('.key-content'),footer=document.querySelector('.map-bottom');
  const keyBox=key.getBoundingClientRect(),summary=key.querySelector('summary').getBoundingClientRect().height;
  const paragraph=[...document.querySelectorAll('.key-content p')].find(node=>node.textContent.startsWith('Drag to pan'));
  const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);
  let text=null;
  for(let candidate=walker.nextNode();candidate;candidate=walker.nextNode())if(candidate.data.includes('Arrow keys move'))text=candidate;
  const range=document.createRange();range.selectNodeContents(text);
  const line=range.getBoundingClientRect(),lineBox={left:Math.round(line.left),top:Math.round(line.top),right:Math.round(line.right),bottom:Math.round(line.bottom)};
  const x=Math.round((lineBox.left+lineBox.right)/2),y=Math.round((lineBox.top+lineBox.bottom)/2);
  const hit=document.elementFromPoint(x,y);
  range.detach();
  // The room above the bar and the room above the footer, both from the same key top: the smaller is
  // the edge the key has to clear, and the footer-only number is where this key would have ended had
  // the bar never been counted — under it, which is the defect this block is about. A bar that does
  // not stand over the key's own columns (1440, where the key sits left of a 600px band) can never
  // cover it, and then the footer is the only edge that has any say.
  const barTop=bar.getBoundingClientRect().top,footerTop=footer.getBoundingClientRect().top;
  return {bar:box(bar),barHidden:bar.hidden,key:box(key),content:box(content),footer:box(footer),open:key.open,
   overlaps:bar.getBoundingClientRect().right>keyBox.left&&bar.getBoundingClientRect().left<keyBox.right,
   keyTop:Math.round(keyBox.top),summary:Math.round(summary),
   contentBottom:Math.round(content.getBoundingClientRect().bottom),barTop:Math.round(barTop),footerTop:Math.round(footerTop),
   scrollTop:Math.round(content.scrollTop),scrollHeight:Math.round(content.scrollHeight),clientHeight:Math.round(content.clientHeight),
   scrolling:content.scrollHeight>content.clientHeight+1,
   cap:getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-key-space').trim(),
   barRoom:Math.floor(barTop-keyBox.top-summary-12),footerRoom:Math.floor(footerTop-keyBox.top-summary-12),line:lineBox,
   hit:{at:{x,y},id:hit?hit.id||hit.tagName:null,insideKey:Boolean(hit&&hit.closest('.map-key')),
    insideBar:Boolean(hit&&hit.closest('#launcher-bar')),insideNotice:Boolean(hit&&hit.closest('.desktop-page-notice'))}};
 });
 // The notice's room, the bar's offset and the key's cap are all layout, so they are re-measured on
 // the frame after anything moves. Measure once the strip has stopped moving under the pointer and
 // twice in a row, rather than once at an arbitrary moment.
 const settledKeyBar=async(where)=>{
  let previous=null;
  for(let attempt=0;attempt<240;attempt++){
   const probe=await page.evaluate(()=>{
    const notice=document.querySelector('.desktop-page-notice'),key=document.querySelector('.map-key'),bar=document.getElementById('launcher-bar');
    return {open:Boolean(key&&key.open),painted:Boolean(notice&&!notice.hidden&&notice.textContent.trim()),
     barUp:Boolean(bar&&!bar.hidden&&bar.getBoundingClientRect().height>0),
     space:getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-space').trim(),
     cap:getComputedStyle(document.documentElement).getPropertyValue('--launcher-notice-key-space').trim(),
     keyTop:key?Math.round(key.getBoundingClientRect().top):null};
   });
   if(probe.open&&probe.painted&&probe.barUp&&previous&&previous.space===probe.space&&previous.cap===probe.cap&&previous.keyTop===probe.keyTop)return probe;
   previous=probe;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('the notice, the open key and the bar never settled '+where+': '+JSON.stringify(previous));
 };
 // The legend is long and the window is short: once the key is capped its last line is reached by
 // scrolling the key, exactly as a capped legend is read above the chart's footer.
 const scrollKeyToEnd=async()=>{
  await page.evaluate(()=>{const content=document.querySelector('.key-content');content.scrollTop=content.scrollHeight;});
  await page.waitForTimeout(60);
 };
 const keyBarFailures=[
  {label:'downloading',state:{phase:'downloading',bar:{visible:true},progress:{label:'Downloading client files',percent:47,bytesDone:470000000,bytesTotal:1000000000,bytesPerSecond:12000000,etaSeconds:44}}},
  {label:'idle',state:{phase:'ready',bar:{visible:true},progress:null}}
 ];
 const keySentence='This desktop has no system tray, so start Easter Co. Launcher again to bring the window back.';
 for(const width of [1440,800,390]){
  const height=width===1440?900:width===800?600:568;
  await page.setViewportSize({width,height});
  // The bar in two shapes: one carrying a progress track (taller, the harder case) and one that is
  // merely present, which is the shape the reviewer measured at 390.
  for(const failure of keyBarFailures){
   if(width!==390&&failure.label==='idle')continue;
   const where='the '+failure.label+' bar at '+width+'px';
   await send({...ready,launcherUpdate:{phase:'current'},...failure.state,error:keySentence});
   await page.locator('.desktop-page-notice').filter({hasText:keySentence}).waitFor({timeout:6000})
    .catch(error=>{throw Error('the sentence never reached the page notice, '+where+' :: '+error.message);});
   if(!await page.evaluate(()=>document.querySelector('.map-key').open)){
    await page.locator('.map-key summary').click({position:{x:16,y:18}});
    await page.waitForFunction(()=>document.querySelector('.map-key').open);
   }
   await settledKeyBar(where);
   const geometry=await keyBarGeometry();
   assert.equal(geometry.open,true,'the map key opens under a sentence and a bar at '+width+'px');
   assert.equal(geometry.barHidden,false,'the bar is on screen on the map at '+width+'px');
   assert(geometry.bar.top<geometry.footer.top,'the bar floats above the chart footer at '+width+'px: '+JSON.stringify({bar:geometry.bar,footer:geometry.footer}));
   // Nothing of the key that is on screen may sit under the bar: its content box stops above it, and
   // so does the key's own frame.
   assert(geometry.contentBottom<=geometry.barTop+1,'the open key\'s content stops above the launcher bar, '+where+': '+JSON.stringify({contentBottom:geometry.contentBottom,barTop:geometry.barTop,cap:geometry.cap}));
   assert(geometry.key.bottom<=geometry.barTop+1,'and so does the key\'s own box, '+where+': '+JSON.stringify(geometry.key));
   assert(geometry.content.bottom<=geometry.footerTop+1,'while still clearing the chart footer, '+where+': '+JSON.stringify({content:geometry.content,footer:geometry.footer}));
   // The negative control. The room above the footer on its own is where this key would have ended
   // without the bar in the calculation — under it, which is the overlap the reviewer measured — so
   // where the bar stands over the key the bar has to be the nearer edge and the key has to stop
   // above both. Take the bar out of site/desktop.js and these two lines report exactly that overlap.
   if(geometry.overlaps)assert(geometry.keyTop+geometry.summary+geometry.footerRoom>geometry.barTop,'the footer-only cap would put the key under the bar, '+where+': '+JSON.stringify({keyTop:geometry.keyTop,summary:geometry.summary,footerRoom:geometry.footerRoom,barTop:geometry.barTop}));
   // Where the content has to be capped at all, the published cap is the room above the bar's own top
   // edge, not the larger room above the footer: drop the bar from site/desktop.js and the cap grows
   // back to footerRoom, which is the number this refuses.
   if(geometry.scrolling)assert(geometry.cap!==''&&Number.parseInt(geometry.cap,10)<=geometry.barTop-geometry.keyTop-geometry.summary+1,'the published cap is the room above the bar, '+where+': '+JSON.stringify({cap:geometry.cap,room:geometry.barTop-geometry.keyTop-geometry.summary,footerRoom:geometry.footerRoom}));
   // The line the reviewer could not read: scrolled into view it sits inside the key, above the bar,
   // and elementFromPoint over it answers the key's own text — never #launcher-bar-body.
   const wasScrolling=geometry.scrolling;
   await scrollKeyToEnd();
   const scrolled=await keyBarGeometry();
   if(wasScrolling)assert(scrolled.scrollTop>0,'the capped legend scrolls to its last line, '+where+': '+JSON.stringify({scrollTop:scrolled.scrollTop,scrollHeight:scrolled.scrollHeight,clientHeight:scrolled.clientHeight}));
   assert(scrolled.line.bottom<=scrolled.content.bottom+1,'the key\'s last line is inside its content box, '+where+': '+JSON.stringify({line:scrolled.line,content:scrolled.content}));
   assert(scrolled.line.bottom<=scrolled.barTop+1,'the key\'s last line reads above the bar, '+where+': '+JSON.stringify({line:scrolled.line,barTop:scrolled.barTop}));
   assert.equal(scrolled.hit.insideBar,false,'elementFromPoint over the key\'s last line is not the launcher bar, '+where+': '+JSON.stringify(scrolled.hit));
   assert.equal(scrolled.hit.insideKey,true,'and it is the key\'s own text, '+where+': '+JSON.stringify(scrolled.hit));
   assert.equal(scrolled.hit.insideNotice,false,'and not the notice band, '+where+': '+JSON.stringify(scrolled.hit));
   await shot('notice-map-key-bar-'+width+'-'+failure.label);
   // Where the bar does not stand over the key's columns (1440) or is not the nearer edge (800) the
   // key must be the key it always was: no cap, no scrollbar, its content as tall as it wants.
   if(!geometry.overlaps)assert.equal(geometry.cap,'','no cap is published for a bar that cannot cover the key at '+width+'px: '+JSON.stringify(geometry.cap));
   if(width!==390)assert.equal(geometry.scrolling,false,'a key that already clears the bar is not made to scroll at '+width+'px: '+JSON.stringify({scrollHeight:geometry.scrollHeight,clientHeight:geometry.clientHeight,cap:geometry.cap}));
   await page.evaluate(()=>{document.querySelector('.key-content').scrollTop=0;});
   await page.locator('.map-key summary').click({position:{x:16,y:18}});
   await page.waitForFunction(()=>!document.querySelector('.map-key').open);
   await page.getByRole('button',{name:'Dismiss message'}).click();
   // Main keeps the error set until the next ordinary message, and the page never delivers the same
   // sentence twice: a clean broadcast between rounds is what lets the next sentence be a new one.
   // Main's own bar flag is true once the client is installed, so putting that bar away is explicit.
   await send({...ready,launcherUpdate:{phase:'current'},bar:{visible:false}});
   await page.waitForFunction(()=>document.getElementById('launcher-bar').hidden);
   await page.waitForTimeout(80);
  }
 }
 await page.setViewportSize({width:1360,height:920});
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
 // ---- The account chooser on small windows (round-three review) -----------------------------
 // Two findings about the same box, measured here at the three sizes this review uses.
 //
 // At 390 the three-line conflict refusal is painted into a chooser taller than the window: its
 // third line — the way out — landed under the dialog's own bottom edge while the dialog sat at
 // scrollTop 0 (a line box 521-579 against a dialog ending at 551), so it read as a sentence cut
 // off mid-word, and nothing on screen said the box scrolls. The refusal is painted where it
 // was — above the form, before the controls — and the dialog now scrolls to it, which leaves
 // Sign in and Forgot your password below the fold: the order a refusal is read in.
 //
 // At 800x600, the launcher's own minimum window, the same refusal made the dialog exactly as
 // tall as the window has room for, so its 28px bottom inset was 12px more than the capped box
 // could show — scrollHeight 578 against clientHeight 566, twelve pixels of scrollbar over
 // space nobody can see, while every element fitted inside the box.
 //
 // The conflict driven here is the product's own, through the real preload and the real main
 // process: the saved-session shortcut is answered by an account service that names a different
 // Easter Company account, which is exactly the comparison desktop/main.cjs stops on. The
 // renderer is not stubbed, and the sentence is the account service's own.
 const smallConflictCopy=[
  'Sign in with the Microsoft account linked to this Easter Company account, or switch Easter Company accounts.',
  'Nothing on your Easter Company account has changed.',
  'Close this window first. Then open your profile at the top of the page and choose Switch Account, or Add account.'
 ];
 // One enrolment that answers with a different Easter Company account, armed for a single call
 // and disarmed by it so nothing else in the suite sees a changed account service.
 const armSmallConflict=armed=>app.evaluate(flag=>{
  const accounts=process.mainModule&&process.mainModule.require(process.cwd()+'/desktop/accounts.cjs');
  if(!accounts)throw Error('the account client is not reachable from the main process');
  const client=accounts.AccountClient.prototype;
  if(!global.__reviewConflictLogin){
   global.__reviewConflictLogin=client.login;
   client.login=async function(...args){
    const signed=await global.__reviewConflictLogin.apply(this,args);
    if(!global.__reviewConflictArmed)return signed;
    global.__reviewConflictArmed=false;
    return {...signed,account:{...signed.account,id:signed.account.id+1}};
   };
  }
  global.__reviewConflictArmed=flag;
  return flag;
 },armed);
 const smallChooser=()=>page.evaluate(()=>{
  const dialog=document.querySelector('#desktop-company-signin');
  const field=dialog.getBoundingClientRect();
  const port={top:field.top+dialog.clientTop,bottom:field.top+dialog.clientTop+dialog.clientHeight};
  const box=node=>{const rect=node.getBoundingClientRect();return {top:Math.round(rect.top),bottom:Math.round(rect.bottom)};};
  const inside=node=>{const rect=node.getBoundingClientRect();return rect.top>=port.top-1&&rect.bottom<=port.bottom+1;};
  // The refusal's own lines, not its box: the finding was a line cut mid-sentence at the
  // dialog's edge, so each painted line has to be inside the box that scrolls.
  const lines=[...dialog.querySelectorAll('.company-error p')];
  return {dialog:{top:Math.round(field.top),bottom:Math.round(field.bottom),left:Math.round(field.left),right:Math.round(field.right)},
   scrollport:{top:Math.round(port.top),bottom:Math.round(port.bottom)},
   scrollTop:Math.round(dialog.scrollTop),scrollHeight:Math.round(dialog.scrollHeight),clientHeight:Math.round(dialog.clientHeight),
   refusal:{hidden:dialog.querySelector('.company-error').hidden,lines:lines.length,boxes:lines.map(box),inside:lines.length>0&&lines.every(inside)},
   controls:{submit:inside(dialog.querySelector('.company-submit')),recover:inside(dialog.querySelector('.company-recover'))}};
 });
 // Layout settles on the frame after the paint, so measure it twice in a row rather than once.
 const settledChooser=async where=>{
  let previous=null;
  for(let attempt=0;attempt<200;attempt++){
   const probe=await smallChooser();
   if(previous&&JSON.stringify(previous)===JSON.stringify(probe))return probe;
   previous=probe;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('the chooser never settled '+where+': '+JSON.stringify(previous));
 };
 const chooserDialog=page.locator('#desktop-company-signin');
 await armSmallConflict(false);
 const signedOut=await page.evaluate(()=>window.easterDesktop.status());
 assert.equal(Boolean(signedOut.microsoftAccount),true,'the saved Microsoft session the chooser\'s shortcut needs is on record: '+JSON.stringify(signedOut.microsoftAccount));
 // The one state a real main publishes while its account view is empty, which is how the hero
 // offers Sign in again on a launcher that is already signed in. Main's own account is
 // untouched by publishing it; the assertions below read it back through the real handler.
 const offeredSignIn={...signedOut,account:null,companyReady:false,canPlay:false,actions:['signin'],phase:'ready',error:null,message:''};
 const openSmallChooser=async()=>{
  await send(offeredSignIn);
  await page.locator('[data-desktop-play][data-action=signin]').click();
  await chooserDialog.waitFor({state:'visible'});
  return settledChooser('after opening it');
 };
 for(const [width,height] of [[1440,900],[800,600],[390,568]]){
  await page.setViewportSize({width,height});
  const opening=await openSmallChooser();
  assert.equal(opening.refusal.hidden,true,'the chooser opens with no refusal at '+width+'px');
  assert.equal(opening.scrollTop,0,'and at the top of itself at '+width+'px: '+JSON.stringify(opening.scrollTop));
  assert(opening.scrollHeight<=opening.clientHeight+1,'a chooser with no refusal shows no scrollbar it does not need at '+width+'px: '+JSON.stringify({scrollHeight:opening.scrollHeight,clientHeight:opening.clientHeight}));
  await shot('chooser-small-opens-at-top-'+width);
  await armSmallConflict(true);
  await chooserDialog.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
  await chooserDialog.locator('.company-error').filter({hasText:smallConflictCopy[1]}).waitFor();
  const painted=await settledChooser('after the refusal at '+width+'px');
  assert.deepEqual(await chooserDialog.locator('.company-error p').allInnerTexts(),smallConflictCopy,'the refusal is the same three sentences, word for word, at '+width+'px');
  assert.equal(painted.refusal.lines,3,'all three lines are painted at '+width+'px');
  assert.equal(painted.refusal.inside,true,'and every one of them is inside the box that scrolls at '+width+'px: '+JSON.stringify(painted));
  if(width===390){
   assert(painted.scrollTop>0,'the dialog scrolls the refusal into view instead of leaving its last line under its own edge at '+width+'px: '+JSON.stringify(painted));
  }else{
   assert.equal(painted.scrollTop,0,'a chooser that already shows the whole refusal is not scrolled at '+width+'px');
   assert.equal(painted.controls.submit,true,'Sign in stays on screen with the refusal at '+width+'px');
   assert.equal(painted.controls.recover,true,'and so does Forgot your password at '+width+'px');
   assert(painted.scrollHeight<=painted.clientHeight+1,'and the dialog shows no scrollbar it does not need at '+width+'px: '+JSON.stringify({scrollHeight:painted.scrollHeight,clientHeight:painted.clientHeight}));
  }
  await shot('chooser-small-refusal-'+width);
  await page.keyboard.press('Escape');
  await chooserDialog.waitFor({state:'hidden'});
 }
 // The position a refusal scrolls to does not stick: the next chooser opens at the top, with
 // no refusal in it, at the width that needed the scroll.
 await page.setViewportSize({width:390,height:568});
 const reopened=await openSmallChooser();
 assert.equal(reopened.refusal.hidden,true,'the chooser reopens with no refusal');
 assert.equal(reopened.scrollTop,0,'and at the top of itself at 390px: '+JSON.stringify(reopened.scrollTop));
 await shot('chooser-small-reopened-at-top-390');
 await page.keyboard.press('Escape');
 await chooserDialog.waitFor({state:'hidden'});
 await armSmallConflict(false);
 await app.evaluate(()=>{const accounts=process.mainModule&&process.mainModule.require(process.cwd()+'/desktop/accounts.cjs');if(accounts&&global.__reviewConflictLogin)accounts.AccountClient.prototype.login=global.__reviewConflictLogin;});
 await page.setViewportSize({width:1360,height:920});
 await send(await page.evaluate(()=>window.easterDesktop.status()));
 assert.deepEqual(errors,[]);
 console.log('Launcher UI state review PASS: first run, transfer, failure, sign-in, ready, settings, one failure on one surface (no page notice painted while any modal dialog is open, the last one to close handing the same sentence back once with its dismiss control keyboard reachable, the notice reading above the hero crest and heading at 1440, 800 and 390 wide, Settings never an error sink, a repeated broadcast delivered once, a dismissed failure left dismissed, a live sign-in never painted as failed), both linked launch behaviours, the no-tray hide and its way back, the tray path, profile, wiki, wiki guide pages whose notice band reserves its own height so nothing sits under it, and the map whose docked key, legend, zoom controls, compass and drawing palette all move clear of the band with the key still opening by a real click, and the sticky bar the launcher itself floats, which the open key now clears at 390 — its last line scrolled to and read by elementFromPoint inside the key, never on #launcher-bar-body — while the key at 800 and 1440 is left at its natural size with no cap and no scrollbar, and the account chooser on small windows, whose three-line conflict refusal is scrolled into view at 390 — every line inside the box that scrolls, with Sign in and Forgot your password below the fold in the order a refusal is read — while at 800x600 the same refusal leaves no scrollbar over space nobody can see and both controls stay on screen, and a chooser with no refusal still opens at the top at every width.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
