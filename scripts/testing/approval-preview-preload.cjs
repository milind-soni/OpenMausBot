const { contextBridge, ipcRenderer } = require("electron");
// Only used by the disposable smoke window, never by the packaged app.
contextBridge.exposeInMainWorld("ogb", {
  platform: process.platform,
  getCapabilities: async () => ({
    host: { platform: process.platform, label: "Fixture", session: "unknown", packaged: true },
    windowChrome: "native",
    screenPreview: { available: false, interaction: "none" },
    dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
  }),
  approvals: { setMode: (botId, mode, options) => ipcRenderer.invoke("fixture:thread-approval", botId, mode, options) },
});
