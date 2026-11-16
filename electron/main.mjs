import { createPreviewTestingBridge } from "./preview-testing.mjs";
import { capturePreviewPNG } from "./preview-browser.mjs";
import { createBackgroundMode } from "./background.mjs";
import { startScheduleNotifications } from "./schedule-notifications.mjs";
import { app, Tray, Menu, nativeImage, Notification, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell, systemPreferences, utilityProcess, webContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";

// The compiled server and the packaged main process share this module from
// Resources/electron. electron-builder omits it from app.asar when it is also
// declared as an extra resource.
const { registerProjectsIpc } = await import(
  app.isPackaged
    ? pathToFileURL(path.join(process.resourcesPath, "electron", "projects.mjs")).href
    : "./projects.mjs",
);

app.name = "Gerer Build Studio";

// One instance per user: a second copy would start a second harness server
// against the same ~/.gbs and both would overwrite each other's files.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8899;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
let backgroundMode = null;
let stopScheduleNotifications = () => {};

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the platform log dir (macOS: ~/Library/Logs/Gerer
// Build Studio, Console.app-visible; Windows: %APPDATA%\Gerer Build
// Studio\logs), which is also why stdio is piped, not inherited — under a
// Finder launch the parent's stdio leads nowhere and a failed boot is
// otherwise undiagnosable.
// resolved lazily: the logs path is only reliable once Electron has set up
const logDir = () => app.getPath("logs");
let logStream = null;
function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(logDir(), { recursive: true });
      logStream = fs.createWriteStream(path.join(logDir(), "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      GBS_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      GBS_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.once("spawn", () => slog(`spawned pid=${proc.pid}`));
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    slog(`exited code=${code}`);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "gerer-build-studio" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8899, 18899, 28899]) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function errorPage() {
  const logFile = escapeHtml(path.join(logDir(), "server.log"));
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui,'Segoe UI',sans-serif"><div style="text-align:center;max-width:420px"><h2 style="font-weight:600;margin:0 0 8px">Couldn't start the Gerer Build Studio server</h2><p style="color:#fcfcfc99;line-height:1.5">Another program may be using its ports (8899, 18899, 28899). Quit and reopen Gerer Build Studio. If it keeps happening, restart your computer.</p><p style="color:#fcfcfc66;font-size:12px;line-height:1.5;word-break:break-all">Details: ${logFile}</p></div></body>`,
    )
  );
}

// Links the app hands to the OS. Anything else (file:, smb:, custom app
// schemes) could launch local programs, so it is dropped.
function openExternalSafely(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    /* not a URL */
  }
}

// webContents ids of the mobile-preview <webview> guests — the only ones the
// renderer may ask to screenshot
const previewGuestIds = new Set();
let previewTestingBridge = null;

async function loadDevUrl(win, url) {
  for (let i = 0; i < 40; i++) {
    if (win.isDestroyed()) return;
    try {
      await win.loadURL(url);
      return;
    } catch {
      if (win.isDestroyed()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    // frameless on both platforms: inset traffic lights on macOS; on
    // Windows the overlay (min/max/close, top-right — the renderer's
    // header leaves it room, see ChatView)
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 40 },
        }),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      // Enables the <webview> tag for the mobile device preview panel.
      // Every guest attached through it is re-locked down in
      // will-attach-webview below, regardless of what the renderer requests.
      webviewTag: true,
    },
  });

  backgroundMode?.attach(win);
  previewTestingBridge?.attachWindow(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  // The window only ever shows the app. A link or redirect that would
  // navigate it elsewhere opens in the browser instead.
  const appOrigin = new URL(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
  win.webContents.on("will-navigate", (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    if (origin === appOrigin) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  // Mobile preview panel hardening: force guest webPreferences before
  // attach (a compromised/careless renderer can't loosen these by editing
  // the <webview> tag's attributes), and keep the guest from navigating
  // the app out of the preview or popping new windows.
  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
  });

  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const guestId = guestWebContents.id;
    previewGuestIds.add(guestId);
    guestWebContents.once("destroyed", () => previewGuestIds.delete(guestId));
    guestWebContents.setWindowOpenHandler(() => ({ action: "deny" }));
    guestWebContents.on("will-navigate", (navEvent, url) => {
      if (!/^https?:/i.test(url)) navEvent.preventDefault();
    });
  });

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : errorPage());
  } else {
    loadDevUrl(win, DEV_URL);
  }
  return win;
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Mobile preview screenshots. Visible-area capture uses the normal
// capturePage() API; full-page capture needs the CDP debugger to grab
// content beyond the current viewport (Page.captureScreenshot with
// captureBeyondViewport), since capturePage() can only see what's rendered.
ipcMain.handle("webview:screenshot", async (_event, { webContentsId, fullPage }) => {
  if (!previewGuestIds.has(webContentsId)) return null;
  const wc = webContents.fromId(webContentsId);
  if (!wc) return null;
  return `data:image/png;base64,${await capturePreviewPNG(wc, Boolean(fullPage))}`;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
ipcMain.handle("perm:status", () => ({
  mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
}));
ipcMain.handle("perm:request-mic", async () => {
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (process.platform === "win32") {
    const winPanes = { mic: "ms-settings:privacy-microphone", speech: "ms-settings:privacy-speech" };
    return winPanes[pane] ? shell.openExternal(winPanes[pane]) : undefined;
  }
  if (process.platform !== "darwin") return undefined;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
  };
  return shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
  );
});

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  registerCuaIpc();
  registerUpdaterIpc();
  registerProjectsIpc({ ipcMain, dialog, shell, dataDir: app.getPath("userData") });
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  // The CUA driver is macOS-only.
  if (process.platform === "darwin") startCua().catch((e) => console.error("[cua] start failed:", e));
  if (app.isPackaged) serverReady = await startServerPackaged();
  backgroundMode = createBackgroundMode({ app, ipcMain, Tray, Menu, nativeImage, iconPath: APP_ICON, getWindows: () => BrowserWindow.getAllWindows(), openWindow: createWindow });
  stopScheduleNotifications = startScheduleNotifications(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : new URL(DEV_URL).origin, Notification);
  previewTestingBridge = createPreviewTestingBridge({ ipcMain, webContents, guestIds: previewGuestIds, dataDir: process.env.GBS_DATA_DIR ?? path.join(app.getPath("home"), ".gbs") });
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    backgroundMode?.open();
  });
});

app.on("window-all-closed", () => {
  if (!backgroundMode?.enabled()) app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
// The harness server gets the same courtesy: it flushes and stops its agent
// processes on SIGTERM, so wait (briefly) for it to exit before quitting.
function stopServer() {
  const proc = serverProc;
  serverProc = null;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  void previewTestingBridge?.dispose();
  if (cuaCleanedUp) return;
  stopScheduleNotifications();
  e.preventDefault();
  Promise.allSettled([stopServer(), stopCua()]).finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
