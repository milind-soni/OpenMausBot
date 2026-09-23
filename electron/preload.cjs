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

// Main can finish loading the document before React subscribes. Retain only
// the fixed Organisation action, never a destination supplied by a renderer.
let pendingOrganizationSettings = false;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = section === "organization" ? "organization" : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingOrganizationSettings = true;
  if (!appSettingsListeners.size) return;
  pendingOrganizationSettings = false;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

// The bridge is built once, then exposed in full only to the local server's
// UI. A remote server's page (Server menu) gets the safe subset: nothing that
// captures this screen, touches this computer's files or logins, or runs
// helpers here. Main enforces the same rule on the sensitive channels.
const localOrigin = process.argv.find((arg) => arg.startsWith("--omb-local-origin="))?.slice("--omb-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;
const REMOTE_SAFE = new Set(["platform", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces"]);

// Sandboxed preload cannot import TS or sibling modules. Keep this list in
// parity with shared/workspace-backup-client.ts (covered by the preload test).
// Only main can request a fresh snapshot; there is no renderer-callable method.
const COMPANY_BACKUP_CLIENT_KEYS = [
  "omb-drafts", "omb-draft-attachments", "omb-draft-send-ids", "omb-draft-channel-modes",
  "omb-skin", "omb-show-threads", "openmausbot.sidebarDensity",
  "openmausbot.sidebarCollapsedSections.v1", "openmausbot.sidebarSectionOrder.v1",
  "omb-analytics-opt-out", "openmausbot.remote-voice.v1",
];
if (isLocalPage && !desktopRemoteClient && process.argv.includes("--omb-company-desktop=1")) {
  ipcRenderer.on("company-backups:collect-client-state", (_event, request) => {
    if (!request || typeof request.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(request.requestId)) return;
    try {
      // Check the origin again; a later navigation must not export remote data.
      if (!localOrigin || location.origin !== localOrigin) throw new Error("Not the local workspace");
      const clientState = {};
      for (const key of COMPANY_BACKUP_CLIENT_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) clientState[key] = value;
      }
      if (new TextEncoder().encode(JSON.stringify(clientState)).byteLength > 2 * 1024 ** 2) throw new Error("Browser state too large");
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, clientState });
    } catch {
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, unavailable: true });
    }
  });
}

const bridge = {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  // Safe even on a cloud page: the user chooses in a native menu owned by
  // Electron. No direct switching, saved-list reads, host files or secrets.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: () => ipcRenderer.invoke("workspaces:menu"),
  },
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
  /** Keep this computer awake for scheduled routines. The hold itself lives
   * in the main process; the page reads its state and flips the toggle. */
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
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
  /** The app menu's Preferences… item; local shell only (the remote-safe
   * subset never sees it). */
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      if (!pendingOrganizationSettings || !appSettingsListeners.size) return;
      pendingOrganizationSettings = false;
      for (const listener of appSettingsListeners) listener("organization");
    });
    return () => appSettingsListeners.delete(cb);
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
  /** The renderer-drawn Windows caption buttons: minimize / restore /
   * maximize / close, plus live maximize state so the glyph can flip. */
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
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
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    forget: (id) => ipcRenderer.invoke("environments:forget", id),
    onOpenSettings: (cb) => {
      const handler = (_event, computerId) => cb(computerId);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  organization: process.argv.includes("--omb-company-desktop=1") ? {
    settingsOpened: () => ipcRenderer.invoke("organization:settings-opened"),
    state: () => ipcRenderer.invoke("organization:state"),
    begin: input => ipcRenderer.invoke("organization:begin", input),
    cancelEnrollment: () => ipcRenderer.invoke("organization:cancel"),
    refresh: () => ipcRenderer.invoke("organization:refresh"),
    disconnect: () => ipcRenderer.invoke("organization:disconnect"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("organization:state-changed", handler);
      return () => ipcRenderer.removeListener("organization:state-changed", handler);
    },
  } : undefined,
  companyBackups: process.argv.includes("--omb-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("company-backups:state"),
    list: () => ipcRenderer.invoke("company-backups:list"),
    create: input => ipcRenderer.invoke("company-backups:create", input),
    configureSchedule: input => ipcRenderer.invoke("company-backups:configure-schedule", input),
    prepareRestore: input => ipcRenderer.invoke("company-backups:preview", input),
    restore: input => ipcRenderer.invoke("company-backups:restore", input),
    delete: input => ipcRenderer.invoke("company-backups:delete", input),
    cancel: () => ipcRenderer.invoke("company-backups:cancel"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("company-backups:state-changed", handler);
      return () => ipcRenderer.removeListener("company-backups:state-changed", handler);
    },
  } : undefined,
  computerSharing: {
    state: id => ipcRenderer.invoke("sharing:state", id),
    chooseFolder: () => ipcRenderer.invoke("sharing:folder"),
    save: (id, grant) => ipcRenderer.invoke("sharing:save", id, grant),
    revoke: id => ipcRenderer.invoke("sharing:revoke", id),
  },
};

contextBridge.exposeInMainWorld(
  "ogb",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => REMOTE_SAFE.has(key))),
);
