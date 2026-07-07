// Preload for the hidden recorder window.
// Exposes a minimal, safe bridge between the AssemblyAI streaming renderer
// and the main process. No Node APIs leak into the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stt', {
  // main → renderer: push-to-talk lifecycle
  onStart: (cb) => ipcRenderer.on('stt:start', () => cb()),
  onStop:  (cb) => ipcRenderer.on('stt:stop',  () => cb()),
  onAbort: (cb) => ipcRenderer.on('stt:abort', () => cb()),

  // renderer → main: request a short-lived AssemblyAI streaming token
  getToken: () => ipcRenderer.invoke('stt:get-token'),

  // renderer → main: live partial transcript (updates while speaking)
  partial: (text) => ipcRenderer.send('stt:partial', text),

  // renderer → main: results + diagnostics
  sendTranscript: (text) => ipcRenderer.send('stt:transcript', text),
  status: (msg) => ipcRenderer.send('stt:status', msg),
  error:  (msg) => ipcRenderer.send('stt:error', msg)
})
