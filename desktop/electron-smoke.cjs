const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');
if(process.platform==='linux') app.commandLine.appendSwitch('ozone-platform','headless');
app.commandLine.appendSwitch('disable-gpu');
let finished=false;
const finish=(code,error)=>{if(finished)return;finished=true;if(error)console.error(error.stack||error);for(const win of BrowserWindow.getAllWindows())win.destroy();app.exit(code);};
app.on('web-contents-created',(_event,contents)=>{
 contents.on('console-message',(_event,_level,message)=>{if(String(message).includes('Error'))console.log('Renderer:',message);});
 contents.once('did-finish-load',async()=>{
  try{
   if(contents.getURL()!=='invizent://app/index.html')return;
   const preferences=contents.getLastWebPreferences();if(preferences.nodeIntegration||!preferences.contextIsolation||!preferences.sandbox||!preferences.webSecurity)throw new Error('Unsafe renderer preferences');
   console.log('Smoke: renderer loaded, checking Signal, DPAPI and cache');
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
   console.log('Smoke: bridge checks complete',JSON.stringify(result));
   if(process.platform==='win32'&&!result.protectedVault)throw new Error('Windows DPAPI vault unavailable');
   if(!result.text.trim())throw new Error('UI did not render');
   if(process.platform==='win32') {
    result.capture=[];
    for(const [width,height] of [[1280,720],[1920,1080]]) {
    console.log('Smoke: requesting capture',width,height);
    const picker = new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Screen picker did not open')),20000);
      app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
        try { const ownId=win.getParentWindow().getMediaSourceId();console.log('Smoke: capture picker loaded',ownId);const selected=await win.webContents.executeJavaScript(`(async()=>{const sources=await window.capturePicker.list();const own=sources.find(s=>s.id===${JSON.stringify(ownId)});if(!own)throw new Error('Own test window not available for capture: '+JSON.stringify(sources.map(s=>({id:s.id,name:s.name}))));return own.id;})()`);void win.webContents.executeJavaScript('window.capturePicker.choose('+JSON.stringify(selected)+')').catch(()=>{});clearTimeout(timer);resolve(true); }catch(e){clearTimeout(timer);reject(e);}
      }));
    });
    const capture=contents.executeJavaScript(`(async()=>{
      const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:${width}},height:{ideal:${height}},frameRate:{ideal:60,max:60}},audio:false});
      const track=stream.getVideoTracks()[0],left=new RTCPeerConnection(),right=new RTCPeerConnection();
      const video=document.createElement('video');video.muted=true;video.autoplay=true;video.style.cssText='position:fixed;bottom:0;right:0;width:160px;height:90px';document.body.append(video);
      try {
        await track.applyConstraints({width:${width},height:${height},frameRate:60});
        const sender=left.addTransceiver('video',{direction:'sendrecv'}).sender;right.addTransceiver('video',{direction:'sendrecv'});
        const remote=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Remote screen frame timed out')),15000);right.ontrack=event=>{video.srcObject=new MediaStream([event.track]);void video.play();video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve({width:video.videoWidth,height:video.videoHeight});});};});
        remote.catch(()=>{});
        const gather=pc=>pc.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve();}));
        await left.setLocalDescription(await left.createOffer());await gather(left);await right.setRemoteDescription(left.localDescription);await right.setLocalDescription(await right.createAnswer());await gather(right);await left.setRemoteDescription(right.localDescription);
        await sender.replaceTrack(track);
        const params=sender.getParameters();params.encodings[0].maxFramerate=60;params.encodings[0].maxBitrate=${width===1280?4000000:8000000};await sender.setParameters(params);
        const frame=await remote;return {requested:${width},settings:track.getSettings(),remoteFrame:frame};
      } finally {stream.getTracks().forEach(t=>t.stop());left.close();right.close();video.srcObject=null;video.remove();}
    })()`,true);
    capture.catch(()=>{});await picker;console.log('Smoke: selected capture source');const captured=await capture;result.capture.push(captured);
    if(!captured.remoteFrame.width||!captured.remoteFrame.height)throw new Error('Screen capture returned no remote video frame');
    }
   }
   console.log(JSON.stringify(result));
   const image=await contents.capturePage();fs.writeFileSync(path.join(__dirname,'smoke-screen.png'),image.toPNG());
   finish(0);
  }catch(error){finish(1,error);}
 });
});
setTimeout(()=>finish(1,new Error('Electron startup timed out')),120000).unref();
require('./main.cjs');
