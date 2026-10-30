const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("talk", {
  open: () => ipcRenderer.send("talk-panel:open"),
  dismiss: () => ipcRenderer.send("talk-panel:dismiss"),
});
