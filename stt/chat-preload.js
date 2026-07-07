// Preload for the ChatGPT window. Exposes a tiny, safe bridge the injected
// drag/resize UI uses to drive the frameless window's size from the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('silentai', {
  winSize: () => ipcRenderer.invoke('win:size'),
  winSetSize: (w, h) => ipcRenderer.send('win:set-size', w, h)
})
