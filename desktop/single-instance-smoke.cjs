const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const os=require('node:os'),path=require('node:path');
const second=process.argv.includes('--second-instance-test');
const profile=process.env.INVIZENT_INSTANCE_TEST_PROFILE||mkdtempSync(path.join(os.tmpdir(),'invizent-instance-'));
app.setPath('userData',profile);app.setName('invizent-instance-test');
if(process.platform==='linux')app.commandLine.appendSwitch('ozone-platform','headless');
app.commandLine.appendSwitch('disable-gpu');
if(!second){
 let notified=false,child;
 const finish=(code,error)=>{if(error)console.error(error);child?.kill();BrowserWindow.getAllWindows().forEach(w=>w.destroy());app.exit(code);};
 app.on('second-instance',()=>{notified=true;});
 app.on('web-contents-created',(_event,contents)=>contents.once('did-finish-load',()=>{
  if(contents.getURL()!=='invizent://app/index.html')return;
  const flags=process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[];
  child=spawn(process.execPath,[...flags,__filename,'--second-instance-test'],{env:{...process.env,INVIZENT_INSTANCE_TEST_PROFILE:profile},stdio:'ignore'});
  child.on('error',error=>finish(1,error));
  child.on('exit',code=>{const valid=code===0&&notified&&BrowserWindow.getAllWindows().length===1;console.log(JSON.stringify({secondInstanceExited:code,existingWindowNotified:notified,windows:BrowserWindow.getAllWindows().length}));finish(valid?0:1);});
 }));
 setTimeout(()=>finish(1,new Error('Second instance failed to exit')),15000).unref();
 app.on('will-quit',()=>{try{rmSync(profile,{recursive:true,force:true});}catch{}});
}
require('./main.cjs');
