import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd(),home=await fs.mkdtemp(path.join(os.tmpdir(),'easter-wiki-'));
const packaged=process.env.EASTER_PACKAGED_LAUNCHER;
const app=await electron.launch({executablePath:packaged||path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',...(packaged?[]:[path.join(root,'desktop/main.cjs')])],env:{...process.env,EASTER_TEST_HOME:home}});
try {
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('link',{name:'Wiki',exact:true}).click();
  await page.locator('.wiki-card').first().waitFor();
  assert(page.url().startsWith('easter://easter/wiki/'));
  assert.equal(await page.locator('.wiki-card').count(),12);
  assert.equal(await page.locator('.arrival-mist').count(),0);
  assert.equal(await page.locator('nav [popovertarget]').count(),0);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  // Deny every non-bundled network request: the wiki must remain fully functional.
  const session=await app.evaluate(({BrowserWindow})=>{
    BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest((details,callback)=>{
      callback({cancel:/^https?:/.test(details.url)});
    }); return true;
  });assert(session);
  await page.reload();await page.locator('.wiki-card').first().waitFor();
  await page.getByRole('link',{name:'Ships & sailing',exact:true}).click();
  await page.getByRole('heading',{name:'Ships & sailing',exact:true,level:1}).waitFor();
  await page.getByLabel('Search the wiki',{exact:true}).fill('piloting');
  assert.equal(await page.locator('.wiki-result').count(),1);
  await page.locator('.wiki-result').click();
  await page.getByRole('heading',{name:'Ships & sailing',exact:true,level:1}).waitFor();
  await page.screenshot({path:'/tmp/wiki-launcher.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);
  console.log('Wiki Electron PASS: same bundled articles, navigation and search work offline with isolated preload.');
} finally {await app.close();await fs.rm(home,{recursive:true,force:true});}
