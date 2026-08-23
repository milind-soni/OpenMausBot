import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { buildDiagnosticsReport, decodeLogTail, diagnosticsFileName } from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { activateExistingWindow } from "./single-instance.mjs";
import capabilitiesModule from "./capabilities.cjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
const DEFAULT_COMPOSIO_BROKER_URL = "https://openmausbot-composio.milindsoni201.workers.dev";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
let desktopViewerWindow = null;
let desktopViewerOwner = null;
let desktopViewerContextId = null;

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready.
if (process.platform === "linux") app.setDesktopName("com.openmausbot.app.desktop");

// One instance per user: without this lock a second launch forks a second
// harness server on a fallback port and splits data dirs in two. The loser
// exits before any child or window exists; the winner surfaces itself.
if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] OpenMausBot is already running — focusing that window");
  process.exit(0);
}
app.on("second-instance", () => {
  activateExistingWindow(BrowserWindow.getAllWindows());
});

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
let secureCredentials = {};

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

async function loadSecureCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE) || !(await safeStorage.isAsyncEncryptionAvailable())) return {};
    const decrypted = await safeStorage.decryptStringAsync(fs.readFileSync(CREDENTIALS_FILE));
    return JSON.parse(decrypted.result);
  } catch (error) {
    slog(`credential load failed: ${error?.message ?? error}`);
    return {};
  }
}

async function saveSecureCredentials(credentials) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().startsWith("ak_")) {
      if (!secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKey.trim();
        await saveSecureCredentials(secureCredentials);
      }
      config.composio.apiKey = "";
      changed = true;
    } else if (typeof apiKey === "string" && apiKey.trim()) {
      config.composio.apiKey = "";
      changed = true;
    }
    // These were the old Connect credential and endpoint. They are no longer
    // read; remove them during the upgrade so an unused secret is not left in
    // plaintext indefinitely.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

// The remaining workspace credentials (xai/box/voice/OpenCode Go keys) get
// the same at-rest treatment as the Composio key above. New packaged-app
// saves go straight through credential:set below; this boot-time sweep also
// migrates plaintext left by older versions or direct development clients.
// See workspace-credentials.mjs for the exact rules.
async function secureWorkspaceConfig() {
  const dataDir = process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    // credentials.bin first: if the OS store cannot take the secrets, the
    // plaintext stays put and the next boot retries — losing the only copy
    // is the one unacceptable outcome
    if (migrated.credentialsChanged) await saveSecureCredentials(migrated.credentials);
    secureCredentials = migrated.credentials;
    if (!migrated.configChanged) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

function composioBrokerUrl() {
  const configured = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  return configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : "");
}

async function ensureManagedComposioCredentials() {
  const brokerUrl = composioBrokerUrl();
  if (!brokerUrl) return;
  if (/^[0-9a-f]{64}$/.test(secureCredentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetch(`${brokerUrl}/v1/me`, {
        headers: { authorization: `Bearer ${secureCredentials.composioBrokerToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (check.ok) return;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand
      // the user's already-authorized accounts under a new installation.
      if (check.status !== 401) return;
      delete secureCredentials.composioBrokerToken;
      delete secureCredentials.composioInstallationId;
    } catch {
      return;
    }
  }
  try {
    const response = await fetch(`${brokerUrl}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!/^[0-9a-f]{64}$/.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    secureCredentials.composioBrokerToken = body.token;
    secureCredentials.composioInstallationId = body.installationId;
    await saveSecureCredentials(secureCredentials);
    slog("connected-apps installation registered");
  } catch (error) {
    // Never block app startup on a hosted integration. A user running their
    // own Composio project key still has the local fallback below.
    slog(`connected-apps registration failed: ${error?.message ?? error}`);
  }
}

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/OpenMausBot on macOS,
// Console.app-visible; %APPDATA%\OpenMausBot\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
let logStream = null;
import {
  companionEnabledAtRest,
  companionPairing,
  companionCloudDesktopAccess,
  companionRevoke,
  companionState,
  rememberCompanionEnabled,
  startCompanion,
  stopCompanion,
} from "./companion.mjs";

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

const LOG_TAIL_BYTES = 256 * 1024;

function readLogTail(logPath) {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const handle = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return decodeLogTail(buffer, start > 0);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

// Everything the bug-report bundle needs. The config summary comes from the
// server's own booleans-only /api/config status (credentials are never
// echoed), and the log goes through the redactor in diagnostics.mjs — so the
// file is safe to paste into a public issue even if a future log line ever
// carried a secret.
async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readLogTail(logPath);
  return buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
    },
    configSummary: serverStatus ?? {},
    logTail: log?.tail ?? "",
  });
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_RESOURCES_PATH: process.resourcesPath,
      OMB_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
      OMB_PORT: String(port),
      OMB_USER_DATA: app.getPath("userData"),
      ...(secureCredentials.composioApiKey
        ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
        : {}),
      // one env var per stored workspace secret (xai/box/voice/OpenCode Go);
      // the server prefers these over config.json, whose plaintext fields
      // the boot migration has deleted
      ...workspaceCredentialEnv(secureCredentials),
      ...(composioBrokerUrl() && secureCredentials.composioBrokerToken
        ? {
            OMB_COMPOSIO_BROKER_URL: composioBrokerUrl(),
            OMB_COMPOSIO_BROKER_TOKEN: secureCredentials.composioBrokerToken,
          }
        : {}),
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
        if (body?.app === "openmausbot" && body.pid === proc.pid && body.static) return proc;
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
    for (const port of [8799, 18799, 28799]) {
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

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen OpenMausBot — if it keeps happening, restart your computer.</p></div></body>`,
  );

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  // An empty response intentionally rejects the renderer request, and Electron
  // can surface that rejection by throwing from the callback. A selected
  // source should never fail delivery, so keep that path visible in logs.
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

function notifyDesktopViewer(open) {
  if (!desktopViewerOwner?.isDestroyed()) {
    desktopViewerOwner.send("desktop-viewer:state", {
      open,
      contextId: desktopViewerContextId,
    });
  }
}

function desktopViewerErrorPage(message, retryUrl) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta name="color-scheme" content="dark"><title>Desktop unavailable</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
        <main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">Couldn't open the live desktop</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escape(message)}</p>
        <a href="${escape(retryUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">Open in browser</a></main>
      </body>`)
  );
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId) {
  if (!owner || owner.isDestroyed()) throw new Error("The OpenMausBot window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";

  // Desktop URLs contain rotating access tokens. A newly minted URL replaces
  // the old viewer instead of being retained anywhere after its window closes.
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  desktopViewerOwner = owner.webContents;
  desktopViewerContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    modal: true,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Keep provider cookies away from the app renderer and discard them on
      // app exit. The secret-bearing URL is sufficient to authenticate.
      partition: "openmausbot-desktop-viewer",
    },
  });
  desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;

  // VNC needs rendering, keyboard/mouse input and WebSockets — never host
  // camera, microphone, geolocation, notifications, USB, or other privileged
  // browser capabilities in this remote-content window.
  viewer.webContents.session.setPermissionCheckHandler(() => false);
  viewer.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  viewer.on("ready-to-show", () => viewer.show());
  viewer.on("closed", () => {
    if (desktopViewerWindow !== viewer) return;
    desktopViewerWindow = null;
    notifyDesktopViewer(false);
    desktopViewerOwner = null;
    desktopViewerContextId = null;
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = desktopViewerUrl(target);
      void shell.openExternal(external.toString());
    } catch {
      // Ignore non-web and insecure URLs from the remote viewer.
    }
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {
      // Keep privileged or malformed navigation out of the viewer.
    }
  });
  viewer.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || viewer.isDestroyed() || failedUrl.startsWith("data:")) return;
    void viewer.loadURL(desktopViewerErrorPage(description || "The viewer did not respond.", url.toString()));
  });

  notifyDesktopViewer(true);
  void viewer.loadURL(url.toString()).catch((error) => {
    if (viewer.isDestroyed()) return;
    void viewer.loadURL(desktopViewerErrorPage(error?.message ?? "The viewer did not respond.", url.toString()));
  });
  return true;
}

ipcMain.on("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
});

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    // macOS keeps inset traffic lights, Windows keeps its custom overlay,
    // and Linux uses the native desktop title bar and window controls.
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            // height MUST match the ChatView/GroupView header strip (px-5 py-3
            // around a 36px control row = 60). Windows draws the caption buttons
            // to fill the overlay, so anything shorter leaves a dead band under
            // them and anything taller overhangs the header.
            titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 60 },
          }
        : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (process.env.OMB_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.OMB_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.ogb.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, healthResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.ogb.localControl.retry();
              capabilities = await window.ogb.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.OMB_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.OMB_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// Local-control screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
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
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
ipcMain.handle("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
});

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
ipcMain.handle("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// One-click bug-report bundle. Secrets are never read; the report is
// redacted again on the way out (diagnostics.mjs). null means the user
// cancelled the save dialog.
ipcMain.handle("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
});

ipcMain.handle("desktop:open-external", async (_event, rawUrl) => {
  if (typeof rawUrl !== "string") throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  await shell.openExternal(url.toString());
  return true;
});

// The Box VNC viewer must be a top-level page for its token exchange. A
// sandboxed modal BrowserWindow satisfies that requirement while keeping the
// live desktop inside OpenMausBot instead of sending the person to a browser.
ipcMain.handle("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
});

ipcMain.handle("perm:status", () => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  // own-property lookup only — a renderer-supplied "__proto__"/"constructor"
  // would otherwise resolve up the prototype chain to a truthy object
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

ipcMain.handle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
ipcMain.handle("speech:stop", () => {
  if (nativeActions.appleSpeech) stopSpeech();
});
ipcMain.handle("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
});

// ── companion sidecar ──────────────────────────────────────────────────
// The renderer gets these five and nothing else: it can turn the companion
// on and off, look at it, open or cancel a pairing window, and remove a
// device. It cannot reach the sidecar's control port itself.
ipcMain.handle("companion:state", () => companionState());
ipcMain.handle("companion:start", async () => {
  const state = await startCompanion({
    resourcesPath: process.resourcesPath,
    harnessPort: SERVER_PORT,
    log: slog,
  });
  // Remember only a start that worked: persisting the intent behind a failed
  // one would greet every launch with the same error for a toggle the panel
  // showed as off.
  if (state.enabled && !state.error) rememberCompanionEnabled(true);
  return state;
});
ipcMain.handle("companion:stop", () => {
  rememberCompanionEnabled(false);
  return stopCompanion();
});
ipcMain.handle("companion:pairing", (_event, open) => companionPairing(Boolean(open)));
ipcMain.handle("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)),
);
ipcMain.handle("companion:revoke", (_event, deviceId) => companionRevoke(deviceId));

ipcMain.handle("desktop:capabilities", async () =>
  desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  }),
);

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
};

ipcMain.handle("credential:set", async (_event, name, value) => {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const previousCredentials = secureCredentials;
  if (app.isPackaged) {
    const nextCredentials = { ...secureCredentials };
    if (secret) nextCredentials[name] = secret;
    else delete nextCredentials[name];
    // Commit the encrypted value before the server makes it live. If
    // validation or reload fails below, restore the previous store so the
    // next launch cannot disagree with the response the user saw.
    await saveSecureCredentials(nextCredentials);
    secureCredentials = nextCredentials;
  }
  try {
    // In development the server is a separately launched process, so it
    // cannot receive credentials from Electron at boot. Keep its established
    // local config path there; production always uses the encrypted store.
    const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchFor(secret)),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
    return body;
  } catch (error) {
    if (app.isPackaged) {
      await saveSecureCredentials(previousCredentials);
      secureCredentials = previousCredentials;
    }
    throw error;
  }
});

async function broadcastDesktopCapabilities() {
  const capabilities = desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  });
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("desktop:capabilities-changed", capabilities);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  if (app.isPackaged) {
    secureCredentials = await loadSecureCredentials();
    await secureComposioConfig();
    await secureWorkspaceConfig();
    await ensureManagedComposioCredentials();
  }
  // Display capture remains user-initiated. The renderer first sends a
  // short-lived one-shot intent, then calls getDisplayMedia in the same click.
  // The handler binds that request to the same frame/origin, rejects audio,
  // and requires Electron's active user-gesture signal.
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        displayMediaRequestCount += 1;
        if (!displayMediaGuard.consume(request, rendererOrigin())) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        const capabilities = desktopCapabilities({
          platform: process.platform,
          env: process.env,
          packaged: app.isPackaged,
        });
        const captureHost =
          process.platform === "darwin" ? "darwin" : capabilities.host.session;
        if (!capabilities.screenPreview.available) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = selectCaptureSource({
              sources,
              host: captureHost,
              primaryDisplayId:
                process.platform === "linux" && captureHost === "x11"
                  ? screen.getPrimaryDisplay().id
                  : null,
            });
            if (!source) {
              console.warn(
                `[screen-preview] rejected ${captureHost} source set (${sources.length} candidates)`,
              );
            }
            respondToDisplayMediaRequest(callback, source ? { video: source } : {});
          })
          .catch((error) => {
            console.warn("[screen-preview] source discovery failed:", error);
            respondToDisplayMediaRequest(callback, {});
          });
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  androidDevice.registerIpc(ipcMain);
  registerUpdaterIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  cuaReady =
    process.platform === "darwin" || process.platform === "linux"
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  if (app.isPackaged) serverReady = await startServerPackaged();
  // The companion the user left on comes back without anyone finding the
  // toggle again — one attempt, after the harness port is settled, with the
  // exact options the IPC handler uses. A failure surfaces in companionState
  // (the panel shows the error) rather than retrying; and it never delays
  // the window.
  if (serverReady && companionEnabledAtRest()) {
    void startCompanion({ resourcesPath: process.resourcesPath, harnessPort: SERVER_PORT, log: slog });
  }
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
// Cap the defer so a wedged daemon cannot keep the app alive forever.
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  // the sidecar holds a socket that is reachable from off this machine —
  // it should not outlive the window by even a moment
  void stopCompanion();
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  if (nativeActions.appleSpeech) stopSpeech();
  const cleanup = Promise.race([
    stopCua().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
