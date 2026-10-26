import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin=process.env.EASTER_PUBLIC_ORIGIN||'http://127.0.0.1:18104';
const api='https://jyjshd22z3.execute-api.us-east-2.amazonaws.com';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const baseAccount={id:17,username:'fixture_player',displayName:'Private fixture display name',passwordRequired:false,microsoftLinked:false,providers:['steam'],roles:[],picture:null};
const product={key:'fixture-cosmetic',name:'Fixture cosmetic',amountMinor:500,currency:'USD',kind:'cosmetic',creditPence:0};
const signed=account=>({account,session:{token:'fixture-session-not-a-real-credential',expiresAt:new Date(Date.now()+3600000).toISOString()}});
let checks=0;
try{
 for(const width of [1440,834,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[];
  let account={...baseAccount},paid=false,providerSignup=false,finishCalls=0,checkoutCalls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await context.route(api+'/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON?.();
   requests.push({path,method:request.method(),body,headers:request.headers()});
   let value,status=200;
   if(path.endsWith('/providers'))value={providers:['microsoft','steam','discord']};
   else if(path.endsWith('/providers/start')){assert.match(body.verifier,/^[-_A-Za-z0-9]{43}$/);value={flow:'f'.repeat(43),url:'https://steamcommunity.com/openid/login?fixture=1',expiresIn:600};}
   else if(path.endsWith('/providers/finish')){finishCalls++;account={...baseAccount,username:null,passwordRequired:true};value=signed(account);}
   else if(path.endsWith('/password/login')){if(body.password==='wrong'){status=401;value={error:'invalid_credentials'};}else value=signed(account);}
   else if(path.endsWith('/username/available'))value={available:body.username!=='taken',reason:'taken'};
   else if(path.endsWith('/password')){account={...account,username:body.username||account.username,passwordRequired:false};value=signed(account);}
   else if(path.endsWith('/me'))value={account};
   else if(path.endsWith('/emails'))value={emails:[],loginEmail:null};
   else if(path.endsWith('/profile')){account={...account,displayName:body.displayName};value={account};}
   else if(path.endsWith('/store/catalogue'))value={products:[product]};
   else if(path.endsWith('/store/orders'))value={orders:paid?[{sessionId:'fixture-order',product:product.key,amountMinor:500,currency:'USD',paid:true,delivered:false,creditPence:0,createdAt:'2026-10-26T12:00:00Z'}]:[]};
   else if(path.endsWith('/checkout')){checkoutCalls++;assert.deepEqual(body,{product:product.key});value={url:'https://checkout.stripe.com/c/pay/fixture',sessionId:'fixture-order',product:product.key};}
   else if(path.endsWith('/logout'))value={};
   else throw Error('Unexpected API request '+path);
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  await context.route('https://steamcommunity.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Fixture provider complete</p>'}));
  await context.route('https://checkout.stripe.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture checkout</title><p>Fixture only</p>'}));
  await page.goto(origin);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
  await page.locator('#desktop-company-signin input[name=identifier]').fill('fixture_player');
  await page.locator('#desktop-company-signin input[name=password]').fill('wrong');
  await page.locator('#desktop-company-signin button[type=submit]').click();
  await page.locator('#desktop-company-signin .company-error').waitFor({state:'visible'});
  assert.equal(await page.locator('#desktop-company-signin input[name=password]').inputValue(),'');
  await page.locator('#desktop-company-signin input[name=password]').fill('fixture-passphrase');
  await page.locator('#desktop-company-signin button[type=submit]').click();
  await page.getByRole('button',{name:'Account options'}).waitFor();
  assert.equal(await page.locator('.web-account-nav').textContent(),'fixture_player');
  assert.equal(await page.locator('.hero-copy h1').count(),1);
  assert.equal(await page.locator('[data-download-primary]').count(),1);
  assert.equal(await page.evaluate(()=>Boolean(window.easterDesktop)),false);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('desktop-mode')),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-session')),false);
  await page.getByRole('button',{name:'Account options'}).click();
  await page.getByRole('button',{name:'My Profile',exact:true}).click();
  await page.locator('#company-profile [data-name-form] input').fill('Updated fixture');
  await page.locator('#company-profile button[type=submit]').first().click();
  await page.locator('#company-profile .company-status').filter({hasText:'Saved.'}).waitFor();
  await page.getByRole('button',{name:'Close My Profile'}).click();
  await page.getByRole('link',{name:'Store',exact:true}).click();
  await page.getByRole('heading',{name:product.name,exact:true}).waitFor();
  assert.equal(await page.locator('.store-price').textContent(),'$5.00');
  await page.getByRole('link',{name:'Orders',exact:true}).click();
  await page.getByText('No orders yet.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Browse',exact:true}).click();
  await page.getByRole('button',{name:'Buy '+product.name,exact:true}).click();
  await page.waitForURL('https://checkout.stripe.com/**');
  assert.equal(checkoutCalls,1);
  await page.goto(origin+'/#store-paid/forged');
  await page.waitForURL('**/store/#orders');
  await page.getByText('No orders yet.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Payment Successful',exact:true}).count(),0);
  await page.getByRole('button',{name:'Account options'}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByText('Sign in to buy.',{exact:true}).waitFor();
  assert.equal(await page.locator('.store-order-record').count(),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('easter-company-web-session-v1')),null);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
  await page.getByRole('button',{name:'Sign in with Steam',exact:true}).click();
  await page.locator('#desktop-company-username[open]').waitFor();
  await page.locator('#desktop-company-username input').fill('new_fixture');
  await page.locator('#desktop-company-username button[type=submit]').click();
  await page.locator('#desktop-company-password[open]').waitFor();
  await page.locator('#desktop-company-password input[name=password]').fill('fixture-new-passphrase');
  await page.locator('#desktop-company-password input[name=confirm]').fill('fixture-new-passphrase');
  await page.locator('#desktop-company-password button[type=submit]').click();
  await page.locator('#desktop-company-password').waitFor({state:'hidden'});
  assert.equal(finishCalls,1);
  assert.equal(await page.locator('.web-account-nav').textContent(),'new_fixture');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/web-accounts-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
  assert(requests.every(r=>!new URL(api+r.path).search));
  console.log('PASS web login, profile, store, checkout return distrust, logout, provider signup, no overflow at '+width);
  checks++;await context.close();
 }
}finally{await browser.close();}
console.log(checks+' responsive journeys passed; all credentials and purchases were fixtures.');
