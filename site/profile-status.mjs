// Routine menu refreshes should not flash a loading row. Slow requests still get
// local, accessible feedback; closing the menu or finishing cancels the pending row.
export function createProfileStatus(host,{delay=500}={}) {
 host.setAttribute('role','status');host.setAttribute('aria-live','polite');host.setAttribute('aria-atomic','true');host.hidden=true;
 let timer=null,active=null;
 const clear=()=>{clearTimeout(timer);timer=null;active=null;host.hidden=true;host.textContent='';};
 return {set(value){
  if(!value){clear();return;}
  active=value;
  if(!host.hidden){host.textContent=active.message||'Refreshing account details…';return;}
  if(timer!==null)return;
  timer=setTimeout(()=>{timer=null;if(active){host.textContent=active.message||'Refreshing account details…';host.hidden=false;}},delay);
 },clear};
}
