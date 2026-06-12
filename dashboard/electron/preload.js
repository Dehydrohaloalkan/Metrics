const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('metricsAPI', {
  isElectron: true,
  loadDefault: () => ipcRenderer.invoke('csv:loadDefault'),
  loadMembers: () => ipcRenderer.invoke('members:loadDefault'),
  pickFile: () => ipcRenderer.invoke('csv:pick'),
  loadSettings: () => ipcRenderer.sendSync('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:set', data),
});
