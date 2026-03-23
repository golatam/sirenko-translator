const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Translation
  translate: (text, targetLang) =>
    ipcRenderer.invoke("translate", text, targetLang),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),

  // Popup actions
  copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),
  replaceInApp: (text) => ipcRenderer.invoke("replace-in-app", text),
  setBusy: (busy) => ipcRenderer.send("popup-busy", busy),
  closePopup: () => ipcRenderer.send("close-popup"),

  // Model management
  downloadModels: () => ipcRenderer.invoke("download-models"),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("download-progress", (_event, data) => callback(data)),

  // Events from main process
  onTranslationRequest: (callback) =>
    ipcRenderer.on("translation-request", (_event, data) => callback(data)),
  onTranslationChunk: (callback) =>
    ipcRenderer.on("translation-chunk", (_event, chunk) => callback(chunk)),
});
