// The launcher's payment window, driven against a local "Stripe" page. Excluded from desktop
// packages (tests/ is not in the build's file list) and changing nothing in production: the
// account service, the Microsoft sign-in and the game installation are stubbed exactly as the
// other harnesses stub them, and the real desktop/main.cjs is required at the end, so the window
// under test is the window this launcher actually makes.
//
// NO REAL STRIPE SESSION IS OPENED. The account service here is a fixture that answers a
// Checkout URL on the Checkout host, and the harness serves that address itself, for the
// `stripe-checkout` partition only, out of the page below. Stripe is in test mode and this
// journey still never asks it for anything: a fixture is the only honest way to drive a payment
// window without spending money or creating a session.
const electron=require('electron');
const {app,shell,session}=electron;
// Anything that would hand a URL to the operating system is recorded and never performed. The
// journey asserts on this list: a payment must never leave the launcher.
global.paymentOutside=[];
shell.openExternal=async url=>{global.paymentOutside.push(url);};

// The three navigations the journey needs, and the only ones this fixture offers: the success
// fragment the cloud half sets as `success_url`
// (`https://easter-co-smp.github.io/#store-paid/{CHECKOUT_SESSION_ID}`), the cancel fragment it
// sets as `cancel_url` (`https://easter-co-smp.github.io/#store-cancelled`), and a page on
// another host, which must never load.
const FIXTURE=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stripe Checkout fixture</title></head>
<body>
<h1>Stripe Checkout</h1>
<p>This is the local fixture standing in for Stripe's hosted Checkout page.</p>
<button id="pay" type="button">Pay</button>
<button id="cancel" type="button">Cancel</button>
<button id="elsewhere" type="button">Elsewhere</button>
<script>
 const go=url=>{location.href=url;};
 document.getElementById('pay').onclick=()=>go('https://easter-co-smp.github.io/#store-paid/cs_test_fixture');
 document.getElementById('cancel').onclick=()=>go('https://easter-co-smp.github.io/#store-cancelled');
 document.getElementById('elsewhere').onclick=()=>go('https://example.test/elsewhere');
</script>
</body></html>`;
// Every host the payment session was asked to fetch, in order. A host in here other than the
// Checkout host is a navigation that got past the launcher, which the journey treats as a
// failure.
global.paymentHosts=[];
global.paymentStripeLoads=0;
app.whenReady().then(()=>{
 const stripe=session.fromPartition('stripe-checkout');
 stripe.protocol.handle('https',request=>{
  const url=new URL(request.url);
  global.paymentHosts.push(url.host);
  if(url.hostname==='checkout.stripe.com'){
   global.paymentStripeLoads+=1;
   return new Response(FIXTURE,{headers:{'content-type':'text/html; charset=utf-8'}});
  }
  return new Response('<!doctype html><meta charset="utf-8"><title>Not the payment</title><p id="foreign">A foreign host loaded.</p>',{headers:{'content-type':'text/html; charset=utf-8'}});
 });
});

const companyFixture=require('./account-fixture.cjs');
companyFixture.install();
const auth=require('../../desktop/auth.cjs');
auth.MicrosoftAuth=class{
 async signIn(notify,signal){
  notify({code:'TEST-CODE',url:'https://microsoft.com/link',expiresAt:Date.now()+600000});
  await new Promise((resolve,reject)=>{
   global.easterTestApprove=resolve;
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  return {...companyFixture.proof('1234567890abcdef1234567890abcdef','TestCaptain'),profile:{id:'1234567890abcdef1234567890abcdef',name:'TestCaptain'},accessToken:'fixture-private-token',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+86400000};
 }
 async refresh(current){return current;}
};
// The account fixture owns the account and game routes and has no store of its own, so the three
// store routes are added to its shape here, in the frozen wire form (doc/launcher-store.md). The
// orders list is a variable: the journey "records" a purchase by handing the service its own row,
// which is the only way a row may appear on the page.
const PRODUCTS=[
 {key:'sterling-10',name:'10 Sterling',amountMinor:149,currency:'USD',kind:'sterling',creditPence:1000},
 {key:'sterling-100',name:'100 Sterling',amountMinor:695,currency:'USD',kind:'sterling',creditPence:10000},
 {key:'donation-5',name:'Keep the lights on',amountMinor:500,currency:'USD',kind:'donation',creditPence:0}
];
global.storeProducts=[...PRODUCTS];
global.storeOrderList=[];
global.storeOrderReads=0;
global.storeCheckoutPresses=[];
global.storeCheckoutFailure=false;
// The URL the fixture service answers a press with. The journey moves it to prove the launcher's
// own host rule: a session that answers with anywhere but Stripe's Checkout host never opens.
global.storeCheckoutURL='https://checkout.stripe.com/c/pay/cs_test_fixture';
const accounts=require('../../desktop/accounts.cjs');
Object.assign(accounts.AccountClient.prototype,{
 async storeCatalogue(){return {products:global.storeProducts.map(entry=>({...entry}))};},
 async storeCheckout(_token,key){
  global.storeCheckoutPresses.push(key);
  if(global.storeCheckoutFailure)throw new accounts.AccountError('checkout_unavailable','The store is unavailable right now.');
  return {url:global.storeCheckoutURL,sessionId:'cs_test_fixture',product:key};
 },
 async storeOrders(){global.storeOrderReads+=1;return {orders:global.storeOrderList.map(entry=>({...entry}))};}
});
const install=require('../../desktop/install.cjs');
install.clientStatus=async()=>({installed:false,version:null,updatedAt:null,record:null});
install.checkForUpdates=async()=>({checked:true,changed:false,applied:false,changes:[],result:null});
// These fixtures stub the game installation; no client tree exists here to configure.
const visualSetup=require('../../desktop/visuals.cjs');
visualSetup.configureVisuals=async()=>({});visualSetup.disableShaders=async()=>{};
require('../../desktop/main.cjs');
