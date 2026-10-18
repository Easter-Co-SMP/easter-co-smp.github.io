import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const require=createRequire(import.meta.url),{createPackage}=require('@electron/asar'),updater=require('../../desktop/updater.cjs');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'bootstrap-test-')),source=path.join(home,'payload');
await fs.mkdir(path.join(source,'desktop'),{recursive:true});
await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'easter-company-launcher',version:'9.0.0'}));
await fs.writeFile(path.join(source,'desktop/main.cjs'),"global.easterPayloadVersion=require('../package.json').version;const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false});w.loadURL('data:text/html,<p>Updated payload</p>');});");
const archive=path.join(home,'fixture.asar');await createPackage(source,archive);
const bytes=await fs.readFile(archive),crypto=require('node:crypto'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const root=path.join(home,'Easter Company/launcher-updates');await fs.mkdir(root,{recursive:true});
const runtime=require('electron/package.json').version;
await updater.update({current:'1.0.10',runtime,root,inspect(){},fetch:async url=>{
 if(url.endsWith('/latest'))return Response.json({tag_name:'launcher-v9.0.0'});
 if(url.endsWith('.json'))return Response.json({schema:1,bootstrap:1,version:'9.0.0',platform:process.platform,arch:process.arch,runtime,asset:'Easter-Company-Update-'+process.platform+'-'+process.arch+'.asar',size:bytes.length,sha256:hash});
 return new Response(bytes);
}});
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/bootstrap-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home}});
try{
 await app.firstWindow();
 assert.equal(await app.evaluate(()=>global.easterPayloadVersion),'9.0.0','installed bootstrap runs verified downloaded application code');
 assert((await app.evaluate(({app})=>app.getAppPath())).endsWith(hash+'.asar'));
 console.log('Bootstrap Electron PASS: downloaded ASAR activated through persistent pointer and selected on next process start.');
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
