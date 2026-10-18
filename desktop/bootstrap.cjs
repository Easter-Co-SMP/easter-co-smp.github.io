'use strict';
// This entry stays in the installed package. Updated code lives in a user-owned ASAR.
const {app}=require('electron'),path=require('node:path');
const {selected}=require('./updater.cjs');
const bundled=require('../package.json').version;
const root=path.join(app.getPath('appData'),'Easter Company','launcher-updates');
function inspect(file,manifest){
 const pkg=require(file+'/package.json');
 if(pkg.name!=='easter-company-launcher'||pkg.version!==manifest.version)throw Error('The launcher payload identity is invalid.');
}
const payload=app.isPackaged?selected(root,{bundled,runtime:process.versions.electron,inspect}):null;
if(payload){app.setAppPath(payload);require(payload+'/desktop/main.cjs');}
else require('./main.cjs');
