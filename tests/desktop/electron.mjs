import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'easter-electron-test-'));
const run=async(entry,exercise,manageArrival)=>{
 const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',entry],env:{...process.env,EASTER_TEST_HOME:temp}});
 try{const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  const arriving=await page.evaluate(()=>document.body.classList.contains('is-arriving'));
  if(!manageArrival)await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  await exercise(app,page,arriving);assert.deepEqual(errors,[]);}finally{await app.close();}
};
// The Skip intro control must not exist in the desktop DOM at all, and the arrival must still be
// skippable and bounded without it. Launch one runs the arrival both ways; launch two runs the shell.
const noSkipControl=async page=>{
 assert.equal(await page.locator('.skip-arrival').count(),0);
 assert.equal(await page.getByRole('button',{name:'Skip intro'}).count(),0);
};
const arrival=async()=>await run(path.join(root,'desktop/main.cjs'),async(app,page,arriving)=>{
 // Absence is a DOM fact, so it is asserted while the arrival is still running, not only after it ends.
 await noSkipControl(page);
 assert(arriving,'the desktop home plays the bounded arrival');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
 // Left untouched after a fresh load, the bounded 4.6s timer still ends the arrival.
 await page.reload();
 await page.waitForFunction(()=>document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
 await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
 await noSkipControl(page);
},true);
try{
 await arrival();
 await run(path.join(root,'desktop/main.cjs'),async(app,page)=>{
  await page.getByRole('button',{name:'My client',exact:true}).click();
  assert(await page.getByRole('dialog',{name:'Your next voyage.'}).isVisible());
  assert((await page.locator('.desktop-status').textContent()).includes('crew'));
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().nodeIntegration),false);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().contextIsolation),true);
  await page.locator('.desktop-settings summary').click();
  await page.locator('input[name=memoryMB]').fill('3072');
  await page.locator('input[name=server]').fill('test.example:25565');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.locator('.desktop-settings-result').filter({hasText:'Saved.'}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('link',{name:'Map',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('snapshot-date').textContent.includes('Charted'));
  assert.equal(await page.locator('.atlas-home').count(),0);
  assert.equal(await page.locator('.arrival-mist').count(),0);
  assert.equal(await page.locator('nav [popovertarget]').count(),0);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.locator('.desktop-settings summary').click();
  assert.equal(await page.locator('input[name=server]').inputValue(),'test.example:25565');
  await page.keyboard.press('Escape');
  await page.screenshot({path:'/tmp/easter-desktop-map.png'});
  await page.getByRole('link',{name:'Home',exact:true}).click();
  await page.waitForFunction(()=>!document.body.classList.contains('is-arriving'));
  assert.equal(await page.getByRole('button',{name:'Skip intro'}).count(),0);
  await page.screenshot({path:'/tmp/easter-desktop-home.png',fullPage:true});
 });
 const saved=JSON.parse(await fs.readFile(path.join(temp,'settings.json'),'utf8'));assert.equal(saved.server,'test.example:25565');
 await run(path.join(root,'tests/desktop/harness.cjs'),async(app,page)=>{
  await page.locator('[data-desktop-play]').click();
  await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
  assert(!(await page.evaluate(()=>JSON.stringify(document.body.textContent))).includes('fixture-private'));
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
  await page.locator('.desktop-status').filter({hasText:'cancelled'}).waitFor();
  await page.getByRole('button',{name:'Sign in & Play',exact:true}).click();
  await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();
  await app.evaluate(()=>global.easterTestApprove());
  await page.locator('.desktop-status').filter({hasText:'Minecraft is running'}).waitFor();
  assert(await page.getByRole('button',{name:'Minecraft is running',exact:true}).isDisabled());
  const status=await page.evaluate(()=>window.easterDesktop.status());assert.equal(status.profile.name,'TestCaptain');assert(!JSON.stringify(status).includes('fixture-private'));
  await page.screenshot({path:'/tmp/easter-desktop-launcher.png'});
  await app.evaluate(()=>global.easterTestGame.emit('exit',0));
  await page.locator('.desktop-status').filter({hasText:'Welcome back'}).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.locator('.desktop-account').filter({hasText:'Connect your Microsoft'}).waitFor();
 });
 console.log('DESKTOP PASS: no Skip intro control in the desktop DOM (Escape and the 4.6s bound still end the arrival), real Electron, isolated renderer, shared Home/Map, native settings persistence, sign-in cancellation, device-code UI, authenticated Play, game lifecycle, no tokens in UI');
}finally{await fs.rm(temp,{recursive:true,force:true});}
