import {openStore} from './store.mjs';
const trigger=document.getElementById('open-store'),status=document.getElementById('preview-status');
function open(){
 try{status.hidden=true;const store=openStore();store.element.addEventListener('close',()=>trigger.focus(),{once:true});}
 catch{status.hidden=false;status.textContent='The preview could not be opened. Refresh the page and try again.';}
}
trigger.addEventListener('click',open);
// A shared link opens straight into the same mock storefront as the launcher.
open();
