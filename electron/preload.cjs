// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Sandboxed preloads receive Electron's restricted `require`, which cannot
// load sibling CommonJS files. Keep this tiny predicate inline here; main's
const desktopRemoteClient = process.argv.includes("--openmausbot-remote-client");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

// The bridge is built once, then exposed in full only to the local server's
// UI. A remote server's page (Server menu) gets the safe subset: nothing that
// captures this screen, touches this computer's files or logins, or runs
// helpers here. Main enforces the same rule on the sensitive channels.
const localOrigin = process.argv.find((arg) => arg.startsWith("--omb-local-origin="))?.slice("--omb-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;
const REMOTE_SAFE = new Set(["platform", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus"]);

const bridge = {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** Pair this desktop app to another OpenMausBot host. The bearer remains in
   * the main process and is never returned over this bridge. */
  remoteClient: {
    active: desktopRemoteClient,
    state: () => ipcRenderer.invoke("desktop-remote:state"),
    pair: (endpoint, code) => ipcRenderer.invoke("desktop-remote:pair", endpoint, code),
    disconnect: () => ipcRenderer.invoke("desktop-remote:disconnect"),
  },
  /** The companion sidecar: the one part of this app that listens off the
   * machine, so it runs as its own process and is off until switched on.
   * Every call answers with the whole state, so the panel never has to
   * stitch two round-trips together. */
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    refreshTailscale: () => ipcRenderer.invoke("companion:refresh-tailscale"),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  /** Optional account-backed HTTPS access for Companion. Secrets stay in the
   * main process; the renderer sees only status and narrow user actions. */
  companionAccount: {
    state: () => ipcRenderer.invoke("companion-account:state"),
    requestCode: (email) => ipcRenderer.invoke("companion-account:request-code", email),
    verifyCode: (email, code) => ipcRenderer.invoke("companion-account:verify-code", email, code),
    retry: () => ipcRenderer.invoke("companion-account:retry"),
    signOut: () => ipcRenderer.invoke("companion-account:sign-out"),
  },
  /** Full/Custom and transitions out of Custom are deliberately unavailable
   * through the loopback API. The local renderer applies those changes over
   * the embedded server's private utilityProcess port. */
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB Android devices. Network ADB is deliberately excluded. */
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
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
  /** A local-first demonstration recorder. Global events stay in main; the
   * renderer receives only the privacy-filtered event stream. */
  skillRecorder: {
    permissions: () => ipcRenderer.invoke("skill-recorder:permissions"),
    start: () => ipcRenderer.invoke("skill-recorder:start"),
    stop: () => ipcRenderer.invoke("skill-recorder:stop"),
    save: (payload) => ipcRenderer.invoke("skill-recorder:save", payload),
    onEvent: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:event", handler);
      return () => ipcRenderer.removeListener("skill-recorder:event", handler);
    },
    onEnd: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:end", handler);
      return () => ipcRenderer.removeListener("skill-recorder:end", handler);
    },
  },
  transcription: {
    status: () => ipcRenderer.invoke("assemblyai:status"),
    setKey: (value) => ipcRenderer.invoke("assemblyai:set-key", value),
    streamingToken: () => ipcRenderer.invoke("assemblyai:streaming-token"),
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  /** Tell the window which skin the page wears, so the native chrome the
   * renderer cannot paint (the Windows caption-button overlay) matches. */
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  /** A reviewed BotMRR package opened through openmausbot://install. */
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  /** Mirrors durable unread state into the native Dock/taskbar badge. */
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  /** Live VNC/noVNC in a sandboxed window owned by the app window. */
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  /** Two sandboxed Local VM viewers embedded in the owning app window. */
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  /** Native folder picker for a bot's working folder; null when cancelled. */
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  /** Writes the redacted diagnostics report to a user-chosen file; resolves
   * the path, or null when the save dialog was cancelled. */
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  /** Ask where to save a bot-created file (inside ~/.openmausbot), copy it
   * there and reveal it. Returns the chosen path, or null if the user
   * cancelled the dialog. The chat bubble shows the
   * rejection text verbatim, so strip the "Error invoking remote method"
   * wrapper ipcRenderer adds around a main-process throw. */
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

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

  /** Saved servers and the active one (Server menu). Switching, adding and
   * forgetting are local-only: a remote page may read the list but not change
   * where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link) => ipcRenderer.invoke("environments:add-from-link", link),
    forget: (id) => ipcRenderer.invoke("environments:forget", id),
  },
};

contextBridge.exposeInMainWorld(
  "ogb",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => REMOTE_SAFE.has(key))),
);
