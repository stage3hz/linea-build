// Overlay window: receives only the list to draw. No other access.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', Object.freeze({
  onView: listener => ipcRenderer.on('overlay-view', (_event, view, opacity) => listener(view, opacity)),
}));
