const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('invizent', method, ...args);
contextBridge.exposeInMainWorld('invizentDesktop', Object.freeze({
  saveFile: (uri,name) => invoke('saveFile',uri,name),
  openFile: uri => invoke('openFile',uri),
  files: (method, args) => invoke('files',method,args),
  request: (id, request) => invoke('request', id, request),
  cancelRequest: id => invoke('cancelRequest', id),
  signal: Object.freeze(Object.fromEntries(['createState','replenish','trustIdentity','encrypt','decrypt','seal','open'].map(method => [method, (...args) => invoke('signal', method, args)]))),
  vault: Object.freeze({ open: scope => invoke('vaultOpen', scope), get: (id,key) => invoke('vaultGet',id,key), commit: (id,changes) => invoke('vaultCommit',id,changes), close: id => invoke('vaultClose',id) }),
  token: Object.freeze({ read: () => invoke('tokenRead'), write: value => invoke('tokenWrite',value) }),
  shortcuts: Object.freeze({
    set: binds => invoke('setShortcuts', binds),
    setHold: config => invoke('setHold', config),
    onHold: listener => { const handler = (_event, action, down) => { if ((action === 'ptt' || action === 'pushToMute') && typeof down === 'boolean') listener(action, down); }; ipcRenderer.on('invizent-hold', handler); return () => ipcRenderer.removeListener('invizent-hold', handler); },
    onAction: listener => { const handler = (_event, action) => { if (typeof action === 'string' && /^[a-z0-9]{1,16}$/.test(action)) listener(action); }; ipcRenderer.on('invizent-shortcut', handler); return () => ipcRenderer.removeListener('invizent-shortcut', handler); },
  }),
  badge: (count, picture) => invoke('badge', count, picture),
  windowControls: Object.freeze({
    platform: process.platform,
    action: action => ['minimize', 'maximize', 'close', 'state'].includes(action) ? ipcRenderer.invoke('window-control', action) : Promise.resolve(null),
    onState: listener => { const handler = (_event, state) => listener(state); ipcRenderer.on('window-state', handler); return () => ipcRenderer.removeListener('window-state', handler); },
  }),
  overlay: Object.freeze({ configure: prefs => invoke('overlayConfigure', prefs), update: view => invoke('overlayUpdate', view) }),
  update: Object.freeze({ download: (url,sha256,size) => invoke('updateDownload',url,sha256,size), progress: () => invoke('updateProgress'), cancel: () => invoke('updateCancel'), install: () => invoke('updateInstall') }),
}));
