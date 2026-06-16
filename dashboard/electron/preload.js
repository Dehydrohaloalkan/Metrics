const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('metricsAPI', {
  isElectron: true,
  loadDefault: () => ipcRenderer.invoke('csv:loadDefault'),
  loadMembers: () => ipcRenderer.invoke('members:loadDefault'),
  pickFile: () => ipcRenderer.invoke('csv:pick'),
  readFile: (filePath) => ipcRenderer.invoke('csv:readPath', filePath),
  loadSettings: () => ipcRenderer.sendSync('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:set', data),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
  exportPdf: () => ipcRenderer.invoke('export:pdf'),

  // DuckDB analytics engine (out-of-core; handles multi-GB CSVs).
  analytics: {
    loadDefault: (tz) => ipcRenderer.invoke('analytics:loadDefault', { tz }),
    pick: (tz) => ipcRenderer.invoke('analytics:pick', { tz }),
    setTimezone: (tz) => ipcRenderer.invoke('analytics:setTimezone', tz),
    setGroups: (groups) => ipcRenderer.invoke('analytics:setGroups', groups),
    query: (filter, opts) => ipcRenderer.invoke('analytics:query', { filter, opts }),
    exportCsv: () => ipcRenderer.invoke('analytics:export'),
  },
});
