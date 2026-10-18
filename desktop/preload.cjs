'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args).then(result=>{if(!result.ok){const error=Error(result.error);error.code=result.code;throw error;}return result.value;});
// An Error crosses the isolated-world boundary as its message and stack only, so a typed
// refusal code is lost on the way. The account actions therefore answer with their whole
// result instead of throwing: the dialog needs the code to know whether a taken username
// sends the player back to step 1 or an expired session needs Microsoft again.
const invokeResult=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args);
contextBridge.exposeInMainWorld('easterDesktop',Object.freeze({
 mode:'desktop',
 status:invoke('status'),signIn:invoke('sign-in'),cancelSignIn:invoke('cancel-sign-in'),
 // The account actions. No Company ID is ever returned by them: company-login carries the
 // identifier the player typed and the username travels only on the call that claims it.
 // An email address comes back from exactly one of them, the owner-only profile read, and
 // never from the state broadcast.
 continueMicrosoft:invoke('continue-microsoft'),loginCompany:invokeResult('company-login'),
 checkCompanyUsername:invokeResult('company-username-check'),setCompanyPassword:invokeResult('company-password'),
 // The profile's verified emails. Owner-only, on demand, and never part of the state
 // broadcast: the list is asked for when the profile section opens, and the selection
 // answers with the whole result because a refusal carries its own code and sentence.
 profileEmails:invoke('profile-emails'),selectLoginEmail:invokeResult('login-email'),
 signOut:invoke('sign-out'),switchAccount:invoke('switch-account'),play:invoke('play'),saveSettings:invoke('settings'),
 openMinecraftStore:invoke('open-minecraft-store'),openMinecraftProfile:invoke('open-minecraft-profile'),recheckAccess:invoke('recheck-access'),
 refreshAccount:invoke('account-refresh'),signOutAccount:invoke('account-sign-out'),
 chooseJava:invoke('choose-java'),openFolder:invoke('open-folder'),openMicrosoft:invoke('open-microsoft'),
 // Download-first flow. The location handlers take no renderer path: the picker
 // returns one, and every other request is checked against the saved setting.
 chooseLocation:invoke('choose-location'),setLocation:invoke('set-location'),startInstall:invoke('start-install'),
 pauseInstall:invoke('pause-install'),resumeInstall:invoke('resume-install'),cancelInstall:invoke('cancel-install'),
 checkUpdates:invoke('check-updates'),retryUpdates:invoke('retry-updates'),
 // Enhanced Graphics & Shaders: one boolean, and the main process decides what
 // that means for the client. The renderer still gets no path and no command.
 setGraphics:invoke('set-graphics'),
 onState(callback){const listener=(_event,state)=>callback(state);ipcRenderer.on('launcher:state',listener);return ()=>ipcRenderer.removeListener('launcher:state',listener);}
}));
