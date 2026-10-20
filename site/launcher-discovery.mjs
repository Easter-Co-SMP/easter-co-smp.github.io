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
 function shell(card,label,mark) {card.replaceChildren();card.append(node('p','discovery-label',label),node('div','discovery-mark',mark));card.lastChild.setAttribute('aria-hidden','true');}
 function message(card,title,body) {card.append(node('h2','discovery-title',title),node('p','discovery-copy',body));}
 function paint(payload,failed=false) {
  shell(social,'The latest dispatch','↗');shell(store,'The Company store','◇');
  const post=latestPost(payload?.posts),item=featuredItem(payload?.featuredItem);
  if(post){
   const date=node('time','discovery-date',new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(post.publishedAt)));date.dateTime=post.publishedAt;social.append(date);
   message(social,post.title.slice(0,160),typeof post.excerpt==='string'?post.excerpt.slice(0,360):'');
   const link=node('a','discovery-action','Read post ↗');link.href=post.url;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Read '+post.title.slice(0,160)+' (opens in browser)');social.append(link);
  } else message(social,failed?'Dispatches unavailable':'Around the Company',failed?'The latest post couldn’t be loaded. You can keep playing.':'New posts from Easter Company will appear here.');
  if(item){
   store.append(node('span','discovery-category',item.category));message(store,item.title,item.description);
   const view=node('button','discovery-action','Explore item →');view.type='button';view.onclick=()=>showItem(item);store.append(view);
  }else message(store,'Something worth discovering',failed?'Store highlights couldn’t be loaded. Check back later.':'Featured items will appear here when the Company store opens.');
  if(failed && typeof desktop.homeContent==='function'){
   const retry=node('button','discovery-action','Try again');retry.type='button';retry.onclick=load;social.append(retry);
  }
 }
 const dialog=node('dialog','discovery-dialog');dialog.setAttribute('aria-labelledby','store-item-heading');document.body.append(dialog);
 function showItem(item){
  dialog.replaceChildren();const heading=node('h2','',item.title);heading.id='store-item-heading';
  dialog.append(node('p','discovery-label',item.category),heading,node('p','discovery-copy',item.description),node('p','discovery-store-note','Item preview. Purchasing is not available in this launcher yet.'));
  const close=node('button','discovery-action','Back to launcher');close.type='button';close.onclick=()=>dialog.close();dialog.append(close);dialog.showModal();
 }
 async function load(){
  if(busy)return;busy=true;region.setAttribute('aria-busy','true');
  shell(social,'The latest dispatch','↗');message(social,'Loading the latest post…','');shell(store,'The Company store','◇');message(store,'Loading featured item…','');
  let timer;
  try{
   if(typeof desktop.homeContent!=='function'){paint(null);return;}
   const payload=await Promise.race([desktop.homeContent(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000);})]);
   if(!payload || payload.schema!==1 || !Array.isArray(payload.posts))throw Error('Invalid content');
   paint(payload);
  }catch{paint(null,true);}finally{clearTimeout(timer);busy=false;region.setAttribute('aria-busy','false');}
 }
 void load();return region;
}
