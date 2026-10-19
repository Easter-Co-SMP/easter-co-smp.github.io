import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const state={phase:'ready',startupReady:true,companyReady:false,install:{installed:true,location:'/fixture/client'},actions:['signin'],settings:{memoryMB:4096,javaPath:''},graphics:{enabled:false},game:{state:'running',ready:true}};
 let notify=()=>{};window.sendState=update=>{Object.assign(state,update);notify({...state});};
 const wait=()=>new Promise(resolve=>window.finishSlow=resolve);
 window.easterDesktop={mode:'desktop',status:async()=>state,onState:fn=>{notify=fn;},accountProviders:async()=>({providers:[]}),
 signIn:()=>{window.sendState({device:{code:'TEST-CODE',url:'https://microsoft.com/link'},activity:{stage:'microsoft-waiting',message:'Complete sign-in on Microsoft’s page.',startedAt:Date.now()}});return wait();},cancelSignIn:async()=>{},openMicrosoft:async()=>{},loginCompany:wait,checkCompanyUsername:wait,setCompanyPassword:wait,profileEmails:wait,selectLoginEmail:wait,
 play:wait,saveSettings:async x=>x};
});
try{
 await page.clock.install();
 await page.goto(process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18107');await page.keyboard.press('Escape');
 await page.locator('.desktop-account-nav').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').waitFor({state:'visible'});
 await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.desktop-code'));getSelection().removeAllRanges();getSelection().addRange(range);window.codeNode=document.querySelector('.desktop-code').firstChild;});
 for(let i=0;i<30;i++)await page.evaluate(i=>sendState({phase:'downloading',progress:{label:'Downloading client',percent:i,bytesDone:i,bytesTotal:100}}),i);
 assert.equal(await page.evaluate(()=>String(getSelection())),'TEST-CODE');assert.equal(await page.evaluate(()=>window.codeNode===document.querySelector('.desktop-code').firstChild),true);
 await page.keyboard.press('Control+c'); // Real browser selection/copy path, then paste in a fixture field.
 await page.evaluate(()=>{const field=document.createElement('textarea');field.id='copy-probe';document.querySelector('#desktop-signin').append(field);field.focus();});await page.keyboard.press('Control+v');
 assert.equal(await page.locator('#copy-probe').inputValue(),'TEST-CODE');await page.locator('#copy-probe').evaluate(n=>n.remove());
 for(const width of [1440,800,390,320]){
  await page.setViewportSize({width,height:width<500?740:800});
  await page.screenshot({path:`/tmp/easter-wait-ms-${width}.png`,fullPage:true});
  const box=await page.locator('#desktop-signin').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
 }
 await page.evaluate(()=>sendState({activity:{stage:'company-waking',message:'The account service is waking up. We’ll keep trying…',startedAt:Date.now()-11000}}));
 await page.locator('.desktop-device').waitFor({state:'hidden'});assert.equal(await page.locator('#desktop-signin [data-cancel]').isVisible(),false);
 assert.match(await page.locator('.desktop-auth-wait').innerText(),/Still working/);await page.keyboard.press('Escape');assert.equal(await page.locator('#desktop-signin').isVisible(),true);
 await page.screenshot({path:'/tmp/easter-wait-company-waking.png'});
 await page.evaluate(()=>{sendState({activity:null,device:null,phase:'ready'});finishSlow({});});await page.locator('#desktop-signin').waitFor({state:'hidden'});
 await page.locator('.desktop-account-nav').click();const chooser=page.locator('#desktop-company-signin');await chooser.locator('[name=identifier]').fill('fixture');await chooser.locator('[name=password]').fill('fixture-password');await chooser.locator('.company-submit').click();
 await chooser.locator('.company-wait').waitFor({state:'visible'});assert.match(await chooser.locator('.company-wait').innerText(),/Signing in/);
 const beforeWait=await chooser.locator('.company-submit').boundingBox();
 await page.clock.fastForward(11000);assert.deepEqual(await chooser.locator('.company-submit').boundingBox(),beforeWait);assert.match(await chooser.locator('.company-wait').innerText(),/Still working/);
 for(const width of [1440,800,390,320]){await page.setViewportSize({width,height:width<500?740:800});await page.screenshot({path:`/tmp/easter-wait-login-${width}.png`,fullPage:true});assert.equal(await chooser.evaluate(el=>el.scrollWidth<=el.clientWidth),true);}
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await chooser.locator('.wait-feedback-mark').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.evaluate(()=>{finishSlow({ok:true});sendState({account:{id:'fixture-account',name:'Fixture',username:'fixture',passwordRequired:false},canPlay:true,companyReady:true,phase:'starting-game',game:{state:'starting',ready:false,waking:true,message:'Starting your server… the first player in a session waits about a minute.',tone:'starting'}});});
 await chooser.waitFor({state:'hidden'});await page.evaluate(()=>sendState({game:{state:'starting',ready:false,waking:true,message:'Starting your server… the first player in a session waits about a minute.',tone:'starting'}}));
 await page.clock.fastForward(11000);for(let i=0;i<10;i++)await page.evaluate(()=>sendState({game:{state:'starting',ready:false,waking:true,message:'Starting your server… the first player in a session waits about a minute.',tone:'starting'}}));
 // The cold start owns one line: the wait feedback carries its sentence and the reassurance,
 // so the server's own LED row stands down rather than saying the same thing twice.
 assert.match(await page.locator('.desktop-activity').innerText(),/Still working/);assert.equal(await page.locator('.desktop-game-status').isVisible(),false);
 await page.screenshot({path:'/tmp/easter-wait-server-320.png'});
 const forms=await browser.newPage({viewport:{width:800,height:600}});await forms.goto((process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18107')+'/wiki/');
 await forms.evaluate(async()=>{document.documentElement.classList.add('desktop-mode');const {createCompanyAuth}=await import('/company-auth.mjs');const wait=()=>new Promise(resolve=>window.completeForm=resolve);window.formUI=createCompanyAuth({desktop:{checkCompanyUsername:wait,setCompanyPassword:wait,profileEmails:wait,selectLoginEmail:wait},signInMicrosoft:async()=>{}});formUI.render({account:{id:'fixture-account',passwordRequired:true},startupReady:true});});
 await forms.locator('#desktop-company-username [name=username]').fill('fixture');await forms.locator('#desktop-company-username .company-submit').click();assert.match(await forms.locator('#desktop-company-username .company-wait').innerText(),/Checking your username/);
 await forms.evaluate(()=>completeForm({ok:true,value:{available:true}}));await forms.locator('#desktop-company-password').waitFor({state:'visible'});await forms.locator('#desktop-company-password [name=password]').fill('fixture-password');await forms.locator('#desktop-company-password [name=confirm]').fill('fixture-password');await forms.locator('#desktop-company-password .company-submit').click();assert.match(await forms.locator('#desktop-company-password .company-wait').innerText(),/Saving your password/);
 await forms.evaluate(()=>{formUI.render({account:{id:'fixture-account',username:'fixture',passwordRequired:false},startupReady:true});completeForm({ok:true});});await forms.locator('#desktop-company-password').waitFor({state:'hidden'});
 await forms.evaluate(()=>{void formUI.emails();});await forms.locator('#desktop-company-emails .company-wait').waitFor({state:'visible'});assert.match(await forms.locator('#desktop-company-emails .company-wait').innerText(),/Reading your verified emails/);
 await forms.evaluate(()=>completeForm({emails:[{email:'fixture@example.invalid',provider:'microsoft',login:false}],loginEmail:null}));await forms.locator('#desktop-company-emails input[name=email]').check();await forms.locator('#desktop-company-emails .company-submit').click();assert.match(await forms.locator('#desktop-company-emails .company-wait').innerText(),/Saving your email selection/);
 await forms.screenshot({path:'/tmp/easter-wait-emails-800.png'});await forms.close();
 assert.deepEqual(errors,[]);console.log('Quiet waiting, long-wait reassurance, real selection/copy, cancellation, narrow layouts and reduced motion passed.');
}finally{await browser.close();}
