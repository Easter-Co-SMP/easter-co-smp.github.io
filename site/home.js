const guide=document.getElementById('guide-dialog');
document.getElementById('open-guide').onclick=()=>guide.showModal();
document.getElementById('close-guide').onclick=()=>guide.close();
guide.addEventListener('click',event=>{const r=guide.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)guide.close();});
document.getElementById('copyright-year').textContent=new Date().getFullYear();
fetch('data/client.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(client=>{
 document.getElementById('mod-version').textContent='v'+client.mod.version+' · Fabric';
 document.getElementById('minecraft-version').textContent='Minecraft '+client.minecraft;
 const list=document.getElementById('dependency-list');list.replaceChildren();
 for(const mod of client.dependencies){
  const li=document.createElement('li'),a=document.createElement('a');a.href=mod.url;a.textContent=mod.name+' · '+mod.version;a.target='_blank';a.rel='noopener';li.append(a);list.append(li);
 }
}).catch(()=>{});
fetch('data/world.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(world=>{
 document.getElementById('home-world-date').textContent='World charted '+new Date(world.captured_at).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}).catch(()=>{});
