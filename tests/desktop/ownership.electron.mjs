import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// The ownership promise, driving only what the product still has.
//
// The launcher starts Minecraft for one account, and only when that account owns Java
// Edition: a signed-in player without the game gets the official store, never Play, and no
// IPC call gets past the frozen Play gate. This journey used to reach those states through
// the Add/Switch Account UI, which provider sign-in (4341b90, launcher 1.0.23) removed along
// with the saved Company account list, the switch-account IPC handler and the "Use a
// different account" button; the launcher has exactly one signed-in account now, and it is
// state.account. So the journey keeps the ownership states and drops the account maze:
// sign-in without ownership, Buy Now to the official store, the profile-required and
// service-outage rechecks, Play once access is owned, and the revocation guard that refuses
// a cached profile. What a signed-in player may do is unchanged; how many accounts they can
// hold is the one-account contract, asserted in deslop.electron.mjs and accounts.electron.mjs.
//
// Client *file* ownership -- an installed client's own marker being checked before managed
// graphics are disabled (desktop/visuals.cjs assertOwned, dd04d42) -- is a different gate and
// is proven where it lives, in tests/desktop/visuals.test.cjs inside `npm test`. These
// fixtures stub the visual setup because no client tree exists here to configure.
const home=await fs.mkdtemp(path.join(os.tmpdir(),'java-access-'));
await fs.writeFile(path.join(home,'settings.json'),JSON.stringify({memoryMB:4096,server:'100.100.1.0:25565',exitOnLaunch:false}));
const app=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron'),args:['--no-sandbox',path.resolve('tests/desktop/ownership-harness.cjs')],env:{...process.env,EASTER_TEST_HOME:home}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.keyboard.press('Escape');
 const status=()=>page.evaluate(()=>window.easterDesktop.status());
 const mode=value=>app.evaluate((_electron,value)=>global.ownershipMode=value,value);
 const opened=()=>app.evaluate(()=>global.ownershipOpened);
 const launches=()=>app.evaluate(()=>global.ownershipLaunches);
 const hero=kind=>page.locator('[data-desktop-play][data-action="'+kind+'"]');
 // One sign-in, for an account without Java Edition. The Company account is created anyway:
 // product access and Company sign-in are independent.
 await hero('signin').click();await page.getByRole('button',{name:'Sign in with Microsoft',exact:true}).click();await page.locator('#desktop-signin').waitFor({state:'visible'});await app.evaluate(()=>global.ownershipApprove());
 await hero('buy').waitFor();
 assert.equal((await status()).minecraftAccess,'missing');assert.equal((await status()).canPlay,false);
 assert.equal(await page.locator('#desktop-signin').isVisible(),false,'the sign-in dialog closes when the flow finishes');assert.equal(await page.locator('.desktop-page-notice').isVisible(),false,'no generic sign-in error for non-owner');
 assert.match((await status()).microsoftAccount.id,/^msa:[a-f0-9]{64}$/);assert.equal((await status()).profile,null);
 assert.equal(await app.evaluate(()=>global.ownershipEnrols),1,'non-owners can have a Company account independently of Java access');
 assert.equal((await status()).account.username,'javacaptain','the one signed-in account is state.account');
 assert.equal('accounts' in (await status()),false,'no account list: ownership never needs a second account');
 await page.setViewportSize({width:800,height:600});await page.screenshot({path:'/tmp/java-buy-now.png',animations:'disabled'});
 await hero('buy').click();assert.equal((await opened()).at(-1),'https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc');
 await page.evaluate(()=>window.easterDesktop.play());assert.equal(await launches(),0,'direct Play IPC cannot bypass ownership');
 // Java access transitions, each asked for by the player, on the same one account.
 await mode('profile-required');await page.locator('[data-recheck-access]').click();await hero('setup-profile').waitFor();
 assert.equal((await status()).canPlay,false);await hero('setup-profile').click();assert.equal((await opened()).at(-1),'https://www.minecraft.net/en-us/msaprofile');
 await page.screenshot({path:'/tmp/java-profile-required.png',animations:'disabled'});
 await mode('unknown');await page.locator('[data-recheck-access]').click();await hero('check-access').waitFor();
 assert.equal(await hero('buy').count(),0,'service failures do not advertise another purchase');await page.screenshot({path:'/tmp/java-access-retry.png',animations:'disabled'});
 await mode('owned');await hero('check-access').click();await hero('play').waitFor();
 assert.equal((await status()).minecraftAccess,'owned');assert.equal((await status()).canPlay,true);
 // A recheck re-asks the account service about the same Microsoft identity (enrolAccount
 // refreshes the Company session), so the count above belongs to the sign-in, not to these;
 // what must not change is which account is signed in.
 assert.equal((await status()).account.username,'javacaptain','confirming access does not change the account');
 assert.equal('accounts' in (await status()),false,'no account list appears along the way');
 // Access can be lost again: a cached Java profile must not start anything.
 await mode('missing');await page.evaluate(()=>window.easterDesktop.play());await hero('buy').waitFor();
 assert.equal(await launches(),0,'revoked access cannot launch using a cached profile');
 // The same rule follows the player to another page: the Wiki dock offers Buy Now, not Play.
 await page.getByRole('link',{name:'Wiki',exact:true}).click();await page.locator('[data-bar-primary]').waitFor();assert.equal(await page.locator('[data-bar-primary]').textContent(),'Buy Now');
 await page.locator('[data-bar-primary]').click();assert((await opened()).at(-1).includes('/store/'));
 assert(!(await page.locator('body').textContent()).includes('fixture-private'));assert(!JSON.stringify(await status()).includes('fixture-private'));
 assert.deepEqual(errors,[]);
 console.log('Java access journey PASS: sign-in without ownership, Buy Now official link, the Play IPC refused, profile setup, outage retry, Play once access is owned, one account throughout, revoked-access Play guard and Wiki dock.');
}catch(error){
 const page=await app.firstWindow();console.log(await page.evaluate(async()=>{const s=await window.easterDesktop.status();return {access:s.minecraftAccess,checking:s.accessChecking,phase:s.phase,error:s.error,hero:document.querySelector('[data-desktop-play]')?.textContent,notice:document.querySelector('.desktop-page-notice')?.textContent};}));throw error;
}finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
