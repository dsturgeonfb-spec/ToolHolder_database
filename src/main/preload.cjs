// Runs sandboxed in the app window before the page. Exposes the small desktop bridge the UI
// feature-detects as window.desktop (see docs/API.md, "Desktop bridge"). CommonJS on purpose:
// sandboxed preloads cannot be ES modules.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  version: ipcRenderer.sendSync('desktop:version'),
  pickFile: (opts) => ipcRenderer.invoke('desktop:pickFile', opts ?? {}),
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', String(url)),
  showItemInFolder: (path) => ipcRenderer.invoke('desktop:showItemInFolder', String(path)),
})
