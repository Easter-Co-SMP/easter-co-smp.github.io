import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';

const roots=[resolve('site'),resolve(process.env.EASTER_CORPORATE_SITE||'/root/eastercompany.github.io/site')];
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
const serve=root=>createServer(async(req,res)=>{
 try{let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname.endsWith('/'))pathname+='index.html';const path=resolve(root,'.'+pathname);if(!path.startsWith(root+sep))throw Error('outside root');res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Access-Control-Allow-Origin':'*'});res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
});
const servers=roots.map(serve);
for(const server of servers)await new Promise(done=>server.listen(0,'127.0.0.1',done));
const account={id:17,username:'fixture_player',displayName:'Fixture Player',passwordRequired:false,microsoftLinked:false,providers:[],roles:[],picture:null};
const signed={account,session:{token:'fixture-session',expiresAt:new Date(Date.now()+3600000).toISOString()}};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try{
 for(let i=0;i<servers.length;i++){
  const origin=`http://127.0.0.1:${servers[i].address().port}`;
  const context=await browser.newContext({reducedMotion:'reduce'});
  await context.route('https://launcher.easter.company/**',async route=>{
   const url=new URL(route.request().url());const target=`http://127.0.0.1:${servers[0].address().port}${url.pathname}`;
   const response=await route.fetch({url:target});await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':'*'}});
  });
  await context.route('https://jyjshd22z3.execute-api.us-east-2.amazonaws.com/**',async route=>{
   const path=new URL(route.request().url()).pathname;let body={};let status=200;
   if(path.endsWith('/password/login'))body=signed;
   else if(path.endsWith('/me'))body={account};
   else if(path.endsWith('/providers'))body={providers:['microsoft']};
   else if(path.endsWith('/settings'))body={settings:{},revision:1};
   else if(path.endsWith('/logout'))status=204;
   else {status=404;body={error:'fixture_unhandled'};}
   await route.fulfill({status,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,OPTIONS','access-control-allow-headers':'*'},contentType:'application/json',body:status===204?'':JSON.stringify(body)});
  });
  let page=await context.newPage();await page.goto(origin);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).click();
  await page.locator('#desktop-company-signin input[name=identifier]').fill('fixture_player');
  await page.locator('#desktop-company-signin input[name=password]').fill('fixture-passphrase');
  await page.locator('#desktop-company-signin button[type=submit]').click();
  await page.getByRole('button',{name:'Account options'}).waitFor();
  await page.close();page=await context.newPage();await page.goto(origin);
  await page.getByRole('button',{name:'Account options'}).waitFor();
  const second=await context.newPage();await second.goto(origin);await second.getByRole('button',{name:'Account options'}).waitFor();
  await page.getByRole('button',{name:'Account options'}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await second.getByRole('button',{name:'Sign in or create an Easter Company account'}).waitFor();
  await second.close();await page.close();page=await context.newPage();await page.goto(origin);
  await page.getByRole('button',{name:'Sign in or create an Easter Company account'}).waitFor();
  console.log(`${i?'corporate':'launcher'}: sign-in survives closing all tabs; sign-out syncs and persists`);
  await context.close();
 }
}finally{await browser.close();for(const server of servers)await new Promise(done=>server.close(done));}
