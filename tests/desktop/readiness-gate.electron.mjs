import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const home=await fs.mkdtemp('/tmp/easter-readiness-gate-');
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/flow-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_FLOW_INSTALLED:'1'}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.keyboard.press('Escape');
 await page.locator('[data-desktop-play][data-action=signin]').click();
 await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();
 await page.locator('.desktop-code').filter({hasText:'TEST-CODE'}).waitFor();await app.evaluate(()=>global.easterTestApprove());
 await page.locator('[data-desktop-play][data-action=play]').waitFor();
 for(const mode of ['unreachable','unknown']){
  await app.evaluate((_,mode)=>{global.easterTestServerState=mode;},mode);
  const result=await page.evaluate(()=>window.easterDesktop.play().catch(error=>({error:error.message})));
  assert.equal(await app.evaluate(()=>global.easterTestLaunches),0,mode+' must never invoke Java');
  assert.equal(await app.evaluate(()=>global.easterTestWakes),0,mode+' must never wake an unconfirmed host');
  const status=await page.evaluate(()=>window.easterDesktop.status());
  assert.equal(status.canPlay,true,'Play stays available for retry');assert.notEqual(status.phase,'running');
  assert.match(JSON.stringify(result)+JSON.stringify(status),/game server status could not be checked/);
 }
 await app.evaluate(()=>{global.easterTestServerState='running';});
 await page.evaluate(()=>window.easterDesktop.play());
 assert.equal(await app.evaluate(()=>global.easterTestLaunches),1,'a ready retry launches exactly once');
 assert.equal(await app.evaluate(()=>global.easterTestWakes),0,'a warm server needs no wake');
 console.log('READINESS PASS: unknown/unreachable status invoked neither Java nor wake, left Play as retry, and a ready retry launched exactly once.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
