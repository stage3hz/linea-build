const { app, BrowserWindow, ipcMain, protocol, net, session, safeStorage, desktopCapturer, dialog, shell } = require('electron');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createUpdater } = require('./update.cjs');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'invizent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }, { scheme: 'invizent-cache', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window, cacheRoot, picker = null, capture = null;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
const cachePath = uri => { const url = new URL(uri); if (url.protocol !== 'invizent-cache:' || url.hostname !== 'local') throw new Error('Invalid cache URI'); const target=path.resolve(cacheRoot,'.'+decodeURIComponent(url.pathname)); if (target !== cacheRoot && !target.startsWith(cacheRoot+path.sep)) throw new Error('Invalid cache path'); return target; };
const vaults = new Map(), scopes = new Map(), requests = new Map();
const update = createUpdater({ tempDir: () => app.getPath('temp') });
const ready = Promise.all([import('./signal.mjs'), import('./vault.mjs')]);
const trusted = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('invizent://app/');
async function vault(scope) {
  if (typeof scope !== 'string' || scope.length > 2048) throw new Error('Invalid scope');
  if (!scopes.has(scope)) scopes.set(scope, ready.then(([,v]) => v.openDesktopVault(path.join(app.getPath('userData'),'private'), scope, safeStorage)).catch(e => { scopes.delete(scope); throw e; }));
  return scopes.get(scope);
}
ipcMain.handle('capture-sources',event=>{
  if(event.sender!==picker?.webContents)throw new Error('Untrusted capture picker');
  return [...capture.sources.values()].map(source=>({id:source.id,name:source.name,image:source.thumbnail.toDataURL()}));
});
ipcMain.handle('capture-choose',(event,id)=>{
  if(event.sender!==picker?.webContents)throw new Error('Untrusted capture picker');
  const source=capture.sources.get(id),callback=capture.callback;capture=null;picker.close();picker=null;
  callback(source?{video:source}:{});
});
ipcMain.handle('invizent', async (event, method, ...args) => {
  if (!trusted(event)) throw new Error('Untrusted IPC sender');
  if (method === 'saveFile') {
    const file=cachePath(args[0]), name=path.basename(String(args[1])).replace(/[<>:"|?*\x00-\x1f]/g,'_');
    const result=await dialog.showSaveDialog(window,{defaultPath:name});if(!result.canceled&&result.filePath)await fs.copyFile(file,result.filePath);return;
  }
  if (method === 'openFile') {
    const file=cachePath(args[0]); if(!['.pdf','.txt','.md','.csv','.rtf','.docx','.xlsx','.pptx'].includes(path.extname(file).toLowerCase()))return false;
    const answer=await dialog.showMessageBox(window,{message:'Открыть документ в системном приложении?',detail:path.basename(file),buttons:['Отмена','Открыть'],defaultId:0,cancelId:0});
    return answer.response===1 ? (await shell.openPath(file)) === '' : false;
  }
  if (method === 'files') {
    const [operation, parameters] = args; if (!Array.isArray(parameters)) throw new Error('Invalid file operation');
    const file = cachePath(parameters[0]);
    if (operation === 'info') { try { const info=await fs.stat(file); return {exists:true,isDirectory:info.isDirectory(),size:info.size,uri:parameters[0]}; } catch(e) {if(e.code==='ENOENT')return {exists:false};throw e;} }
    if (operation === 'read') { if((await fs.stat(file)).size>32*1024*1024)throw new Error('Read file in chunks'); const bytes=await fs.readFile(file); return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength); }
    if (operation === 'write') { if (!(parameters[1] instanceof Uint8Array) || parameters[1].length>32*1024*1024) throw new Error('Invalid cache write'); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,parameters[1],{mode:0o600}); return; }
    if (operation === 'append') { if (!(parameters[1] instanceof Uint8Array) || parameters[1].length>8*1024*1024) throw new Error('Invalid cache append'); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.appendFile(file,parameters[1],{mode:0o600}); return; }
    if (operation === 'mkdir') return fs.mkdir(file,{recursive:true});
    if (operation === 'delete') { if(file===cacheRoot)throw new Error('Cannot delete cache root'); return fs.rm(file,{recursive:true,force:true}); }
    if (operation === 'list') return fs.readdir(file);
    throw new Error('Invalid cache operation');
  }
  if (method === 'cancelRequest') { requests.get(args[0])?.abort(); return; }
  if (method === 'request') {
    const [id, request] = args, url = new URL(request.url);
    if (url.protocol !== 'https:' || !['api.invizent.com','141-133-194-51.nip.io'].includes(url.host) || url.username || url.password || typeof id !== 'string' || requests.has(id)) throw new Error('Invalid API request');
    if (request.body && (!(request.body instanceof ArrayBuffer) || request.body.byteLength > 32*1024*1024)) throw new Error('Request too large');
    const controller = new AbortController(); requests.set(id, controller);
    try {
      const headers = new Headers(request.headers); headers.delete('origin'); headers.delete('host');
      const response = await fetch(url, { method: request.method, headers, body: request.body ? new Uint8Array(request.body) : undefined, signal: controller.signal, redirect: 'error' });
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > 32*1024*1024) { controller.abort(); throw new Error('Response too large; use ranged download'); } chunks.push(chunk); }
      const body = Buffer.concat(chunks); return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength) };
    } finally { requests.delete(id); }
  }
  if (method === 'signal') {
    const [name, parameters] = args, [{ desktopSignalBridge }] = await ready;
    if (!['createState','replenish','trustIdentity','encrypt','decrypt','seal','open'].includes(name) || !Array.isArray(parameters) || parameters.length > 7) throw new Error('Invalid Signal operation');
    if (parameters.some(v => typeof v === 'string' && v.length > 40 * 1024 * 1024)) throw new Error('Signal input too large');
    return desktopSignalBridge[name](...parameters);
  }
  if (method === 'vaultOpen') { const id = randomUUID(); vaults.set(id, await vault(args[0])); return id; }
  if (method === 'vaultGet' || method === 'vaultCommit' || method === 'vaultClose') {
    const [id, value] = args, store = vaults.get(id); if (!store) throw new Error('Vault closed');
    if (method === 'vaultGet') { if (typeof value !== 'string') throw new Error('Invalid key'); return store.get(value); }
    if (method === 'vaultCommit') { if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid commit'); return store.commit(value); }
    // Vault instances are shared across account services; a renderer handle closes independently.
    vaults.delete(id); return;
  }
  if (method === 'updateDownload') return update.download(args[0], args[1], args[2]);
  if (method === 'updateProgress') return update.progress();
  if (method === 'updateCancel') { update.cancel(); return; }
  if (method === 'updateInstall') {
    const file = update.verifiedFile();
    if (!file) throw new Error('No verified update to install');
    const problem = await shell.openPath(file);
    if (problem) throw new Error(problem);
    setTimeout(() => app.quit(), 1500); // the installer replaces the running app
    return true;
  }
  if (method === 'tokenRead') return (await vault('invizent:desktop:session')).get('token');
  if (method === 'tokenWrite') { if (args[0] !== null && typeof args[0] !== 'string') throw new Error('Invalid token'); return (await vault('invizent:desktop:session')).commit({ token: args[0] }); }
  throw new Error('Unknown desktop operation');
});
app.whenReady().then(async () => {
  const dist = path.join(__dirname,'dist');
  cacheRoot=path.join(app.getPath('userData'),'media-cache'); await fs.mkdir(cacheRoot,{recursive:true});
  protocol.handle('invizent-cache',async request => { try {const response=await net.fetch(pathToFileURL(cachePath(request.url)).href,{headers:request.headers});const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','invizent://app');return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}catch{return new Response('',{status:404});} });
  protocol.handle('invizent', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('', { status: 403 });
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('', { status: 400 }); }
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep)) return new Response('', { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(file).href);
      const headers=new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' invizent-cache: https: data: blob:; media-src 'self' invizent-cache: https: blob: data:; connect-src 'self' invizent-cache: https: wss: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'");
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch { return new Response('', { status: 404 }); }
  });
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['wss://api.invizent.com/*','wss://141-133-194-51.nip.io/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId === window?.webContents.id) { delete headers.Origin; delete headers.origin; }
    callback({ requestHeaders: headers });
  });
  session.defaultSession.setPermissionCheckHandler((contents,permission,origin) => contents===window?.webContents && origin.replace(/\/$/,'')==='invizent://app' && ['display-capture','fullscreen','clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window?.webContents || !details.requestingUrl?.startsWith('invizent://app/')) return callback(false);
    if (['display-capture','fullscreen','clipboard-sanitized-write'].includes(permission)) return callback(true);
    if (permission !== 'media') return callback(false);
    const choice = await dialog.showMessageBox(window, { type: 'question', title: 'Инвиз', message: 'Разрешить доступ к микрофону или камере?', buttons: ['Запретить','Разрешить'], defaultId: 0, cancelId: 0 });
    callback(choice.response === 1);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window?.webContents.mainFrame || !request.securityOrigin.startsWith('invizent://app')) return callback({});
    try {
      if(capture)return callback({});
      const sources = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180}});
      capture={sources:new Map(sources.map(source=>[source.id,source])),callback};
      picker=new BrowserWindow({parent:window,modal:true,width:780,height:650,title:'Демонстрация экрана',webPreferences:{preload:path.join(__dirname,'capture-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
      picker.on('closed',()=>{if(capture){const done=capture.callback;capture=null;done({});}picker=null;});
      picker.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      picker.webContents.on('will-navigate',event=>event.preventDefault());
      await picker.loadURL('invizent://app/capture.html');
    } catch { callback({}); }
  }, { useSystemPicker: process.platform === 'darwin' });
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 850, minHeight: 600, title: 'Инвиз', webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('invizent://app/')) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) void shell.openExternal(url); return { action: 'deny' }; });
  await window.loadURL('invizent://app/index.html');
});
app.on('window-all-closed', () => app.quit());

}
