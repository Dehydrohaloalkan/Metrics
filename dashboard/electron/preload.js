const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('metricsAPI', {
  isElectron: true,
  loadDefault: () => ipcRenderer.invoke('csv:loadDefault'),
  pickFile: () => ipcRenderer.invoke('csv:pick'),
});
