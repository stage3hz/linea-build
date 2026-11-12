// Snow cap window: receives only the cursor position over it. No other access.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('snowCap', Object.freeze({
  onCursor: listener => ipcRenderer.on('snow-cursor', (_event, x, y) => listener(typeof x === 'number' ? x : null, typeof y === 'number' ? y : null)),
}));
