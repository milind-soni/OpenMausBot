const { contextBridge, ipcRenderer } = require("electron");

// This loading page has no app bridge, credentials or file access.
contextBridge.exposeInMainWorld("startupScreen", {
  close: () => ipcRenderer.send("startup-screen:close"),
});
