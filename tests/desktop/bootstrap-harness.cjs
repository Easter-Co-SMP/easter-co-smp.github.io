const {app}=require('electron');
Object.defineProperty(app,'isPackaged',{value:true});
app.setPath('appData',process.env.EASTER_TEST_HOME);
require('../../desktop/bootstrap.cjs');
