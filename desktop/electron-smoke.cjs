const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');
if(process.platform==='linux') app.commandLine.appendSwitch('ozone-platform','headless');
app.commandLine.appendSwitch('disable-gpu');
let finished=false;
const finish=(code,error)=>{if(finished)return;finished=true;if(error)console.error(error.stack||error);app.exit(code);};
app.on('web-contents-created',(_event,contents)=>{
 contents.on('console-message',(_event,_level,message)=>{if(String(message).includes('Error'))console.log('Renderer:',message);});
 contents.once('did-finish-load',async()=>{
  try{
   if(contents.getURL()!=='invizent://app/index.html')return;
   const preferences=contents.getLastWebPreferences();if(preferences.nodeIntegration||!preferences.contextIsolation||!preferences.sandbox||!preferences.webSecurity)throw new Error('Unsafe renderer preferences');
   const result=await contents.executeJavaScript(`(async()=>{
    const bridge=window.invizentDesktop;if(!bridge)throw new Error('Missing isolated preload');
    const a=await bridge.signal.createState('smoke-alice',1),b=await bridge.signal.createState('smoke-bob',1);
    const at=await bridge.signal.trustIdentity(a.state,'smoke-bob',1,b.bundle.identityKey),bt=await bridge.signal.trustIdentity(b.state,'smoke-alice',1,a.bundle.identityKey);
    const {preKeys,...bundle}=b.bundle;
    const encrypted=await bridge.signal.encrypt(at.state,'smoke-bob',1,'electron-signal-smoke',{...bundle,preKey:preKeys[0]});
    const decrypted=await bridge.signal.decrypt(bt.state,'smoke-alice',1,encrypted.type,encrypted.body);
    if(decrypted.plaintext!=='electron-signal-smoke')throw new Error('Signal IPC failed');
    let protectedVault=false;
    try{const id=await bridge.vault.open('smoke-test');await bridge.vault.commit(id,{test:'protected-value'});if(await bridge.vault.get(id,'test')!=='protected-value')throw new Error('Vault mismatch');await bridge.vault.commit(id,{test:null});await bridge.vault.close(id);protectedVault=true;}catch(e){if(${JSON.stringify(process.platform)}==='win32')throw e;}
    for(let i=0;i<30&&!document.body.innerText.trim();i++)await new Promise(resolve=>setTimeout(resolve,500));
    if(typeof window.require==='function'||globalThis.process?.versions?.node||globalThis.process?.versions?.electron)throw new Error('Node leaked into renderer');
    await bridge.files('write',['invizent-cache://local/smoke.txt',new TextEncoder().encode('cache-test')]);
    const bytes=await bridge.files('read',['invizent-cache://local/smoke.txt']);if(new TextDecoder().decode(bytes)!=='cache-test')throw new Error('Cache IPC failed');
    await bridge.files('delete',['invizent-cache://local/smoke.txt']);
    let rejected=false;try{await bridge.files('read',['file:///outside-cache']);}catch{rejected=true;}if(!rejected)throw new Error('Unrestricted filesystem IPC');
    return {signal:true,protectedVault,text:document.body.innerText.slice(0,500)};
   })()`);
   if(process.platform==='win32'&&!result.protectedVault)throw new Error('Windows DPAPI vault unavailable');
   if(!result.text.trim())throw new Error('UI did not render');
   if(process.platform==='win32') {
    const picker = new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Screen picker did not open')),20000);
      app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
        try { const selected=await win.webContents.executeJavaScript(`(async()=>{const sources=await window.capturePicker.list();const own=sources.find(s=>s.name==='Инвиз'||s.name==='INVIZENT');if(!own)throw new Error('Own test window not available for capture');return own.id;})()`);void win.webContents.executeJavaScript('window.capturePicker.choose('+JSON.stringify(selected)+')').catch(()=>{});clearTimeout(timer);resolve(true); }catch(e){clearTimeout(timer);reject(e);}
      }));
    });
    const capture=contents.executeJavaScript(`(async()=>{const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:60,max:60}},audio:false});const settings=stream.getVideoTracks()[0].getSettings();stream.getTracks().forEach(t=>t.stop());return settings;})()`,true);
    capture.catch(()=>{}); await picker; result.capture=await capture;
    if(!result.capture.width||!result.capture.height)throw new Error('Screen capture returned no video settings');
   }
   console.log(JSON.stringify(result));
   const image=await contents.capturePage();fs.writeFileSync(path.join(__dirname,'smoke-screen.png'),image.toPNG());
   finish(0);
  }catch(error){finish(1,error);}
 });
});
setTimeout(()=>finish(1,new Error('Electron startup timed out')),60000).unref();
require('./main.cjs');
