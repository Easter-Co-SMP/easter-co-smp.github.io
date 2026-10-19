// A stable, quiet status line. Only stage changes and the one long-wait threshold
// write text: transfer broadcasts never reset selection, focus or announcements.
export function createWaitFeedback(host){
 host.classList.add('wait-feedback');host.setAttribute('role','status');host.setAttribute('aria-live','polite');host.setAttribute('aria-atomic','true');
 const mark=document.createElement('span');mark.className='wait-feedback-mark';mark.setAttribute('aria-hidden','true');
 const copy=document.createElement('span'),message=document.createElement('span'),detail=document.createElement('small');
 const reassurance=document.createElement('small');reassurance.textContent='Still working. You can leave this open.';
 copy.append(message,detail,reassurance);host.replaceChildren(mark,copy);host.hidden=true;
 let active=null,timer=null;
 const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
 const tick=()=>{const long=active&&Date.now()-active.startedAt>=10000;const extra=active?.detail||'';text(detail,extra);detail.hidden=!extra;reassurance.style.visibility=long?'visible':'hidden';};
 return {set(value){
  if(!value){active=null;host.hidden=true;clearTimeout(timer);timer=null;return;}
  const start=Number.isFinite(value.startedAt)?value.startedAt:active?.startedAt||Date.now();
  active={...value,startedAt:start};host.hidden=false;text(message,value.message||'Working…');tick();
  clearTimeout(timer);timer=Date.now()-start<10000?setTimeout(tick,Math.max(1,10000-(Date.now()-start))):null;
 },clear(){this.set(null);}};
}
