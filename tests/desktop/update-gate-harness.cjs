const {app}=require('electron');
Object.defineProperty(app,'isPackaged',{value:true});
app.setPath('appData',process.env.EASTER_TEST_HOME);
global.easterUpdaterMode='hold';global.easterUpdaterCalls=0;
require('../../desktop/updater.cjs').update=async({notify})=>{
 global.easterUpdaterCalls++;
 notify({phase:'checking',percent:null,message:'Checking launcher updates…'});
 if(global.easterUpdaterMode==='hold')await new Promise(resolve=>global.easterUpdaterContinue=resolve);
 if(global.easterUpdaterMode!=='current')throw Error('Update service is offline.');
 notify({phase:'current',version:'test',message:null});return null;
};
require('./deslop-harness.cjs');

