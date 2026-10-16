// One release selector for both navigation and hero.
const releaseRoot='https://github.com/Easter-Co-SMP/easter-co-smp.github.io/releases/latest/download/';
const launcherBuilds=[
 {id:'windows',name:'Windows 10+',detail:'Windows · x64',icon:'windows',file:'Easter-Company-Windows-x64.exe'},
 {id:'ubuntu',name:'Ubuntu',detail:'Ubuntu Linux',icon:'ubuntu',file:'Easter-Company-Linux-amd64.deb'},
 {id:'arch',name:'Arch',detail:'Arch Linux',icon:'arch',file:'Easter-Company-Linux-x64.pacman'},
 {id:'appimage',name:'AppImage',detail:'Portable Linux launcher',icon:'linux',file:'Easter-Company-Linux-x86_64.AppImage'},
].map(build=>({...build,url:releaseRoot+build.file}));
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
 if(build.url){item.href=build.url;item.download=build.file;item.addEventListener('click',event=>{event.preventDefault();startLauncherDownload(build);});}else{item.type='button';item.disabled=true;}
 const icon=document.createElement('img');icon.className='platform-icon';icon.src=new URL('assets/os/'+build.icon+'.png',document.querySelector('script[src$="downloads.js"]').src).href;icon.alt='';icon.setAttribute('aria-hidden','true');
 const label=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=build.name;detail.textContent=build.detail;label.append(name,detail);
 const arrow=document.createElement('span');arrow.className='platform-arrow';arrow.textContent='↓';arrow.setAttribute('aria-hidden','true');item.append(icon,label,arrow);downloadMenu.append(item);
}
const iconCredit=document.createElement('a');iconCredit.href='https://icons8.com/icons';iconCredit.target='_blank';iconCredit.rel='noopener';iconCredit.className='download-icon-credit';iconCredit.textContent='OS icons by Icons8';downloadMenu.append(iconCredit);
document.body.append(downloadMenu);
const setupDialog=document.createElement('dialog');setupDialog.id='launcher-setup';setupDialog.setAttribute('aria-labelledby','launcher-setup-title');
setupDialog.innerHTML='<button type="button" class="dialog-close" aria-label="Close setup instructions">×</button><h2 id="launcher-setup-title">Setup &amp; Install</h2><p class="setup-download-note"></p><div class="setup-instructions"></div>';
document.body.append(setupDialog);
setupDialog.querySelector('.dialog-close').addEventListener('click',()=>setupDialog.close());
setupDialog.addEventListener('click',event=>{const rect=setupDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)setupDialog.close();});
function setupInstructions(build){
 const file=build.file,download='"$HOME/Downloads/'+file+'"';
 const command=text=>'<pre><code>'+text+'</code></pre>';
 const next='<li><strong>Install Minecraft.</strong> In Easter Company, choose Download the game, check the installation folder, then select Start download. Java and the required mods are included.</li><li><strong>Sign in and play.</strong> Select Sign in with Microsoft, open the Microsoft page and enter the displayed code. Use an account that owns Minecraft Java Edition. Once installation and sign-in finish, select PLAY NOW.</li>';
 const pathNote='<p>Commands assume the file is in your Downloads folder with the name shown. If your browser renamed it or saved it elsewhere, substitute its actual path. Keep paths in quotes.</p>';
 let steps='';
 if(build.id==='windows')steps='<li><strong>Run the installer.</strong> Open Downloads in File Explorer and double-click <code>'+file+'</code>. Choose the installation folder and shortcut options, then finish setup. This release is unsigned; Windows may show a publisher warning. Check that the file came from the Easter-Co-SMP GitHub release before choosing to run it.</li><li><strong>Open Easter Company.</strong> Use its Start menu entry or desktop shortcut.</li>';
 if(build.id==='ubuntu')steps='<li><strong>Install the .deb.</strong> On Ubuntu, Debian or Linux Mint, open a terminal and run:'+command('sudo apt update\nsudo apt install '+download)+'APT installs the package and its dependencies. Enter your Linux password when asked; terminal password entry is invisible.</li><li><strong>Open Easter Company.</strong> Find it in your applications menu, or run <code>easter-company</code>. The .deb does not need FUSE.</li>';
 if(build.id==='arch')steps='<li><strong>Install the package.</strong> On Arch Linux or a compatible distribution, open a terminal and run:'+command('sudo pacman -U '+download)+'Review the dependency list and confirm installation.</li><li><strong>Open Easter Company.</strong> Find it in your applications menu, or run <code>easter-company</code>. The pacman package does not need FUSE.</li>';
 if(build.id==='appimage')steps='<li><strong>Allow execution and run.</strong> An AppImage is portable. Keep it in a permanent folder if you move it out of Downloads.'+command('chmod +x '+download+'\n'+download)+'Alternatively, enable “Allow executing file as program” in file properties, then double-click it. Run the launcher as your normal user.</li><li><strong>If it reports missing FUSE or libfuse.so.2:</strong> Install the FUSE 2 library for your distribution below, then run the AppImage again. FUSE 3 alone does not provide libfuse.so.2.<dl class="fuse-packages"><dt>Ubuntu 24.04+ / Debian 13+ / Linux Mint 22+</dt><dd>'+command('sudo apt update\nsudo apt install libfuse2t64')+'</dd><dt>Ubuntu 22.04 / Debian 12 / Linux Mint 21</dt><dd>'+command('sudo apt update\nsudo apt install libfuse2')+'</dd><dt>Arch / EndeavourOS / Manjaro</dt><dd>'+command('sudo pacman -S fuse2')+'</dd><dt>Fedora</dt><dd>'+command('sudo dnf install fuse fuse-libs')+'</dd><dt>openSUSE</dt><dd>'+command('sudo zypper install fuse libfuse2')+'</dd></dl>On Ubuntu and Debian, install the library above alongside FUSE 3; do not replace FUSE 3 with the older fuse package. For other distributions, use their FUSE 2 package instructions. If Ubuntu reports an AppArmor or sandbox error instead, use the Ubuntu .deb package.</li><li><strong>Without FUSE:</strong> Try the runtime’s extraction mode:'+command(download+' --appimage-extract-and-run')+'See the <a href="https://docs.appimage.org/user-guide/troubleshooting/fuse.html" target="_blank" rel="noopener">AppImage FUSE guide</a> for manual extraction and troubleshooting.</li>';
 return (build.id==='windows'?'':pathNote)+'<ol class="install-steps">'+steps+next+'</ol>';
}
function startLauncherDownload(build){
 const link=document.createElement('a');link.href=build.url;link.download=build.file;document.body.append(link);link.click();link.remove();
 if(downloadMenu.matches(':popover-open'))downloadMenu.hidePopover();
 setupDialog.querySelector('.setup-download-note').textContent=build.name+' download requested. Your browser will handle the file transfer.';
 setupDialog.querySelector('.setup-instructions').innerHTML=setupInstructions(build);
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
