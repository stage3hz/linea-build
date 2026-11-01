const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('capturePicker',Object.freeze({list:()=>ipcRenderer.invoke('capture-sources'),choose:id=>ipcRenderer.invoke('capture-choose',id)}));
