const { contextBridge, ipcRenderer } = require("electron");
// Disposable remote renderer: deliberately no local approvals bridge.
contextBridge.exposeInMainWorld("ogb", {
  platform: process.platform,
  getCapabilities: async () => ({
    host: { platform: process.platform, label: "Remote fixture", session: "unknown", packaged: false },
    windowChrome: "native",
    screenPreview: { available: false, interaction: "none" },
    dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
  }),
  remoteApprovals: {
    status: () => ipcRenderer.invoke("fixture:remote-approval-status"),
    setFull: (botId, threadId) => ipcRenderer.invoke("fixture:remote-approval-full", botId, threadId),
  },
});
