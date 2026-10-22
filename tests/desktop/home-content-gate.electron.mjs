// The home cards' read while the mandatory-update gate is still closed.
//
// The bug this pins down, measured on the released builds: a player who already has the
// client installed is told "News unavailable" on the Play Now stage, while an empty HOME
// loads the same card. The cause was not the read, the warm call or the network: main
// refused `home-content` because startupReady is false for as long as the game update is
// being verified, and the renderer spends its one retry inside that window and paints the
// unavailable state (1.0.36 had no warm read and no retry, 1.0.37 added both and still
// lost the answer, 1.0.38 carried it).
//
// So this suite holds the verify open, which is exactly the returning player's launch, and
// asserts that the real preload and the real main answer the cards from the warm read
// while privileged commands stay refused. The empty-HOME half of the same rule is the
// first block of scripts/check-packaged-first-screen.mjs.
// Run: xvfb-run -a node tests/desktop/home-content-gate.electron.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root=process.cwd();
const home=await fs.mkdtemp(path.join(os.tmpdir(),'home-content-gate-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The published document, as the launcher would find it on the client origin: one clean
// dispatch the renderer can paint, served on a loopback origin a fixture may name.
const dispatch={id:'fixture-dispatch',title:'A fixture dispatch',excerpt:'Written for this check.',publishedAt:'2026-10-19T16:00:00Z',url:'https://example.test/dispatch'};
const reads=[];
const server=http.createServer((request,response)=>{
 const name=new URL(request.url,'http://stub').pathname;
 reads.push(name);
 if(name!=='/home.json'){response.writeHead(404);response.end();return;}
 const body=Buffer.from(JSON.stringify({schema:1,posts:[dispatch],featuredItem:null}));
 response.writeHead(200,{'Content-Type':'application/json','Content-Length':body.length});response.end(body);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox',path.join(root,'tests/desktop/home-content-gate-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home,EASTER_CLIENT_ORIGIN:origin}});
let failures=0;
const check=(condition,message)=>{if(condition)console.log('  ok   '+message);else{failures++;console.log('  FAIL '+message);}};
const readHomeContent=page=>page.evaluate(async()=>{
 try{const value=await window.easterDesktop.homeContent();return {ok:true,value};}catch(error){return {ok:false,error:error.message};}
});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 await page.waitForFunction(()=>window.easterDesktop?.mode==='desktop');
 // The verify must really be the reason the gate is closed, not a slow start.
 for(let attempt=0;attempt<200;attempt++){if(await app.evaluate(()=>Boolean(global.easterClientVerifyStarted)))break;await sleep(50);}
 check(await app.evaluate(()=>Boolean(global.easterClientVerifyStarted)),'the installed client\'s update verify is running');
 const closed=await page.evaluate(()=>window.easterDesktop.status());
 check(closed.startupReady===false,'the mandatory-update gate is still closed while that verify runs');
 check(closed.install.installed===true,'and this is the returning player: the client is installed');

 console.log('\n1. the cards\' own read, while the gate is closed');
 const first=await readHomeContent(page);
 check(first.ok===true,'home-content answers instead of refusing: '+JSON.stringify(first.ok?{schema:first.value?.schema,posts:first.value?.posts?.length}:first));
 check(first.value?.schema===1&&Array.isArray(first.value?.posts),'and it is the validated document, not an error shape');
 check(first.value?.posts?.[0]?.id===dispatch.id,'carrying the dispatch the site publishes: '+JSON.stringify(first.value?.posts?.map(post=>post.id)));
 const second=await readHomeContent(page);
 check(second.ok===true,'the retry the renderer would spend is not needed and would answer too');
 check(reads.filter(name=>name==='/home.json').length===1,'both asks were answered by the one warm read, with no second fetch: '+JSON.stringify(reads.filter(name=>name==='/home.json').length));

 console.log('\n2. the card the player actually reads');
 const card=await page.locator('.social-card').innerText();
 check(card.includes(dispatch.title),'the LATEST NEWS card paints the dispatch while the gate is closed: '+JSON.stringify(card));
 check(!/unavailable/i.test(card),'and says nothing is unavailable');
 const store=await page.locator('.store-card').innerText();
 check(!/unavailable/i.test(store),'the store card is not made unavailable by the same window: '+JSON.stringify(store.split('\n')[0]));

 console.log('\n3. the gate still gates what it exists for');
 for(const command of ['play','startInstall']){
  const refused=await page.evaluate(async name=>{try{await window.easterDesktop[name]();return null;}catch(error){return error.message;}},command);
  check(/Updates must finish/.test(refused||''),command+' is still refused before the update gate opens: '+JSON.stringify(refused));
 }

 console.log('\n4. and the answer survives the gate opening');
 await app.evaluate(()=>global.easterClientVerifyContinue());
 for(let attempt=0;attempt<400;attempt++){if((await page.evaluate(()=>window.easterDesktop.status())).startupReady===true)break;await sleep(50);}
 check((await page.evaluate(()=>window.easterDesktop.status())).startupReady===true,'the gate opened when the verify finished');
 const after=await readHomeContent(page);
 check(after.ok===true&&after.value?.posts?.[0]?.id===dispatch.id,'the same read still answers the same document');
 check((await page.locator('.social-card').innerText()).includes(dispatch.title),'and the card is still the dispatch, not a corrected-then-empty state');
 check(reads.filter(name=>name==='/home.json').length===1,'with no extra read for the whole launch: '+JSON.stringify(reads.filter(name=>name==='/home.json').length));
}finally{
 await app.close();
 await new Promise(resolve=>server.close(resolve));
 await fs.rm(home,{recursive:true,force:true});
}
console.log(failures===0?'Home content gate PASS: the cards read while a client is being verified, and the update gate still gates.':'Home content gate FAIL: '+failures+' check(s) failed');
process.exitCode=failures===0?0:1;
