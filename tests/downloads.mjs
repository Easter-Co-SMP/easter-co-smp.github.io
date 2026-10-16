import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1360,height:920}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://github.com/**',route=>route.fulfill({status:200,headers:{'Content-Disposition':'attachment; filename=test'},body:'fixture'}));
 await page.goto(process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18100');await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('link',{name:'View Map',exact:true}).count(),1);
 const picker=page.locator('.launcher-picker');
 for(const platform of ['windows','ubuntu','arch','appimage']){
  await picker.click();const icon=page.locator(`[data-platform=${platform}] img`);
  await icon.evaluate(img=>img.decode());
  assert(await icon.evaluate(img=>img.naturalWidth>=24));
  await page.locator(`[data-platform=${platform}]`).click();
  const dialog=page.locator('#launcher-setup');await dialog.waitFor();
  const text=await dialog.innerText();assert(text.includes('PLAY NOW'));
  for(const expected of {windows:['.exe','Start menu'],ubuntu:['sudo apt install','amd64.deb'],arch:['sudo pacman -U','.pacman'],appimage:['chmod +x','libfuse2t64','libfuse2','sudo pacman -S fuse2','fuse-libs','zypper','--appimage-extract-and-run']}[platform])assert(text.includes(expected),platform+': '+expected);
  if(platform==='appimage')await page.screenshot({path:'/tmp/easter-deslop-appimage.png'});
  await dialog.getByRole('button',{name:'Close setup instructions'}).click();
 }
 const [button,svg]=await Promise.all([picker.boundingBox(),picker.locator('svg').boundingBox()]);
 assert(Math.abs((button.y+button.height/2)-(svg.y+svg.height/2))<1);assert(Math.abs((button.x+button.width/2)-(svg.x+svg.width/2))<1);
 await picker.click();await page.waitForTimeout(350);await page.screenshot({path:'/tmp/easter-deslop-downloads.png'});
 assert.deepEqual(errors,[]);console.log('PASS: four platform icons and instructions; centered chevron; website View Map preserved');
}finally{await browser.close();}
