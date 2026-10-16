'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args).then(result=>{if(!result.ok)throw Error(result.error);return result.value;});
contextBridge.exposeInMainWorld('easterDesktop',Object.freeze({
 mode:'desktop',
 status:invoke('status'),signIn:invoke('sign-in'),cancelSignIn:invoke('cancel-sign-in'),
 signOut:invoke('sign-out'),play:invoke('play'),saveSettings:invoke('settings'),
 refreshAccount:invoke('account-refresh'),signOutAccount:invoke('account-sign-out'),
 chooseJava:invoke('choose-java'),openFolder:invoke('open-folder'),openMicrosoft:invoke('open-microsoft'),
 onState(callback){const listener=(_event,state)=>callback(state);ipcRenderer.on('launcher:state',listener);return ()=>ipcRenderer.removeListener('launcher:state',listener);}
}));
