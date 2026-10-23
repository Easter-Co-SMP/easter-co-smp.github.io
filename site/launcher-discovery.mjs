// Presentation only. Main supplies public editorial content; this renderer never buys items.
export function latestPost(posts = []) {
 const seen = new Set();
 return (Array.isArray(posts) ? posts : []).filter(p => {
  if (!p || typeof p.id !== 'string' || seen.has(p.id) || typeof p.title !== 'string' || !p.title.trim() || !Number.isFinite(Date.parse(p.publishedAt))) return false;
  try { const u = new URL(p.url); if (u.protocol !== 'https:' || u.username || u.password) return false; } catch { return false; }
  seen.add(p.id); return true;
 }).sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0] || null;
}
export function featuredItem(item) {
 if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title.trim() || typeof item.description !== 'string') return null;
 return {id:item.id,title:item.title.slice(0,120),description:item.description.slice(0,1600),category:typeof item.category==='string'?item.category.slice(0,40):'Featured item'};
}
const node = (tag, cls, text) => { const el=document.createElement(tag); el.className=cls; if(text)el.textContent=text; return el; };
export function mountDiscovery(host, desktop) {
 const region=node('section','launcher-discovery'); region.setAttribute('aria-label','From Easter Company');
 const social=node('article','discovery-card social-card'), store=node('article','discovery-card store-card');
 region.append(social,store);host.append(region);
 let busy=false;
 function shell(card,label) {card.replaceChildren();card.append(node('p','discovery-label',label));}
 function message(card,title,body) {card.append(node('h2','discovery-title',title));if(body)card.append(node('p','discovery-copy',body));}
 function paint(payload,failed=false) {
  shell(social,'Latest news');shell(store,'Community store');
  const post=latestPost(payload?.posts),item=featuredItem(payload?.featuredItem);
  if(post){
   const date=node('time','discovery-date',new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(post.publishedAt)));date.dateTime=post.publishedAt;social.append(date);
   message(social,post.title.slice(0,160),typeof post.excerpt==='string'?post.excerpt.slice(0,360):'');
   const link=node('a','discovery-action','Read post');link.href=post.url;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Read '+post.title.slice(0,160)+' (opens in browser)');social.append(link);
  } else message(social,failed?'News unavailable':'No posts yet',failed?'The latest post couldn’t be loaded. You can keep playing.':'New posts from Easter Company will appear here.');
  if(item){
   store.append(node('span','discovery-category',item.category));message(store,item.title,item.description);
   const view=node('button','discovery-action','Explore item');view.type='button';view.onclick=()=>showItem(item);store.append(view);
   // The store card's own description is gone with the mock. It used to promise a preview with
   // no real charges, which stopped being true when the store became the real one (ticket
   // 45bb99ad); the card names the shop and links to it, and the store page itself is the only
   // place that says what is for sale, because the server is the only place that knows.
  }else message(store,'Explore the Community store','');
  // The store is a page (site/store/), reached by navigation like Map and Wiki, so this card
  // links to it and the launcher never opens it over the app as a dialog.
  const browseStore=node('a','discovery-action','Browse the store');browseStore.href='./store/';store.append(browseStore);
  if(failed && typeof desktop.homeContent==='function'){
   const retry=node('button','discovery-action','Try again');retry.type='button';retry.onclick=load;social.append(retry);
  }
 }
 const dialog=node('dialog','discovery-dialog');dialog.setAttribute('aria-labelledby','store-item-heading');document.body.append(dialog);
 function showItem(item){
  dialog.replaceChildren();const heading=node('h2','',item.title);heading.id='store-item-heading';
  // No notice about purchasing: the launcher's store sells real products now, and this
  // preview names an editorial highlight, not an offer (doc/launcher-discovery.md).
  dialog.append(node('p','discovery-label',item.category),heading,node('p','discovery-copy',item.description));
  const close=node('button','discovery-action','Back to launcher');close.type='button';close.onclick=()=>dialog.close();dialog.append(close);dialog.showModal();
 }
 async function load(){
  if(busy)return;busy=true;region.setAttribute('aria-busy','true');
  shell(social,'Latest news');message(social,'Loading the latest post…','');shell(store,'Community store');message(store,'Loading featured item…','');
  let timer;
  try{
   if(typeof desktop.homeContent!=='function'){paint(null);return;}
   // One quiet second attempt before the cards admit defeat. The first ask of a launch can
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
