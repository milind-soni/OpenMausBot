// contextIsolation stays on: the renderer sees only window.ogb, never Node or ipcRenderer.
const { contextBridge, ipcRenderer, webFrame, webUtils } = require("electron");

// Sandboxed preloads get Electron's restricted `require`, which cannot load sibling CommonJS files.
const desktopRemoteClient = process.argv.includes("--openmausbot-remote-client");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

let pendingChatLink = null;
const chatLinkListeners = new Set();
ipcRenderer.on("chat:open", (_event, link) => {
  if (typeof link !== "string") return;
  if (!chatLinkListeners.size) {
    pendingChatLink = link;
    return;
  }
  for (const listener of chatLinkListeners) listener(link);
});

// Only fixed actions are retained, never a destination supplied by a renderer.
const FIXED_SETTINGS_ACTIONS = new Set(["organization", "cloud", "cloud-settings", "cloud-add", "cloud-add-howto"]);
let pendingSettingsAction = null;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = FIXED_SETTINGS_ACTIONS.has(section) ? section : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingSettingsAction = fixedSection;
  if (!appSettingsListeners.size) return;
  pendingSettingsAction = null;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

// The full bridge goes only to the local server's UI; a remote page gets the safe subset, and main enforces the same rule.
const localOrigin = process.argv.find((arg) => arg.startsWith("--omb-local-origin="))?.slice("--omb-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;

// The window's own rail of places stands at its left edge (electron/chrome-rail.mjs): main says how wide, and every page
// beside it, whatever server it comes from, moves over by that much, at any zoom (a zoom change resizes the page). The
// page reads how far in `--rail-beside`, which changes with the move itself.
let railBeside = 0, railRoom = null;
function leaveRailRoom() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  if (!railBeside) { railRoom?.remove(); railRoom = null; return; }
  railRoom ??= document.createElement("style");
  const room = `${Math.round((railBeside / zoom) * 100) / 100}px`;
  railRoom.textContent = `html { box-sizing: border-box !important; padding-left: ${room} !important; --rail-beside: ${room}; }`;
  if (!railRoom.isConnected) (document.head ?? document.documentElement).append(railRoom);
}
const railState = (state) => ({ available: state?.available === true, hidden: state?.hidden === true });
ipcRenderer.on("rail:beside", (_event, width) => { railBeside = Math.max(0, Math.min(200, Number(width) || 0)); leaveRailRoom(); });
// The rail's own page keeps its size whatever the zoom of this app's page: Chromium gives every page of a host the same
// zoom, the rail's included, so the rail takes it back out and stays as wide as its strip.
function railKeepsItsSize() {
  if (!isLocalPage || location.pathname !== "/rail" || typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  document.documentElement.style.zoom = zoom === 1 ? "" : String(Math.round((1 / zoom) * 10000) / 10000);
}
if (typeof window !== "undefined") {
  for (const type of ["resize", "DOMContentLoaded"]) window.addEventListener(type, () => { leaveRailRoom(); railKeepsItsSize(); });
}
const REMOTE_SAFE = new Set(["platform", "app", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces", "rail", "cloudAdd", "cloudPlan", "cloudSendPage", "desktopNotices", "desktopAnalytics", "desktopLanguage", "updatesConsent", "windowControls", "onOpenAppSettings", "windowFrame"]);
/** My Cloud's own page once it is the person's home (main checks the sender again): it is this app's page then. */
const HOME_PAGE = ["home", "onChatLink", "onPackageInstall", "exportDiagnostics", "openLogsFolder", "openAtLogin", "callActive"];
function updaterOffered() {
  try { return ipcRenderer.sendSync("update:offered") === true; } catch { return false; }
}
function homePage() {
  try { return ipcRenderer.sendSync("home:page") === true; } catch { return false; }
}
function reloadedForUpdate() {
  try { return ipcRenderer.sendSync("home:updating") === true; } catch { return false; }
}
function savedAnalyticsChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-analytics:read"); return typeof saved === "boolean" ? saved : null; } catch { return null; }
}
let analyticsChoice;
function savedLanguageChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-language:read"); return typeof saved === "string" ? saved : null; } catch { return null; }
}
let languageChoice;
const languageListeners = new Set();
ipcRenderer.on("desktop-language:changed", (_event, language) => {
  if (typeof language !== "string") return;
  languageChoice = language;
  for (const listener of languageListeners) listener(language);
});
const onHomePage = !isLocalPage && homePage();
const remoteKeys = isLocalPage ? REMOTE_SAFE : new Set([...REMOTE_SAFE, ...(updaterOffered() ? ["updater"] : []), ...(onHomePage ? HOME_PAGE : [])]);

// Keep in parity with shared/workspace-backup-client.ts (a sandboxed preload cannot import it).
const COMPANY_BACKUP_CLIENT_KEYS = [
  "omb-drafts", "omb-draft-attachments", "omb-draft-send-ids", "omb-draft-channel-modes",
  "omb-skin", "omb-show-threads", "omb-show-run-card", "omb-send-key", "omb-color-user-bubbles", "omb-chat-width", "openmausbot.sidebarDensity",
  "openmausbot.sidebarToolsLayout",
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

// main passes app.getVersion(): a server's page carries that server's version, so About asks this for the app's own.
const appVersion = (process.argv.find((arg) => arg.startsWith("--omb-app-version="))?.slice("--omb-app-version=".length) ?? "").slice(0, 64);

const bridge = {
  platform: process.platform,
  /** This app's version, and whether this page is this app's own (served by this computer, not a server from the Server menu). */
  app: { version: appVersion, ownPage: isLocalPage },
  // Safe on a cloud page: the person chooses in a native menu, or a circle of the rail main listed (only for this app's
  // page and a hosted Cloud's, never addresses), and only from their click; no saved-list reads, host files or secrets.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: (options) => ipcRenderer.invoke("workspaces:menu", ...(options?.from === "howto" ? ["howto"] : [])),
    line: () => ipcRenderer.invoke("workspaces:line"),
    places: () => ipcRenderer.invoke("workspaces:places"),
    open: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:open", String(id)) : Promise.reject(new Error("Choose a place to open it.")),
    add: (choice, link) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:add", String(choice), ...(typeof link === "string" ? [link] : [])) : Promise.reject(new Error("Choose what to add.")),
    // The colour of the place this page is (never another's): read, and changed only from the person's click.
    look: () => ipcRenderer.invoke("workspaces:look"),
    color: (swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:color", swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // The colour of a place the window's rail lists, from a click on the rail's own page (main refuses any other page).
    recolor: (id, swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:recolor", String(id), swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // Remove from list, for a Cloud the window's rail lists as removable, from a click on the rail's own page (main refuses any other page).
    remove: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:remove", String(id)) : Promise.reject(new Error("Choose Remove from list.")),
    // Make a server of the person's own their bots' home, from a click on the rail's own page (main refuses any other page).
    makeHome: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:make-home", String(id)) : Promise.reject(new Error("Choose Make my home.")),
    onChanged: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("workspaces:changed", handler);
      return () => ipcRenderer.removeListener("workspaces:changed", handler);
    },
  },
  // The window's own rail (this app's page at /rail, beside every place's page): while a sheet of its own is open it
  // covers the window; the skin of the page beside it comes from main, and whether that page draws the window's frame.
  // The page beside it, from whichever server, offers the button that hides and shows it, and learns only whether there
  // is one to hide, never its places; it says when it draws the frame, so main puts the traffic lights in its top bar.
  rail: {
    state: () => ipcRenderer.invoke("rail:offer").then(railState),
    drawsFrame: (drawn) => ipcRenderer.invoke("rail:draws-frame", drawn !== false),
    setHidden: (hidden) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("rail:hide", hidden === true).then(railState) : Promise.reject(new Error("Choose to hide or show your computers.")),
    onState: (cb) => {
      const handler = (_event, state) => cb(railState(state));
      ipcRenderer.on("rail:state", handler);
      return () => ipcRenderer.removeListener("rail:state", handler);
    },
    ...(isLocalPage ? {
      expand: (on) => ipcRenderer.invoke("rail:expand", on === true),
      onSkin: (cb) => {
        const handler = (_event, skin) => cb(String(skin));
        ipcRenderer.on("rail:skin", handler);
        return () => ipcRenderer.removeListener("rail:skin", handler);
      },
      onFramed: (cb) => {
        const handler = (_event, framed) => cb(framed === true);
        ipcRenderer.on("rail:framed", handler);
        return () => ipcRenderer.removeListener("rail:framed", handler);
      },
    } : {}),
  },
  // The window's own frame, this desktop's choice for every page of its window; a server's page changes it only from the
  // person's click.
  windowFrame: {
    state: () => ipcRenderer.invoke("window-frame:state"),
    set: (on) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("window-frame:set", on === true) : Promise.reject(new Error("Choose to turn the window frame on or off.")),
  },
  // Buying another Cloud from the rail's ＋, on this app's page or a hosted Cloud's: plain words in, what the sheet says
  // out; the account, the token and the checkout page stay in main. Only from the person's click where it opens anything.
  cloudAdd: {
    state: () => ipcRenderer.invoke("cloud-add:state"),
    start: (tier, name, color, source) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:start", String(tier), String(name), color === null ? null : String(color), ...(source == null ? [] : [String(source)]))
      : Promise.reject(new Error("Choose Continue to checkout.")),
    reopen: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:reopen") : Promise.reject(new Error("Choose Reopen checkout.")),
    copyLink: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:copy-link") : Promise.reject(new Error("Choose Copy link.")),
    open: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:open") : Promise.reject(new Error("Choose Open to open it.")),
    interest: () => ipcRenderer.invoke("cloud-add:interest"),
    sheet: (open) => ipcRenderer.invoke("cloud-add:sheet", open === true),
    organization: (name, color) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:organization", String(name), color === null ? null : String(color)) : Promise.reject(new Error("Choose Create organization.")),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The bearer stays in the main process and is never returned over this bridge. */
  remoteClient: {
    active: desktopRemoteClient,
    state: () => ipcRenderer.invoke("desktop-remote:state"),
    pair: (endpoint, code) => ipcRenderer.invoke("desktop-remote:pair", endpoint, code),
    disconnect: () => ipcRenderer.invoke("desktop-remote:disconnect"),
  },
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    refreshTailscale: () => ipcRenderer.invoke("companion:refresh-tailscale"),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    browserControl: (deviceId, allowed) => ipcRenderer.invoke("companion:browser-control", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  /** Secrets stay in the main process; the renderer sees only status and narrow actions. */
  companionAccount: {
    state: () => ipcRenderer.invoke("companion-account:state"),
    requestCode: (email) => ipcRenderer.invoke("companion-account:request-code", email),
    verifyCode: (email, code) => ipcRenderer.invoke("companion-account:verify-code", email, code),
    retry: () => ipcRenderer.invoke("companion-account:retry"),
    prepare: () => ipcRenderer.invoke("companion-account:prepare"),
    signOut: () => ipcRenderer.invoke("companion-account:sign-out"),
  },
  /** Full/Custom never go through the loopback API, only the embedded server's private utilityProcess port. */
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
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB devices only; network ADB is deliberately excluded. */
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
  talkShortcut: {
    state: () => ipcRenderer.invoke("talk-shortcut:state"),
    set: (change) => ipcRenderer.invoke("talk-shortcut:set", {
      ...(typeof change?.enabled === "boolean" ? { enabled: change.enabled } : {}),
      ...(typeof change?.key === "string" ? { key: change.key } : {}),
    }),
  },
  callActive: (active) => ipcRenderer.invoke("call:active", active === true).then(() => undefined),
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      const section = pendingSettingsAction;
      if (!section || !appSettingsListeners.size) return;
      pendingSettingsAction = null;
      for (const listener of appSettingsListeners) listener(section);
    });
    return () => appSettingsListeners.delete(cb);
  },
  /** Electron 32 removed File.path, and only the preload can ask. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** No screen field: macOS 15+ caches that status per process, so it would lie after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  /** Unlike window.open, this still works after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
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
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  onChatLink: (cb) => {
    chatLinkListeners.add(cb);
    if (pendingChatLink) {
      const link = pendingChatLink;
      pendingChatLink = null;
      cb(link);
    }
    return () => chatLinkListeners.delete(cb);
  },
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
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
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  /** ipcRenderer wraps a main-process throw in "Error invoking remote method"; the bubble shows the text verbatim. */
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  // This app's own logs folder (server.log, desktop-crashes.log, updater.log); the page names no path.
  openLogsFolder: () => ipcRenderer.invoke("desktop:open-logs"),
  openAtLogin: {
    state: () => ipcRenderer.invoke("open-at-login:state"),
    set: on => on !== true || isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("open-at-login:set", on === true) : Promise.reject(new Error("Turn on the switch to open OpenMausBot at login.")),
  },
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    install: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("update:install") : Promise.reject(new Error("Choose Restart to update.")),
    seen: () => ipcRenderer.invoke("update:seen"),
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

  /** A remote page may read the list but never change where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    create: (name, dataDir) => ipcRenderer.invoke("environments:create", name, dataDir),
    pickDir: () => ipcRenderer.invoke("environments:pick-dir"),
    forget: (id, purge) => ipcRenderer.invoke("environments:forget", id, purge === true),
    onOpenSettings: (cb) => {
      const handler = (_event, computerId) => cb(computerId);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  cloudAccount: process.argv.includes("--omb-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("cloud-account:state"),
    begin: () => ipcRenderer.invoke("cloud-account:begin"),
    signInAgain: () => ipcRenderer.invoke("cloud-account:signInAgain"),
    reopen: () => ipcRenderer.invoke("cloud-account:reopen"),
    cancel: () => ipcRenderer.invoke("cloud-account:cancel"),
    refresh: () => ipcRenderer.invoke("cloud-account:refresh"),
    signOut: () => ipcRenderer.invoke("cloud-account:signOut"),
    openDashboard: () => ipcRenderer.invoke("cloud-account:openDashboard"),
    offer: () => ipcRenderer.invoke("cloud-account:offer"),
    checkout: (plan, source) => ipcRenderer.invoke("cloud-account:checkout", String(plan), String(source)),
    // The buying sheet: plain text in, outcomes out; the attempt, the token and the checkout page stay in main.
    signInStart: email => ipcRenderer.invoke("cloud-account:signInStart", String(email)),
    signInVerify: code => ipcRenderer.invoke("cloud-account:signInVerify", String(code)),
    signInCancel: () => ipcRenderer.invoke("cloud-account:signInCancel"),
    reopenCheckout: (plan, source) => ipcRenderer.invoke("cloud-account:reopenCheckout", String(plan), String(source)),
    copyCheckoutLink: () => ipcRenderer.invoke("cloud-account:copyCheckoutLink"),
    interest: () => ipcRenderer.invoke("cloud-account:interest"),
    look: () => ipcRenderer.invoke("cloud-account:look"),
    setLook: (name, color) => ipcRenderer.invoke("cloud-account:setLook", String(name), String(color)),
    sheet: open => ipcRenderer.invoke("cloud-account:sheet", open === true),
    readySeen: () => ipcRenderer.invoke("cloud-account:readySeen"),
    connectHome: () => ipcRenderer.invoke("cloud-account:connectHome"),
    connectHomeForPhone: () => ipcRenderer.invoke("cloud-account:connectHomeForPhone"),
    openTeam: teamId => ipcRenderer.invoke("cloud-account:openTeam", String(teamId)),
    // Cancel trial / Cancel plan and Keep my plan: the survey's words only; main names the Cloud from the verified session.
    cancelPlan: survey => ipcRenderer.invoke("cloud-account:cancelPlan", survey ?? null),
    keepPlan: () => ipcRenderer.invoke("cloud-account:keepPlan"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("cloud-account:state-changed", handler);
      return () => ipcRenderer.removeListener("cloud-account:state-changed", handler);
    },
    files: {
      state: () => ipcRenderer.invoke("files:state"),
      pickFolder: () => ipcRenderer.invoke("files:pick"),
      checkFolders: paths => ipcRenderer.invoke("files:check", paths),
      share: token => ipcRenderer.invoke("files:share", token),
      stopSharing: folderId => ipcRenderer.invoke("files:stop", folderId),
      answerDeletes: (folderId, remove) => ipcRenderer.invoke("files:deletes", folderId, remove),
      locate: folderId => ipcRenderer.invoke("files:locate", folderId),
      setOutputs: enabled => ipcRenderer.invoke("files:outputs", enabled),
      open: target => ipcRenderer.invoke("files:open", target),
      moreSpace: () => ipcRenderer.invoke("files:more-space"),
      onState: cb => {
        const handler = (_event, state) => cb(state);
        ipcRenderer.on("files:state-changed", handler);
        return () => ipcRenderer.removeListener("files:state-changed", handler);
      },
    },
  } : undefined,
  // Either page: the one-time move's line.
  cloudSendPage: process.argv.includes("--omb-company-desktop=1") ? {
    notice: () => ipcRenderer.invoke("cloud-send:notice"),
    dismiss: signature => ipcRenderer.invoke("cloud-send:dismiss", String(signature)),
    moveRetry: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:move-retry") : Promise.reject(new Error("Choose Try again to move.")),
    // My Cloud's page: a bot of its moving into one of its person's teams.
    teams: () => ipcRenderer.invoke("cloud-send:teams"),
    moveToTeam: (botId, teamId, name) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:team-move", String(botId), String(teamId), String(name ?? "")) : Promise.reject(new Error("Choose Move to move the bot.")),
    teamRetry: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:team-retry") : Promise.reject(new Error("Choose Try again to move.")),
    openTeam: teamId => ipcRenderer.invoke("cloud-send:team-open", String(teamId)),
    // Settings → MausBot Cloud, Advanced: "Keep this computer's bots on this computer".
    keepHere: () => ipcRenderer.invoke("one-home:keep"),
    setKeepHere: on => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("one-home:keep-set", on === true) : Promise.reject(new Error("Turn the switch to keep this computer's bots here.")),
    onNotice: cb => {
      const handler = (_event, notice) => cb(notice);
      ipcRenderer.on("cloud-send:notice-changed", handler);
      return () => ipcRenderer.removeListener("cloud-send:notice-changed", handler);
    },
  } : undefined,
  // This computer's page only (never in REMOTE_SAFE, and main refuses any other): bots in two places, brought together on one.
  twoPlaces: {
    state: () => ipcRenderer.invoke("two-places:state"),
    accept: key => ipcRenderer.invoke("two-places:accept", String(key)),
    dismiss: key => ipcRenderer.invoke("two-places:dismiss", String(key)),
    onChanged: cb => {
      const handler = () => cb();
      ipcRenderer.on("two-places:changed", handler);
      return () => ipcRenderer.removeListener("two-places:changed", handler);
    },
  },
  cloudPlan: process.argv.includes("--omb-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("cloud-plan:state"),
    manage: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:manage") : Promise.reject(new Error("Choose Manage to open your Plan page.")),
    signIn: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("home:sign-in") : Promise.reject(new Error("Choose Sign in to sign in again.")),
    noticeSeen: () => ipcRenderer.invoke("cloud-plan:notice-seen"),
    // The usage meter's Upgrade: both only from the person's click (Upgrade, then the confirm's Upgrade), never by themselves.
    upgradePreview: (plan, source) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:upgrade-preview", String(plan), String(source)) : Promise.reject(new Error("Choose Upgrade to see the price.")),
    upgrade: (plan, source) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:upgrade", String(plan), String(source)) : Promise.reject(new Error("Choose Upgrade to change your plan.")),
    // Cancel trial / Cancel plan and Keep my plan: only from the person's click; the survey's words only, main names the Cloud.
    cancel: survey => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:cancel", survey ?? null) : Promise.reject(new Error("Choose Cancel to cancel your plan.")),
    keep: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:keep") : Promise.reject(new Error("Choose Keep my plan to keep it.")),
    // The room card's Not now, and Restart now after its upgrade: only from the person's click.
    roomNotNow: id => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:room-not-now", String(id)) : Promise.reject(new Error("Choose Not now.")),
    restartNow: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:restart-now") : Promise.reject(new Error("Choose Restart now to restart the Cloud.")),
  } : undefined,
  organization: process.argv.includes("--omb-company-desktop=1") ? {
    settingsOpened: () => ipcRenderer.invoke("organization:settings-opened"),
    state: () => ipcRenderer.invoke("organization:state"),
    begin: input => ipcRenderer.invoke("organization:begin", input),
    reopen: () => ipcRenderer.invoke("organization:reopen"),
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
    activity: id => ipcRenderer.invoke("sharing:activity", id),
  },
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),
  /** The window onto My Cloud once it is the person's home: this computer's screen while My Cloud can't be opened, and
   * on My Cloud's own page a new session when its own has ended. */
  home: {
    state: () => ipcRenderer.invoke("home:state"),
    onState: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("home:state-changed", handler);
      return () => ipcRenderer.removeListener("home:state-changed", handler);
    },
    retry: () => ipcRenderer.invoke("home:retry"),
    remove: () => ipcRenderer.invoke("home:remove"),
    signIn: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("home:sign-in") : Promise.reject(new Error("Choose Sign in to sign in again.")),
    repair: () => ipcRenderer.invoke("home:repair"),
    updating: onHomePage && reloadedForUpdate(),
  },
  updatesConsent: {
    state: () => ipcRenderer.invoke("updates-consent:state"),
    choose: choice => ipcRenderer.invoke("updates-consent:choose", {
      status: String(choice?.status),
      ...(typeof choice?.email === "string" ? { email: choice.email } : {}),
    }),
  },
  desktopProfile: {
    systemName: () => ipcRenderer.invoke("desktop-profile:system-name"),
  },
  desktopNotices: {
    state: () => ipcRenderer.invoke("desktop-notices:state"),
    seen: id => ipcRenderer.invoke("desktop-notices:seen", String(id)),
  },
  desktopAnalytics: {
    enabled: () => {
      if (analyticsChoice === undefined) analyticsChoice = savedAnalyticsChoice();
      return analyticsChoice;
    },
    ...(isLocalPage ? { set: enabled => { analyticsChoice = enabled === true; return ipcRenderer.invoke("desktop-analytics:set", analyticsChoice); } } : {}),
  },
  desktopLanguage: {
    choice: () => {
      if (languageChoice === undefined) languageChoice = savedLanguageChoice();
      return languageChoice;
    },
    set: language => {
      languageChoice = String(language);
      return ipcRenderer.invoke("desktop-language:set", languageChoice);
    },
    onChange: listener => {
      languageListeners.add(listener);
      return () => { languageListeners.delete(listener); };
    },
  },
};

contextBridge.exposeInMainWorld(
  "ogb",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => remoteKeys.has(key))),
);
