// One release selector for both navigation and hero; replace the dummy URLs with real builds.
const placeholderLauncher=new URL('assets/launcher-placeholder.txt',document.currentScript.src).href;
const launcherBuilds=[
 {id:'windows',name:'Windows 10+',detail:'Windows · x64',icon:'▦',url:placeholderLauncher},
 {id:'ubuntu',name:'Ubuntu',detail:'Ubuntu Linux',icon:'◉',url:placeholderLauncher},
 {id:'arch',name:'Arch',detail:'Arch Linux',icon:'△',url:placeholderLauncher},
 {id:'appimage',name:'AppImage',detail:'Portable Linux client',icon:'◇',url:placeholderLauncher},
 {id:'source',name:'Source',detail:'Launcher source code',icon:'⌘',url:placeholderLauncher},
];
// Browsers identify Windows and Linux, but not Linux distributions reliably.
const clientPlatform=navigator.userAgentData?.platform||navigator.platform||navigator.userAgent;
const automaticBuild=launcherBuilds.find(build=>build.id===(/win/i.test(clientPlatform)?'windows':/linux/i.test(clientPlatform)?'appimage':null));
const platformLabel=document.getElementById('launcher-platform');
if(platformLabel)platformLabel.textContent=automaticBuild?.detail||'Choose your platform';
const downloadMenu=document.createElement('div');
downloadMenu.id='launcher-downloads';downloadMenu.popover='auto';downloadMenu.className='launcher-downloads';downloadMenu.setAttribute('aria-label','Download Easter Company launcher');downloadMenu.tabIndex=-1;
const menuTitle=document.createElement('p');menuTitle.className='download-menu-title';menuTitle.textContent='Easter Company';
const menuHeading=document.createElement('h2');menuHeading.textContent='Choose your platform';downloadMenu.append(menuTitle,menuHeading);
for(const build of launcherBuilds){
 const item=document.createElement(build.url?'a':'button');item.className='platform-download';item.dataset.platform=build.id;if(build===automaticBuild)item.classList.add('recommended-platform');
 if(build.url){item.href=build.url;item.download='Easter-Company-'+build.id+'-placeholder.txt';item.addEventListener('click',event=>{event.preventDefault();startLauncherDownload(build);});}else{item.type='button';item.disabled=true;}
 const icon=document.createElement('span');icon.className='platform-icon';icon.textContent=build.icon;icon.setAttribute('aria-hidden','true');
 const label=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=build.name;detail.textContent=build.detail;label.append(name,detail);
 const arrow=document.createElement('span');arrow.className='platform-arrow';arrow.textContent='↓';arrow.setAttribute('aria-hidden','true');item.append(icon,label,arrow);downloadMenu.append(item);
}
document.body.append(downloadMenu);
const setupDialog=document.createElement('dialog');setupDialog.id='launcher-setup';setupDialog.setAttribute('aria-labelledby','launcher-setup-title');
setupDialog.innerHTML='<button type="button" class="dialog-close" aria-label="Close setup instructions">×</button><p class="eyebrow">Easter Company launcher</p><h2 id="launcher-setup-title">Setup &amp; Install</h2><p class="setup-download-note"></p><p>These setup instructions are a placeholder for the release installer.</p><ol class="install-steps"><li><strong>Install the launcher.</strong><span>Open the installer and follow the setup steps.</span></li><li><strong>Make yourself at home.</strong><span>Sign in with your Minecraft account and select the Easter Company client.</span></li><li><strong>Set sail.</strong><span>Launch Minecraft and join your crew on the Easter Isles.</span></li></ol>';
document.body.append(setupDialog);
setupDialog.querySelector('.dialog-close').addEventListener('click',()=>setupDialog.close());
setupDialog.addEventListener('click',event=>{const rect=setupDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)setupDialog.close();});
function startLauncherDownload(build){
 const link=document.createElement('a');link.href=build.url;link.download='Easter-Company-'+build.id+'-placeholder.txt';document.body.append(link);link.click();link.remove();
 if(downloadMenu.matches(':popover-open'))downloadMenu.hidePopover();
 setupDialog.querySelector('.setup-download-note').textContent=build.name+' download started. This is a dummy text file for testing the download flow.';
 if(!setupDialog.open)setupDialog.showModal();
}

let downloadTrigger;
const positionDownloads=()=>{
 if(!downloadTrigger||!downloadMenu.matches(':popover-open'))return;
 const rect=downloadTrigger.getBoundingClientRect(),width=downloadMenu.offsetWidth,height=downloadMenu.offsetHeight;
 const left=Math.max(12,Math.min(rect.left,innerWidth-width-12));
 const top=rect.bottom+10+height<=innerHeight-12?rect.bottom+10:Math.max(12,rect.top-height-10);
 downloadMenu.style.left=left+'px';downloadMenu.style.top=top+'px';
};
for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]')){
 trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');
 trigger.addEventListener('click',event=>{event.preventDefault();downloadTrigger=trigger;downloadMenu.togglePopover({source:trigger});positionDownloads();});
}
downloadMenu.setAttribute('role','dialog');
downloadMenu.addEventListener('toggle',event=>{
 const open=event.newState==='open';
 for(const trigger of document.querySelectorAll('[popovertarget="launcher-downloads"]'))trigger.setAttribute('aria-expanded',String(open&&trigger===downloadTrigger));
 if(open){positionDownloads();downloadMenu.focus({preventScroll:true});}
});
document.querySelector('[data-download-primary]')?.addEventListener('click',event=>{
 if(automaticBuild?.url){startLauncherDownload(automaticBuild);return;}
 // Without a published build URL, show the platform selector rather than a broken download.
 downloadTrigger=event.currentTarget;downloadMenu.showPopover({source:downloadTrigger});positionDownloads();
});
window.addEventListener('resize',positionDownloads,{passive:true});
window.addEventListener('scroll',positionDownloads,{passive:true});
