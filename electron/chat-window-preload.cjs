const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("ombChatWindow", {
    openThread: (bot, thread) => navigator.userActivation.isActive
      ? ipcRenderer.invoke("workspace-window:thread", bot, thread)
      : Promise.resolve(false),
  });
}
