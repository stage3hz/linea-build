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
  update: Object.freeze({ download: (url,sha256,size) => invoke('updateDownload',url,sha256,size), progress: () => invoke('updateProgress'), cancel: () => invoke('updateCancel'), install: () => invoke('updateInstall') }),
}));
