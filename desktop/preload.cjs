'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args).then(result=>{if(!result.ok){const error=Error(result.error);error.code=result.code;throw error;}return result.value;});
// An Error crosses the isolated-world boundary as its message and stack only, so a typed
// refusal code is lost on the way. The account actions therefore answer with their whole
// result instead of throwing: the dialog needs the code to know whether a taken username
// sends the player back to step 1 or an expired session needs Microsoft again.
//
// The saved Microsoft session is one of those actions. An identity conflict is a refusal
// the sign-in dialog has to recognise by its code — it is the one failure that stops the
// flow instead of falling through to the interactive sign-in — so continue-microsoft
// answers with the whole result too. Throwing it would hand the renderer a message with no
// code, and the stop could never fire: that is how a conflicting Microsoft account once
// replaced the signed-in Easter Company account without a word.
const invokeResult=channel=>(...args)=>ipcRenderer.invoke('launcher:'+channel,...args);
contextBridge.exposeInMainWorld('easterDesktop',Object.freeze({
 mode:'desktop',
 status:invoke('status'),signIn:invoke('sign-in'),cancelSignIn:invoke('cancel-sign-in'),
 // The account actions. No Company ID is ever returned by them: company-login carries the
 // identifier the player typed and the username travels only on the call that claims it.
 // An email address comes back from exactly one of them, the owner-only profile read, and
 // never from the state broadcast.
 // The saved-session shortcut. It answers with its result for the same reason: the
 // identity conflict is decided on its code, and a code cannot be thrown across this
 // boundary.
 continueMicrosoft:invokeResult('continue-microsoft'),loginCompany:invokeResult('company-login'),
 checkCompanyUsername:invokeResult('company-username-check'),setCompanyPassword:invokeResult('company-password'),
 // The profile's verified emails. Owner-only, on demand, and never part of the state
 // broadcast: the list is asked for when the profile section opens, and the selection
 // answers with the whole result because a refusal carries its own code and sentence.
 profileEmails:invoke('profile-emails'),selectLoginEmail:invokeResult('login-email'),
 accountProviders:invoke('account-providers'),signInProvider:invokeResult('provider-sign-in'),updateProfile:invokeResult('profile-update'),setProfilePicture:invokeResult('profile-picture'),
 signOut:invoke('sign-out'),play:invoke('play'),saveSettings:invoke('settings'),
 openMinecraftStore:invoke('open-minecraft-store'),openMinecraftProfile:invoke('open-minecraft-profile'),recheckAccess:invoke('recheck-access'),
 refreshAccount:invoke('account-refresh'),signOutAccount:invoke('account-sign-out'),
 // "Sign out of Minecraft everywhere": the player's own control over the one Microsoft
 // session their Easter Company account stores, so it ends on every machine. It takes no
 // argument — the account and the session come from this process — and it answers with the
 // sentence the profile dialog prints, which says only what the launcher actually saw.
 signOutMinecraft:invoke('sign-out-minecraft'),
 // The hero's retry when the account service could not make a Minecraft session just now. It
 // asks the service once more and answers with the session field, never with a token.
 refreshMinecraftSession:invoke('minecraft-session'),
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
