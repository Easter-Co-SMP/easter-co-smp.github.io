// Presentation only. Main supplies public editorial content; this renderer never buys items.
export function latestPost(posts = []) {
 const seen = new Set();
 return (Array.isArray(posts) ? posts : []).filter(p => {
  if (!p || typeof p.id !== 'string' || seen.has(p.id) || typeof p.title !== 'string' || !p.title.trim() || !Number.isFinite(Date.parse(p.publishedAt))) return false;
  try { const u = new URL(p.url); if (u.protocol !== 'https:' || u.username || u.password) return false; } catch { return false; }
  seen.add(p.id); return true;
 }).sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0] || null;
}
// The shape a store row may advertise. Nothing here is authored copy this module invents: the
// name, the price and the two worth lines are the ones site/store/store.mjs prints, from the
// server's own catalogue fields (store-contract.mjs), so the tile cannot disagree with the shop.
export function productTeaser(product) {
 if (!product || typeof product.key !== 'string' || typeof product.name !== 'string' || !product.name.trim()) return null;
 if (!Number.isInteger(product.amountMinor) || typeof product.currency !== 'string' || !product.currency) return null;
 const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: product.currency }).format(product.amountMinor / 100);
 const credit = Number.isInteger(product.creditPence) ? product.creditPence : 0;
 const worth = credit > 0
  ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(credit / 100) + ' Sterling in your bank'
  : 'A one-off donation.';
 return { key: product.key, name: product.name.trim().slice(0, 120), line: price + ' \u00b7 ' + worth };
}
// The rotation's own arithmetic, kept pure so a test can prove the wrap without a timer.
export function nextTeaserIndex(index, length) {
 return length > 0 ? (index + 1) % length : 0;
}
const AD_SECONDS = 5;
const node = (tag, cls, text) => { const el=document.createElement(tag); el.className=cls; if(text)el.textContent=text; return el; };
export function mountDiscovery(host, desktop, { account } = {}) {
 const region=node('section','launcher-discovery'); region.setAttribute('aria-label','From Easter Company');
 const social=node('article','discovery-card social-card'), store=node('article','discovery-card store-card');
 region.append(social,store);host.append(region);
 let busy=false;
 function shell(card,label) {card.replaceChildren();card.append(node('p','discovery-label',label));}
 function message(card,title,body) {card.append(node('h2','discovery-title',title));if(body)card.append(node('p','discovery-copy',body));}
 function paint(payload,failed=false) {
  shell(social,'Latest news');
  const post=latestPost(payload?.posts);
  if(post){
   const date=node('time','discovery-date',new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(post.publishedAt)));date.dateTime=post.publishedAt;social.append(date);
   message(social,post.title.slice(0,160),typeof post.excerpt==='string'?post.excerpt.slice(0,360):'');
   const link=node('a','discovery-action','Read post');link.href=post.url;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Read '+post.title.slice(0,160)+' (opens in browser)');social.append(link);
  } else message(social,failed?'News unavailable':'No posts yet',failed?'The latest post couldn’t be loaded. You can keep playing.':'New posts from Easter Company will appear here.');
  if(failed && typeof desktop.homeContent==='function'){
   const retry=node('button','discovery-action','Try again');retry.type='button';retry.onclick=load;social.append(retry);
  }
 }
 // THE STORE CARD. It is visible to everybody - it names the shop and, when there is a session,
 // advertises the catalogue - but it is a link to ./store/ only for a signed-in player (Owen,
 // 2026-11-01: "Store should not be visible inside the easter co. launcher until the user is
 // signed in", and the tile "should not link to the store until the user is signed in, but
 // otherwise should still be visible"). Rotation is the same rule as a shop window: one product
 // every five seconds, and the seconds are for reading, not for a click that is about to move.
 // Reduced motion turns the rotation off at the first product rather than animating under it.
 let signedIn=false, teasers=[], index=0, cycle=null, asked=false;
 const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const storeBody=node('div','discovery-store-body'), browse=node('a','discovery-action','Browse the store');
 browse.href='./store/';browse.hidden=true;
 store.append(node('p','discovery-label','Community store'),storeBody,browse);
 function stopCycle(){if(cycle){clearInterval(cycle);cycle=null;}}
 function paintStore(){
  if(!signedIn){
   stopCycle();
   storeBody.replaceChildren(node('h2','discovery-title','Explore the Community store'));
   browse.hidden=true;
   return;
  }
  const teaser=teasers[index];
  storeBody.replaceChildren(...(teaser
   ?[node('h2','discovery-title',teaser.name),node('p','discovery-copy',teaser.line)]
   :[node('h2','discovery-title','Explore the Community store')]));
  browse.hidden=false;
 }
 function startCycle(){
  stopCycle();
  if(reduced||teasers.length<2)return;
  cycle=setInterval(()=>{index=nextTeaserIndex(index,teasers.length);paintStore();},AD_SECONDS*1000);
 }
 async function readCatalogue(){
  if(asked)return;asked=true;
  try{
   let payload=null;
   // The launcher prefetches the catalogue at startup (desktop/main.cjs, prefetchStore); the
   // snapshot is that answer with no network call, and the live read is only the fallback.
   if(typeof desktop.storeSnapshot==='function')payload=await desktop.storeSnapshot();
   if(!payload||!Array.isArray(payload.products)){
    if(typeof desktop.storeCatalogue==='function')payload=await desktop.storeCatalogue();
   }
   teasers=(Array.isArray(payload?.products)?payload.products:[]).map(productTeaser).filter(Boolean);
   index=0;
  }catch{teasers=[];}
  paintStore();startCycle();
 }
 function applyAccount(state){
  const next=Boolean(state?.account);
  if(next===signedIn&&asked){paintStore();return;}
  signedIn=next;
  if(signedIn)void readCatalogue();
  else{teasers=[];index=0;paintStore();}
 }
 paintStore();
 if(account&&typeof account.subscribe==='function')account.subscribe(applyAccount);
 async function load(){
  if(busy)return;busy=true;region.setAttribute('aria-busy','true');
  shell(social,'Latest news');message(social,'Loading the latest post…','');
  let timer;
  try{
   if(typeof desktop.homeContent!=='function'){paint(null);return;}
   // One quiet second attempt before the card admits defeat. The first ask of a launch can
   // arrive before the window is trusted, and main answers that with a refusal it never
   // recorded; the second ask lands on a warm answer. A real outage still fails, twice.
   const ask=async()=>Promise.race([desktop.homeContent(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000);})]);
   let payload;
   try{payload=await ask();}
   catch{payload=await new Promise((resolve,reject)=>{setTimeout(()=>{ask().then(resolve,reject);},1200);});}
   if(!payload || payload.schema!==1 || !Array.isArray(payload.posts))throw Error('Invalid content');
   paint(payload);
  }catch{paint(null,true);}finally{clearTimeout(timer);busy=false;region.setAttribute('aria-busy','false');}
 }
 void load();return region;
}
