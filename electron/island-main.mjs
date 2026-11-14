import path from "node:path";
import { fileURLToPath } from "node:url";
import { dynamicIslandHtml, ISLAND_SIZE } from "./island-page.mjs";
import { createDesktopScreenCapture, createScreenContext } from "./island-screen-context.mjs";
import { createOmiContext } from "./island-omi.mjs";
import { createIslandKeyStore } from "./island-key-store.mjs";
import { createIslandSession } from "./island-session.mjs";
import { createTalkServer } from "./talk-server.mjs";

export function islandBounds(display, expanded) {
  const width = Math.min(display.bounds.width, expanded ? ISLAND_SIZE.expandedWidth : ISLAND_SIZE.compactWidth);
  const height = expanded ? ISLAND_SIZE.expandedHeight : ISLAND_SIZE.compactHeight;
  return { x: Math.round(display.bounds.x + (display.bounds.width - width) / 2), y: display.bounds.y, width, height };
}

export function createDynamicIsland({ BrowserWindow, screen, desktopCapturer, systemPreferences, safeStorage,
  nativeImage, iconPath, powerMonitor, speech, request, prefs, dataDir, openChat, allowed, starting,
  globalShortcut, createOmi = createOmiContext, captureFrame, keyStore: suppliedKeyStore }) {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({ ...islandBounds(display, false), title: "Ilha MausBot", frame: false,
    transparent: true, show: false, focusable: false, skipTaskbar: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    acceptFirstMouse: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./island-preload.cjs", import.meta.url)), spellcheck: false } });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  let loaded = false, closed = false, suspended = false, controller;
  let latestView = null;
  function render(view) {
    latestView = view;
    if (!loaded || closed) return;
    win.setFocusable(Boolean(view.expanded));
    win.setBounds(islandBounds(screen.getPrimaryDisplay(), view.expanded));
    void win.webContents.executeJavaScript(`render(${JSON.stringify(view)})`).catch(() => {});
  }
  const keyStore = suppliedKeyStore ?? createIslandKeyStore({ file: path.join(dataDir, "island-omi-key.enc"),
    encryption: { available: async () => (await safeStorage.isAsyncEncryptionAvailable()) && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"), encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: value => safeStorage.decryptStringAsync(value) } });
  const screenContext = createScreenContext({ captureFrame: captureFrame ?? createDesktopScreenCapture({ desktopCapturer, screen,
    systemPreferences, isSuspended: () => suspended }), onChange: () => controller?.repaint() });
  const omi = createOmi({ readKey: () => keyStore.read(), writeKey: key => keyStore.write(key), onChange: () => controller?.repaint() });
  controller = createIslandSession({ screenContext, omi, speech, request, render, openChat, allowed,
    server: createTalkServer({ request, prefs, serverKey: () => `${dataDir}:island`, starting }) });
  const commands = new Set(["toggleExpanded", "toggleCapture", "toggleVoice", "send", "openChat", "pause", "refreshOmi", "configureOmi", "disconnectOmi"]);
  win.webContents.on("ipc-message", (event, channel, command, ...args) => {
    if (event.senderFrame !== win.webContents.mainFrame || channel !== "island:command" || !commands.has(command)) return;
    Promise.resolve(controller[command](...args)).catch(() => {});
  });
  const suspend = () => { suspended = true; controller.suspend(); };
  const resume = () => { suspended = false; };
  powerMonitor.on("lock-screen", suspend); powerMonitor.on("suspend", suspend);
  powerMonitor.on("unlock-screen", resume); powerMonitor.on("resume", resume);
  const shortcut = "CommandOrControl+Shift+Space";
  const registered = globalShortcut?.register(shortcut, () => controller.toggleVoice()) ?? false;
  const reposition = () => { if (latestView) render(latestView); };
  screen.on("display-metrics-changed", reposition); screen.on("display-removed", reposition);
  win.webContents.on("did-finish-load", () => {
    loaded = true; controller.repaint(); win.showInactive();
    void omi.refresh().catch(() => {});
  });
  const icon = nativeImage.createFromPath(iconPath);
  const png = icon.isEmpty() ? "" : icon.resize({ width: 48, height: 48 }).toPNG().toString("base64");
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(dynamicIslandHtml(png))}`);
  function dispose() {
    if (closed) return; closed = true;
    controller.dispose();
    if (registered) globalShortcut.unregister(shortcut);
    powerMonitor.removeListener("lock-screen", suspend); powerMonitor.removeListener("suspend", suspend);
    powerMonitor.removeListener("unlock-screen", resume); powerMonitor.removeListener("resume", resume);
    screen.removeListener("display-metrics-changed", reposition); screen.removeListener("display-removed", reposition);
  }
  win.on("closed", dispose);
  return { window: win, controller, dispose() { dispose(); if (!win.isDestroyed()) win.destroy(); } };
}
