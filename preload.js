const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_e, v) => cb(v)),
  onUpdateProgress:   (cb) => ipcRenderer.on('update-progress',   (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded',  ()     => cb()),
  installUpdate: () => ipcRenderer.send('install-update'),
});
