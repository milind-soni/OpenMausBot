// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.gbs), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gbs", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  background: { get: () => ipcRenderer.invoke("background:get"), set: (enabled) => ipcRenderer.invoke("background:set", enabled) },
  /** One frame of this Mac's screen as a data: URL (Screen Recording TCC). */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Screenshots the mobile preview <webview>. fullPage captures beyond the
   * visible viewport via the CDP debugger; otherwise just the visible area. */
  previewScreenshot: (input) => ipcRenderer.invoke("webview:screenshot", input),
  speechStart: () => ipcRenderer.invoke("speech:start"),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Local project folders. Filesystem and Git access stay in Electron main. */
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    chooseDirectory: (options) => ipcRenderer.invoke("projects:choose-directory", options),
    addExisting: (projectPath) => ipcRenderer.invoke("projects:add-existing", projectPath),
    create: (input) => ipcRenderer.invoke("projects:create", input),
    clone: (input) => ipcRenderer.invoke("projects:clone", input),
    open: (projectPath) => ipcRenderer.invoke("projects:open", projectPath),
  },

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
