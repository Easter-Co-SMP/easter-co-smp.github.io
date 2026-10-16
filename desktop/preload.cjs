'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args).then(result=>{if(!result.ok)throw Error(result.error);return result.value;});
contextBridge.exposeInMainWorld('easterDesktop',Object.freeze({
 mode:'desktop',
 status:invoke('status'),signIn:invoke('sign-in'),cancelSignIn:invoke('cancel-sign-in'),
 signOut:invoke('sign-out'),switchAccount:invoke('switch-account'),play:invoke('play'),saveSettings:invoke('settings'),
 refreshAccount:invoke('account-refresh'),signOutAccount:invoke('account-sign-out'),
 chooseJava:invoke('choose-java'),openFolder:invoke('open-folder'),openMicrosoft:invoke('open-microsoft'),
 // Download-first flow. The location handlers take no renderer path: the picker
 // returns one, and every other request is checked against the saved setting.
 chooseLocation:invoke('choose-location'),setLocation:invoke('set-location'),startInstall:invoke('start-install'),
 pauseInstall:invoke('pause-install'),resumeInstall:invoke('resume-install'),cancelInstall:invoke('cancel-install'),
 checkUpdates:invoke('check-updates'),
 // Enhanced Graphics & Shaders: one boolean, and the main process decides what
 // that means for the client. The renderer still gets no path and no command.
 setGraphics:invoke('set-graphics'),
 onState(callback){const listener=(_event,state)=>callback(state);ipcRenderer.on('launcher:state',listener);return ()=>ipcRenderer.removeListener('launcher:state',listener);}
}));
