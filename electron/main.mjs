import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { assemblyAICredential, mintAssemblyAIStreamingToken } from "./assemblyai.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import {
  recorderPermissionStatus,
  saveSkillRecording,
  startRecorder,
  stopRecorder,
} from "./skill-recorder.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";
import { attachUpdaterWindow, startUpdater, registerUpdaterIpc } from "./updater.mjs";
import {
  buildDiagnosticsReport,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
} from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { activateExistingWindow, releaseSingleInstanceLock } from "./single-instance.mjs";
import { pollServerIdentity } from "./server-boot-probe.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { windowChromeOptions } from "./window-chrome.mjs";
import { defaultSaveName, withSavableFile } from "./save-file.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
} from "./managed-composio.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  resolveManagedCompanionGuardian,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import {
  createPhoneSecretSaveCoordinator,
  createPhoneSecretIdentity,
  decodePhoneSecretSaveRequest,
  phoneSecretPrivateKeyMessage,
  readPhoneSecretIdentity,
  withPhoneSecretIdentity,
} from "./phone-secret-identity.mjs";
import {
  desktopCompanionAccess,
  desktopCompanionRendererArguments,
  pairDesktopCompanion,
  startDesktopCompanionRelay,
  withDesktopCompanionAccess,
  withoutDesktopCompanionAccess,
} from "./desktop-companion-client.mjs";
import { isKnownSkin } from "./skin-overlay.cjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  companionAccountCleanupPending,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import capabilitiesModule from "./capabilities.cjs";
import environmentsModule from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";
import { buildApplicationMenu } from "./menu.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");
const { createDesktopWorkspaceManager } = require("./desktop-workspace.cjs");
const { createTrustedApprovalModeCoordinator } = require("./approval-trusted-mode.cjs");
const { DESKTOP_MUTATION_HEADER, desktopServerHeaders } = require("./desktop-server-auth.cjs");
const { createCuaConnectionStore: createDescriptorStore } = require("./cua-connection.cjs");
const { MIN_BOUNDS, normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

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
let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;
const browserConnectionStore = createDescriptorStore({
  getUserData: () => app.getPath("userData"),
  fileName: "browser-connection.json",
});
let pendingPackageInstallUrl = packageUrlFromCommandLine(process.argv);
let mainWindow = null;
let unreadCount = 0;
let unreadOverlayIcon = null;

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`window state save failed: ${error?.message ?? error}`);
  }
}

function installWindowStatePersistence(win) {
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", flush);
}

function applyUnreadBadge(win = mainWindow) {
  const count = normalizeUnreadCount(unreadCount);
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    unreadOverlayIcon ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !unreadOverlayIcon.isEmpty() ? unreadOverlayIcon : null,
      count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations",
    );
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
}

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready. Ubuntu also
// uses Chromium's software renderer: the supported machine reproduced two
// NVIDIA/libGLES GPU-process crashes that left an invisible focused window
// intercepting input. This app is not graphics-heavy, so reliability wins.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.setDesktopName("com.openmausbot.app.desktop");
}

// One instance per user: without this lock a second launch forks a second
// harness server on a fallback port and splits data dirs in two. The loser
// exits before any child or window exists; the winner surfaces itself.
if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] OpenMausBot is already running — focusing that window");
  process.exit(0);
}

// An update install can start the new build while this process is still
// inside the deferred before-quit cleanup further down, still holding the
// lock; the relaunched copy then loses the check above and exits, leaving a
// dead Starting window with no server. Electron's native autoUpdater emits
// before-quit-for-update only when an update drives the quit (the vendored
// electron-updater re-emits it on the same object before app.quit()), so the
// lock is released on that event — never in before-quit, where a normal quit
// would allow a concurrent second instance.
nativeAutoUpdater.on("before-quit-for-update", () => releaseSingleInstanceLock(app));

function deliverPackageInstall(win) {
  if (!pendingPackageInstallUrl || !win || win.isDestroyed()) return;
  if (win.webContents.isLoadingMainFrame()) return;
  // A package installs into THIS computer's workspace, so it is handed to the
  // local UI only. Showing a remote server: switch back to Local first; the
  // pending link is delivered when that page finishes loading.
  let showingLocal = false;
  try {
    showingLocal = new URL(win.webContents.getURL()).origin === rendererOrigin();
  } catch {}
  if (!showingLocal) {
    if (activeEnvironment(environmentsState)) switchEnvironment(LOCAL_ID);
    return;
  }
  win.webContents.send("package:install", pendingPackageInstallUrl);
  pendingPackageInstallUrl = null;
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
  return true;
}

app.on("open-url", (event, url) => {
  if (!queuePackageInstall(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
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
let secureCredentialState = null;
let desktopDataDirLease = null;
const utilityServerExits = new WeakMap();
const UTILITY_SERVER_STOP_TIMEOUT_MS = 6_500;
const trustedApprovalMode = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
const desktopMutationToken = randomBytes(32).toString("base64url");
const companionMutationToken = randomBytes(32).toString("base64url");

function desktopDataDir() {
  // Match the historical desktop fallback for an unset or empty override,
  // then pass this exact resolved path to the utility child. server/config.ts
  // intentionally treats an empty OMB_DATA_DIR differently, so inheriting it
  // without normalization would lease one directory and write another.
  return process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
}

async function stopUtilityServer(proc, timeoutMs = UTILITY_SERVER_STOP_TIMEOUT_MS) {
  if (!proc) return true;
  const exited = utilityServerExits.get(proc);
  if (!exited) return false;
  try {
    proc.kill();
  } catch {
    // The tracked exit promise below is still the authority. A throw can mean
    // the process crossed the exit boundary immediately before kill().
  }
  let timer;
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
let phoneSecretIdentity = null;
let desktopRemoteAccess = null;
let desktopCompanionRelay = null;

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

/** Set once per launch: true when the store could not be READ, which is not
 * the same as the user having saved nothing. Everything downstream — the
 * server's view of "configured", and whether we may register a fresh
 * installation — keys off this rather than off an empty object. */
let credentialStoreUnavailable = false;

async function loadSecureCredentials() {
  const result = await readSecureCredentials({
    exists: () => fs.existsSync(CREDENTIALS_FILE),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => fs.readFileSync(CREDENTIALS_FILE),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  credentialStoreUnavailable = result.status === "unavailable";
  if (credentialStoreUnavailable) {
    // Deliberately loud. A silent {} here is what made a keychain hiccup
    // look like "your connected apps are gone".
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  // A failed read means we do not know what the existing encrypted document
  // contains. Never derive a replacement from that incomplete view: boot
  // migrations must leave plaintext in place so a later launch can retry.
  if (credentialStoreUnavailable) {
    throw new Error("The operating-system credential store could not be read this launch");
  }
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
  const dataDir = desktopDataDir();
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

// The remaining workspace credentials (xai/box/voice/OpenCode keys) get
// the same at-rest treatment as the Composio key above. New packaged-app
// saves go straight through credential:set below; this boot-time sweep also
// migrates plaintext left by older versions or direct development clients.
// See workspace-credentials.mjs for the exact rules.
async function secureWorkspaceConfig() {
  const dataDir = desktopDataDir();
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
  return normalizeManagedComposioBrokerUrl(
    configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : ""),
  );
}

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/OpenMausBot on macOS,
// Console.app-visible; %APPDATA%\OpenMausBot\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
const DESKTOP_CRASH_LOG = path.join(LOG_DIR, "desktop-crashes.log");
const DESKTOP_CRASH_LOG_MAX_BYTES = 512 * 1024;
let logStream = null;
let desktopShutdownStarted = false;
import {
  companionAdvertisedHostedUrl,
  companionEnabledAtRest,
  companionOriginTarget,
  companionPairing,
  companionRefreshTailscale,
  companionCloudDesktopAccess,
  companionRevoke,
  companionRunning,
  companionState,
  rememberCompanionEnabled,
  rememberCompanionKeepAwake,
  setCompanionHostedUrl,
  setCompanionLifecycleListener,
  startCompanion,
  stopCompanion,
} from "./companion.mjs";

/** IPC that controls this computer, its files, its logins or its updater is
 * answered only for the local server's UI (electron/local-origin.cjs). A
 * remote server's page gets a reduced bridge (preload.cjs) in the first
 * place; this is the second wall, shared with cua.mjs, updater.mjs and
 * android-device.mjs. Declared before any handler registration below: a
 * const declared later would be in its temporal dead zone at module load.
 */
const { isLocalSender: senderIsLocal, localOnly, localOnlySync, setLocalOrigin } = localOriginModule;

let companionPowerBlocker = null;

function syncCompanionKeepAwake(companionEnabled, keepAwake) {
  const shouldBlock = companionEnabled && keepAwake;
  if (shouldBlock && companionPowerBlocker === null) {
    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && companionPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
    companionPowerBlocker = null;
  }
}

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

// The server stream is intentionally asynchronous, but a fatal main-process
// exception may terminate Electron before such a write is flushed. Crash
// metadata gets its own tiny synchronous file. The formatter admits only a
// fixed set of fields, so renderer URLs, page titles, exception messages and
// absolute paths never land on disk or in a public bug report.
function recordDesktopCrash(event) {
  let handle = null;
  try {
    const record = formatDesktopCrashRecord(event);
    if (!record) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(DESKTOP_CRASH_LOG);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(DESKTOP_CRASH_LOG, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      // O_EXCL makes first creation race-safe on Windows, where O_NOFOLLOW is
      // unavailable, as well as on POSIX.
      try {
        handle = fs.openSync(
          DESKTOP_CRASH_LOG,
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
      } catch {
        return;
      }
    }

    const stats = fs.fstatSync(handle);
    // A hard-linked or non-regular target is not an app-owned crash log.
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    // A renderer crash loop must not grow a persistent log without bound.
    // The diagnostics export reads only a bounded tail, so dropping older
    // crash metadata here preserves the useful part of the record.
    if (stats.size >= DESKTOP_CRASH_LOG_MAX_BYTES) fs.ftruncateSync(handle, 0);
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, `[${new Date().toISOString()}] ${record}\n`, "utf8");
  } catch {
    /* crash diagnostics must never change app lifecycle */
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

// uncaughtExceptionMonitor observes Node's fatal path without converting it
// into a handled exception. In particular, an unhandled rejection still
// follows Node's normal exit behaviour after its metadata is persisted.
installDesktopCrashListeners({
  appTarget: app,
  processTarget: process,
  record: recordDesktopCrash,
  isShuttingDown: () => desktopShutdownStarted,
  mainWebContents: () => mainWindow?.webContents ?? null,
});

// ── managed companion connection ───────────────────────────────────────
// Account onboarding provisions one remote Cloudflare Tunnel per desktop,
// then calls reconcileManagedCompanionEndpointProvision below. Only the
// endpoint is public state. The connector token stays in credentials.bin and
// is passed to cloudflared through a private token file by the lifecycle
// module — never through IPC, argv, the environment, or logs.
let managedCompanionConnector = null;
let companionAccountService = null;
let companionDesiredThisLaunch = false;
let companionLaunchGeneration = 0;
let advertisementTransition = Promise.resolve();

/** The one serialized credential mutation hook. Account onboarding and every
 * other runtime credential writer share this state, so persisting a tunnel
 * token can never overwrite an API key saved at the same time (or vice
 * versa). */
export async function updateSecureCredentialDocument(derive, afterPersist) {
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  try {
    return await secureCredentialState.update(derive, afterPersist);
  } finally {
    secureCredentials = secureCredentialState.read();
  }
}

async function ensurePhoneSecretIdentity() {
  const existing = readPhoneSecretIdentity(secureCredentialState?.read() ?? secureCredentials);
  if (existing) {
    phoneSecretIdentity = existing;
    return existing;
  }
  try {
    const created = await createPhoneSecretIdentity();
    await updateSecureCredentialDocument((credentials) =>
      withPhoneSecretIdentity(credentials, created),
    );
    phoneSecretIdentity = created;
    return created;
  } catch (error) {
    // Companion chat remains available. Pairing simply omits the public key,
    // and mobile cards explain that secure entry needs the desktop until the
    // OS credential store is available on a later launch.
    phoneSecretIdentity = null;
    slog(`phone credential key unavailable: ${error?.message ?? error}`);
    return null;
  }
}

function publicManagedCompanionState() {
  const access = managedCompanionTunnelAccess(secureCredentials);
  const status = managedCompanionConnector?.getStatus();
  if (status) {
    const publicState = {
      status: status.status,
      configured: status.configured,
      ready: status.ready,
    };
    if (status.endpoint) publicState.url = status.endpoint;
    if (status.retryInMs) publicState.retryInMs = status.retryInMs;
    if (status.error) publicState.error = status.error;
    return publicState;
  }
  return access
    ? { status: "stopped", configured: true, ready: false, url: access.endpoint }
    : { status: "unconfigured", configured: false, ready: false };
}

function decorateDesktopCompanionState(state) {
  // The panel polls this state, so a sidecar that exited on its own releases
  // the blocker within one poll instead of keeping the computer awake forever.
  syncCompanionKeepAwake(state.enabled && !state.error, state.keepAwake === true);
  return { ...state, managedConnection: publicManagedCompanionState() };
}

async function desktopCompanionState() {
  return decorateDesktopCompanionState(await companionState());
}

function companionLaunchOptions(hostedUrl = null) {
  return {
    resourcesPath: process.resourcesPath,
    harnessPort: SERVER_PORT,
    mutationToken: companionMutationToken,
    hostedUrl,
    // Only an embedded server receives the private half over its utility
    // port. A dev server launched in another terminal cannot decrypt, so it
    // must not advertise a public key and strand the phone on a dead path.
    secretPublicKey: app.isPackaged && serverProc ? phoneSecretIdentity?.publicKey ?? null : null,
    log: slog,
  };
}

function ensureManagedCompanionConnector() {
  if (managedCompanionConnector) return managedCompanionConnector;
  managedCompanionConnector = createManagedCompanionTunnel({
    binaryPath: resolveCloudflaredBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    guardianEntry: resolveManagedCompanionGuardian({ appPath: app.getAppPath() }),
    runtimeExecutable: process.execPath,
    runtimeRoot: path.join(app.getPath("userData"), "managed-companion-tunnel"),
    onChange: (status) => {
      slog(`managed companion connection ${status.status}`);
      if (!companionDesiredThisLaunch) return;
      void reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
    },
    log: slog,
  });
  return managedCompanionConnector;
}

/** Publish a hosted address only after its connector has passed public health
 * verification. Updating the owned sidecar in place preserves the exact
 * private origin generation and cannot invalidate an open pairing window. */
function reconcileCompanionAdvertisement(
  endpoint,
  ownedGeneration = companionLaunchGeneration,
) {
  const normalizedEndpoint = endpoint || null;
  const work = advertisementTransition.then(async () => {
    if (
      ownedGeneration !== companionLaunchGeneration ||
      !companionDesiredThisLaunch ||
      !companionRunning() ||
      companionAdvertisedHostedUrl() === normalizedEndpoint
    ) {
      return desktopCompanionState();
    }
    const updated = await setCompanionHostedUrl(normalizedEndpoint);
    return { ...updated, managedConnection: publicManagedCompanionState() };
  });
  advertisementTransition = work.then(
    () => {},
    () => {},
  );
  return work;
}

async function startManagedCompanionConnection({ waitForVerification = true } = {}) {
  if (companionAccountCleanupPending(secureCredentials)) {
    return publicManagedCompanionState();
  }
  const access = managedCompanionTunnelAccess(secureCredentials);
  if (!access) return publicManagedCompanionState();
  const target = companionOriginTarget();
  if (!target) return publicManagedCompanionState();
  const operation = ensureManagedCompanionConnector().start({ ...access, originTarget: target });
  if (!waitForVerification) {
    void operation.catch(() => {});
    return publicManagedCompanionState();
  }
  const status = await operation;
  await reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
  return publicManagedCompanionState();
}

async function startDesktopCompanion({ waitForHosted = true, remember = true } = {}) {
  companionDesiredThisLaunch = true;
  companionLaunchGeneration += 1;
  // Direct LAN comes up first. The hosted endpoint is added in place only
  // after the guardian has verified the public route to this exact sidecar.
  const localState = await startCompanion(companionLaunchOptions());
  if (!localState.enabled || localState.error) {
    companionDesiredThisLaunch = false;
    return desktopCompanionState();
  }
  if (remember) rememberCompanionEnabled(true);
  await startManagedCompanionConnection({ waitForVerification: waitForHosted });
  return desktopCompanionState();
}

async function stopDesktopCompanion({ remember = true } = {}) {
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  if (remember) rememberCompanionEnabled(false);
  syncCompanionKeepAwake(false, false);
  await managedCompanionConnector?.stop();
  await stopCompanion();
  return desktopCompanionState();
}

async function refreshDesktopCompanionTailscale() {
  if (!companionRunning()) {
    const started = await startDesktopCompanion({ waitForHosted: false });
    if (!started.enabled || started.error) return started;
  }
  return decorateDesktopCompanionState(await companionRefreshTailscale());
}

setCompanionLifecycleListener(({ expected, pid }) => {
  if (expected) return;
  slog(`owned companion exited unexpectedly pid=${pid ?? "unknown"}`);
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  syncCompanionKeepAwake(false, false);
  // stop() invalidates the guardian's owner pipe synchronously, before the
  // sidecar module removes this generation's private socket.
  void managedCompanionConnector?.stop().catch(() => {});
});

/** Narrow main-process hook for the account onboarding flow. Its return value
 * is explicitly secret-free and can be used to refresh the settings panel. */
export async function reconcileManagedCompanionEndpointProvision(provision) {
  await updateSecureCredentialDocument((credentials) =>
    withManagedCompanionTunnelAccess(credentials, provision),
  );
  if (companionDesiredThisLaunch) {
    await startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

/** Called only after the control plane has revoked/deleted the endpoint. */
export async function clearManagedCompanionEndpointCredentials() {
  await updateSecureCredentialDocument((credentials) =>
    withoutManagedCompanionTunnelAccess(credentials),
  );
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

/** Account sign-out must stop advertising the hosted route before it asks
 * the control plane to revoke anything, but it must not erase the retry
 * credentials until that remote cleanup is durably scheduled. */
async function stopManagedCompanionEndpointLocally() {
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

async function activatePersistedManagedCompanionEndpoint() {
  if (companionDesiredThisLaunch) {
    return startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

function installationDisplayName() {
  const hostname = [...os.hostname()]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  return hostname.slice(0, 80) || "This computer";
}

function ensureCompanionAccountService() {
  if (companionAccountService) return companionAccountService;
  const baseURL = resolveCompanionControlPlaneURL({
    isPackaged: app.isPackaged,
    environment: process.env,
  });
  let client = null;
  if (baseURL) {
    try {
      client = createControlPlaneClient({ baseURL });
    } catch {
      // An invalid explicit override disables hosted access. Direct LAN,
      // Bonjour, and Tailscale pairing remain completely independent.
    }
  }
  companionAccountService = createCompanionAccountService({
    client,
    readCredentials: () => secureCredentialState?.read() ?? secureCredentials,
    updateCredentials: updateSecureCredentialDocument,
    identity: {
      name: installationDisplayName(),
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      appVersion: app.getVersion().slice(0, 64),
    },
    newClientInstanceId: randomUUID,
    activatePersistedEndpoint: activatePersistedManagedCompanionEndpoint,
    stopManagedEndpoint: stopManagedCompanionEndpointLocally,
    managedConnectionState: publicManagedCompanionState,
    companionIsOn: () => companionDesiredThisLaunch,
  });
  return companionAccountService;
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
  const log = readSafeLogTail(logPath);
  const desktopLog = readSafeLogTail(DESKTOP_CRASH_LOG);
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
    desktopLogTail: desktopLog?.tail ?? "",
    logTail: log?.tail ?? "",
  });
}

// Set by startServerPackaged: true only when every failing candidate port was
// taken by another process — decides which error-page message renders.
let serverStartConflictOnly = false;







/** Run one private cleanup request at most once and acknowledge only after
 * Chromium confirms its session data is gone. Duplicate retries join the
 * same promise; a retry whose success ACK was lost receives a cached ACK. */

function syncPhoneSecretKey(proc) {
  const message = phoneSecretPrivateKeyMessage(phoneSecretIdentity);
  if (!message) return;
  try {
    proc.postMessage(message);
  } catch (error) {
    slog(`phone credential key sync failed: ${error?.message ?? error}`);
  }
}

function syncDesktopMutationToken(proc) {
  try {
    proc.postMessage({
      type: "openmausbot:desktop-mutation-token",
      token: desktopMutationToken,
      companionToken: companionMutationToken,
    });
  } catch (error) {
    slog(`desktop mutation capability sync failed: ${error?.message ?? error}`);
  }
}

function installDesktopMutationHeader() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    let ownsTarget = false;
    try {
      const target = new URL(details.url);
      ownsTarget = target.protocol === "http:" &&
        target.hostname === "127.0.0.1" &&
        Number(target.port || 80) === SERVER_PORT;
    } catch {}
    if (!ownsTarget) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        [DESKTOP_MUTATION_HEADER]: desktopMutationToken,
      },
    });
  });
}

const savePhoneSecretOnce = createPhoneSecretSaveCoordinator((target, value) =>
  saveWorkspaceCredential(target, value),
);

function receivePhoneSecretSave(proc, rawMessage) {
  const request = decodePhoneSecretSaveRequest(rawMessage);
  if (!request) return false;
  void savePhoneSecretOnce(request).then((result) => {
    try {
      proc.postMessage(result);
    } catch (error) {
      slog(`phone credential save result failed: ${error?.message ?? error}`);
    }
  });
  return true;
}

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    // The desktop parent owns the durable data-directory lease. Each utility
    // server gets only a private capability that validates that same live
    // owner; fallback-port children must not race to replace the parent lease.
    ...desktopDataDirLease.utilityServerLeaseEnvironment(),
    OMB_DATA_DIR: desktopDataDir(),
    // A packaged utility child must never fall back to a descriptor inherited
    // from the launching shell. It starts fail-closed until this exact main
    // process sends the private in-memory connection after spawn.
    OMB_DESKTOP_PARENT: "1",
    OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    OMB_RESOURCES_PATH: process.resourcesPath,
    OMB_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    OMB_PORT: String(port),
    // the server advertises this to remote clients so version skew is visible
    OMB_APP_VERSION: app.getVersion(),
    OMB_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    // "we could not read your keys" must not reach the UI as "you have none"
    OMB_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    // one env var per stored workspace secret (xai/box/voice/OpenCode Go);
    // the server prefers these over config.json, whose plaintext fields
    // the boot migration has deleted
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.OMB_BROWSER_CONNECTION;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveServerExit;
  utilityServerExits.set(proc, new Promise((resolve) => {
    resolveServerExit = resolve;
  }));
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    try {
      if (trustedApprovalMode.receive(proc, message)) return;
      if (receivePhoneSecretSave(proc, message)) return;
    } catch (error) {
      slog(`desktop private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    syncDesktopMutationToken(proc);
    syncPhoneSecretKey(proc);
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    trustedApprovalMode.rejectProcess(proc);
    resolveServerExit();
    // Capabilities belong to turns in this exact server child. A crash or
    // restart invalidates them before any replacement child receives the
    // browser descriptor.
    slog(`exited code=${code}`);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  // The budget is wall-clock, not a fixed poll count: a healthy boot can take
  // well past 20s on cold machines or when pre-listen network calls stall
  // (issue #506), and reaping an about-to-listen child reads to the user as
  // "something else is using its ports" even though nothing was on them.
  // The probe itself is deadline-bounded (a hung health endpoint cannot wedge
  // us here forever) and reports WHY it gave up, so the error page can tell
  // port conflict apart from slow startup.
  const identity = await pollServerIdentity({
    port,
    // Getter, not value: proc.pid stays undefined until the async `spawn`
    // event fires, and capturing it here would make the probe judge our own
    // child a "foreign owner" on its first health answer.
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited,
  });
  if (identity.outcome === "ready") return { proc };
  if (identity.outcome === "exited") {
    slog(`child on port ${port} exited before answering /api/health`);
  } else {
    slog(
      identity.outcome === "foreign-owner"
        ? `port ${port} answered health checks from another process`
        : `child on port ${port} did not answer /api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }
  const stopped = await stopUtilityServer(proc);
  if (!stopped) {
    slog(`child on port ${port} did not exit after termination; refusing to start a sibling server`);
  }
  return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      const started = await startServerOn(port);
      if (started.proc) {
        serverProc = started.proc;
        SERVER_PORT = port;
        return true;
      }
      if (started.abort) return false;
      // A child that exited or timed out is not evidence of a port conflict —
      // only "another process answered health checks" is.
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  serverStartConflictOnly = everyPortForeignOwned;
  return false;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "openmausbot:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

// The page is built at failure time (not import time): the message depends on
// how the boot failed, and the log path comes from LOG_DIR so Windows and
// Linux users see their real location instead of a macOS guess. The link
// opens the log through the window's setWindowOpenHandler, which routes to
// the platform handler.
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildErrorPage({ allPortsOccupied }) {
  const serverLogPath = path.join(LOG_DIR, "server.log");
  const serverLogHref = pathToFileURL(serverLogPath).href;
  const reason = allPortsOccupied
    ? "Every OpenMausBot port answered health checks from another process — likely a second copy of the app, or another program on ports 8799–28799. Quit that program, then quit and reopen OpenMausBot."
    : "The background server didn't come up in time — this is usually slow startup, not a port conflict. Quit and reopen OpenMausBot.";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} If it keeps happening, check <a target="_blank" rel="noopener" href="${serverLogHref}" style="color:#fcfcfc">${escapeHtml(serverLogPath)}</a>.</p></div></body>`,
    )
  );
}

// How long one packaged-server child gets to answer /api/health before the
// parent reaps it and tries the next port. Wall-clock, deliberately generous:
// first boots write data dirs and pre-listen network calls (managed composio,
// workspace credentials) can stall a healthy child far past 20s on some
// machines, which used to surface as the misleading "ports are busy" page.
const SERVER_BOOT_TIMEOUT_MS = 60_000;

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged || desktopRemoteAccess ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
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

  const nextContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  // Desktop URLs contain rotating access tokens. A newly minted URL replaces
  // the old viewer instead of being retained anywhere after its window closes.
  // Clear the ref first so the stale window's close handler no-ops; on a bot
  // change, tell the previous bot to release (same-bot reopen stays quiet).
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) {
    const previous = desktopViewerWindow;
    const previousOwner = desktopViewerOwner;
    const previousContextId = desktopViewerContextId;
    desktopViewerWindow = null;
    previous.close();
    if (previousContextId !== nextContextId && previousOwner && !previousOwner.isDestroyed()) {
      previousOwner.send("desktop-viewer:state", { open: false, contextId: previousContextId });
    }
  }
  desktopViewerOwner = owner.webContents;
  desktopViewerContextId = nextContextId;

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    // Not modal: the person still needs the app's "Hand control back" button
    // while the desktop is open. `parent` keeps it floating above the app.
    modal: false,
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

  // VNC needs rendering, keyboard/mouse input and WebSockets, plus the few
  // permission-gated input capabilities a viewer page asks for: keyboard and
  // pointer capture, the clipboard for paste, full screen. Those go to the
  // viewer's own origin only — never camera, microphone, geolocation,
  // notifications, USB, or any other privileged browser capability in this
  // remote-content window (see desktop-viewer-permissions.mjs).
  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  // A child window floats above the app but does not take the keyboard until
  // it is focused: clicks land in the VNC canvas either way, keystrokes only
  // reach the key window. Left unfocused, typing "into the VM" lands in the
  // composer and ⌘1–9 switch bots while the mouse appears to work.
  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
  viewer.on("closed", () => {
    if (desktopViewerWindow !== viewer) return;
    desktopViewerWindow = null;
    // The panel drops its "viewer open" state and releases control on this.
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

function ensureDesktopWorkspace(owner) {
  if (!owner || owner.isDestroyed()) throw new Error("The OpenMausBot window is unavailable");
  if (desktopWorkspaceManager) {
    if (desktopWorkspaceOwner !== owner) {
      throw new Error("The desktop workspace belongs to another app window");
    }
    return desktopWorkspaceManager;
  }

  desktopWorkspaceOwner = owner;
  const manager = createDesktopWorkspaceManager({
    owner,
    createView: (options) => new WebContentsView(options),
    partitionPrefix: `openmausbot-desktop-workspace-${randomUUID()}`,
    notify: (state) => {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("desktop-workspace:state", state);
      }
    },
  });
  desktopWorkspaceManager = manager;

  // Native child views outlive the renderer DOM unless we explicitly tear
  // them down. Reloads, renderer crashes and owner destruction all close both
  // panes without retaining their secret-bearing noVNC URLs.
  owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) manager.closeAll();
  });
  owner.webContents.on("render-process-gone", () => manager.closeAll());
  owner.once("closed", () => {
    manager.closeAll();
    if (desktopWorkspaceManager === manager) {
      desktopWorkspaceManager = null;
      desktopWorkspaceOwner = null;
    }
  });
  return manager;
}

function desktopWorkspaceForEvent(event, create = false) {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The desktop workspace is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The desktop workspace belongs to another app window");
  }
  return create ? ensureDesktopWorkspace(owner) : desktopWorkspaceManager;
}


ipcMain.on("screen:preview-intent", localOnlySync("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
}));

ipcMain.on("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

// ── environments: this computer's server, or a paired remote one ──────
// The app switches by loading the chosen server's own UI (electron/menu.mjs).
// Only {id, name, origin} is stored here; the session credential is the
// HttpOnly cookie /pair set for that origin, kept by Chromium's cookie jar.
const { LOCAL_ID, activeEnvironment, allowedOrigins, parseEnvironments, parsePairingLink, serializeEnvironments, withActive, withEnvironment, withoutEnvironment } = environmentsModule;
let environmentsState = { environments: [], activeId: LOCAL_ID };

function environmentsFile() {
  return path.join(app.getPath("userData"), "environments.json");
}

function readEnvironments() {
  try {
    return parseEnvironments(fs.readFileSync(environmentsFile(), "utf8"));
  } catch {
    return { environments: [], activeId: LOCAL_ID };
  }
}

function writeEnvironments(state) {
  const file = environmentsFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, serializeEnvironments(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`environments save failed: ${error?.message ?? error}`);
  }
}

/** Where the main window should be: the active remote server, else Local. */
function activeOrigin() {
  return activeEnvironment(environmentsState)?.origin ?? rendererOrigin();
}


function refreshApplicationMenu() {
  Menu.setApplicationMenu(
    buildApplicationMenu({
      environments: environmentsState.environments,
      activeId: environmentsState.activeId,
      onSwitch: (id) => switchEnvironment(id),
      onAddFromClipboard: () => void addServerFromClipboard(),
      onForget: (id) => void forgetEnvironment(id),
    }),
  );
}

function persistEnvironments(next) {
  environmentsState = next;
  writeEnvironments(environmentsState);
  refreshApplicationMenu();
}

function navigateMainWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.loadURL(url);
}

function switchEnvironment(id) {
  persistEnvironments(withActive(environmentsState, id));
  navigateMainWindow(activeOrigin());
}

async function addServerFromClipboard() {
  const link = parsePairingLink(clipboard.readText());
  if (!link) {
    await dialog.showMessageBox({
      type: "info",
      message: "Copy a pairing link first",
      detail:
        "On the server run `pnpm pair` (or `node dist-server/pair-cli.js` in Docker), copy the printed https://…/pair#code=… link, then choose this item again.",
    });
    return;
  }
  const host = new URL(link.origin).host;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Connect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect to ${host}?`,
    detail: link.code
      ? "The pairing code in the link is used once, then this app stays signed in to that server."
      : "The link has no pairing code; the server will ask for one.",
  });
  if (response !== 0) return;
  let next = withEnvironment(environmentsState, { origin: link.origin, name: host }, () => randomUUID());
  const added = next.environments.find((e) => e.origin === link.origin);
  next = withActive(next, added.id);
  persistEnvironments(next);
  navigateMainWindow(link.url);
}

async function forgetEnvironment(id) {
  const env = environmentsState.environments.find((e) => e.id === id);
  if (!env) return;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Forget", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Forget “${env.name}”?`,
    detail: "This app signs out of that server. The server keeps its own session list; revoke it there too if the device is gone.",
  });
  if (response !== 0) return;
  persistEnvironments(withoutEnvironment(environmentsState, id));
  try {
    // Revoke the session on the server while the cookie is still here.
    await session.defaultSession.fetch(`${env.origin}/api/auth/logout`, { method: "POST", signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    slog(`forget server: logout skipped (${error?.message ?? error})`);
  }
  try {
    await session.defaultSession.clearStorageData({ origin: env.origin, storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  } catch (error) {
    slog(`forget server: storage clear failed: ${error?.message ?? error}`);
  }
  navigateMainWindow(activeOrigin());
}

/**
 * Displays the native context menu for editable fields, links, and selections,
 * enabling paste if text or a clipboard image is available.
 *
 * @param {Electron.BrowserWindow} win - Target browser window.
 * @param {Electron.ContextMenuParams} params - Context menu parameters from Electron.
 * @returns {void}
 */
function showContextMenu(win, params) {
  // nothing actionable here — no menu at all, rather than a wall of
  // disabled items
  if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
  const menuItems = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      menuItems.push({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      });
    }
    if (menuItems.length) menuItems.push({ type: "separator" });
  }
  if (params.linkURL) {
    menuItems.push(
      { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  menuItems.push(
    { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
    { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
    { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
    pasteMenuItem(params, clipboard, win.webContents),
    { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  Menu.buildFromTemplate(menuItems).popup({ window: win, frame: params.frame });
}

/**
 * Creates and initializes the primary Electron browser window and configures
 * its lifecycle hooks, context menus, and navigation guards.
 *
 * @returns {void}
 */
function createWindow() {
  const waitsForSkinSync = process.platform === "win32";
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    // The renderer restores its persisted skin before mounting React and
    // mirrors it over desktop:skin. Keep Windows hidden until that handshake
    // recolors the native caption-button overlay, otherwise a saved light
    // skin still flashes the Midnight-black block on every cold start.
    show: !waitsForSkinSync,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      // The preload exposes the full bridge only to this origin (see preload.cjs).
      // Companion client mode still serves the bundled UI from its own
      // loopback relay, so it is a trusted local page while also needing the
      // renderer's remote-only feature gates. Keep the two facts independent:
      // upstream's origin boundary must not erase the client-mode marker.
      additionalArguments: desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess),
    },
  });
  mainWindow = win;
  attachUpdaterWindow(win);
  if (waitsForSkinSync) {
    // A broken renderer or preload must not strand the app as an invisible
    // process. Normal startup shows from desktop:skin almost immediately;
    // this is only the bounded recovery path.
    const skinSyncFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 5_000);
    skinSyncFallback.unref?.();
    const clearSkinSyncFallback = () => clearTimeout(skinSyncFallback);
    win.once("show", clearSkinSyncFallback);
    win.once("closed", clearSkinSyncFallback);
  }
  installWindowStatePersistence(win);
  applyUnreadBadge(win);
  if (restored.maximized) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // The window shows Local or a saved server, nothing else: a page cannot
  // walk the preload-bearing window to a stranger's origin.
  const guardNavigation = (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    if (origin && allowedOrigins(environmentsState, rendererOrigin()).has(origin)) return;
    event.preventDefault();
    slog(`blocked navigation to ${url}`);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  // Subframes: a page may not embed the local server, or any other saved
  // server, inside this preload-bearing window.
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    let target = null;
    let page = null;
    try {
      target = new URL(details.url).origin;
      page = new URL(win.webContents.getURL()).origin;
    } catch {}
    if (!target || !page || target === page) return;
    if (target === rendererOrigin() || allowedOrigins(environmentsState, rendererOrigin()).has(target)) {
      details.preventDefault();
      slog(`blocked subframe navigation to ${details.url}`);
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3: aborted by a newer navigation
    const remote = activeEnvironment(environmentsState);
    if (!remote) return;
    let origin = null;
    try {
      origin = new URL(validatedURL).origin;
    } catch {}
    if (origin !== remote.origin) return;
    slog(`remote server unreachable (${errorDescription}); back to Local`);
    void dialog.showMessageBox({
      type: "warning",
      message: `${remote.name} is not reachable`,
      detail: `${errorDescription}. Showing the local server instead; choose it again from the Server menu when it is back.`,
    });
    switchEnvironment(LOCAL_ID);
  });
  win.webContents.on("did-finish-load", () => deliverPackageInstall(win));

  // Native context menu for text inputs — without this, right-click does
  // nothing in the Electron window (no Cut/Copy/Paste/Select All).
  win.webContents.on("context-menu", (_event, params) => {
    showContextMenu(win, params);
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
            const [initialCapabilities, healthResponse, ownerMutationResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
              fetch("/api/auth/stream-ticket", { method: "POST" }),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            if (!ownerMutationResponse.ok) {
              throw new Error(
                \`desktop mutation capability failed: \${ownerMutationResponse.status} \${ownerMutationResponse.statusText}\`,
              );
            }
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
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.OMB_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  const remote = activeEnvironment(environmentsState);
  if (desktopRemoteAccess) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else if (remote) {
    win.loadURL(remote.origin);
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// Local-control screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
}));

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
ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
}));

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}));

// One-click bug-report bundle. Secrets are never read; the report is
// redacted again on the way out (diagnostics.mjs). null means the user
// cancelled the save dialog.
ipcMain.handle("desktop:export-diagnostics", localOnly("desktop:export-diagnostics", async (event) => {
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
}));

// Bots hand users files as markdown links to paths inside the OpenMausBot
// home (workspaces, attachments). As plain anchors those resolved against the
// page origin, so the click opened http://127.0.0.1:8799<path> in the default
// browser and the server's SPA fallback answered with index.html — a second
// copy of the chat UI instead of the file. Ask where to put it and copy it
// there instead: a save dialog tells the user the file landed somewhere and
// where, which a silent copy into ~/Downloads does not. The path is
// renderer-controlled, so it must resolve inside ~/.openmausbot and be a
// regular file — never a symlink escape or directory.
ipcMain.handle("desktop:save-file", localOnly("desktop:save-file", async (event, rawPath) => {
  return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    // Cancelling is a decision, not a failure — the bubble stays quiet.
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
}));

// The renderer owns the skin. Native Windows/Linux chrome is intentionally
// outside that surface; acknowledge the renderer handshake without creating
// a frameless caption overlay that can cover page controls.
ipcMain.handle("desktop:skin", (_event, skin) => {
  if (!isKnownSkin(skin)) return false;
  return true;
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
ipcMain.handle("desktop-viewer:open", localOnly("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
}));

// Two Local VM desktops share the existing app BrowserWindow. The renderer
// supplies only layout and intent; URL validation, sandboxing, session
// isolation and the one-interactive-pane invariant stay in the main process.
ipcMain.handle("desktop-workspace:open", localOnly("desktop-workspace:open", (event, input) =>
  desktopWorkspaceForEvent(event, true).open(input),
));
ipcMain.handle("desktop-workspace:layout", localOnly("desktop-workspace:layout", (event, items) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return false;
  return manager.layout(items);
}));
ipcMain.handle("desktop-workspace:set-interactive", localOnly("desktop-workspace:set-interactive", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return contextId == null;
  return manager.setInteractive(contextId);
}));
ipcMain.handle("desktop-workspace:close", localOnly("desktop-workspace:close", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return true;
  return manager.close(contextId);
}));

// Close only when the caller owns the current viewer — otherwise one bot's
// "Hand control back" would close (and release) another bot's viewer.
ipcMain.handle("desktop-viewer:close", localOnly("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
}));

// Lets a (re)mounted panel seed viewer-open state instead of defaulting to false.
ipcMain.handle("desktop-viewer:state-now", localOnly("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
})));

ipcMain.handle("perm:status", () => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", localOnly("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}));

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", localOnly("perm:open-settings", (_event, pane) => {
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
}));

ipcMain.handle("speech:start", localOnly("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
}));
ipcMain.handle("speech:stop", localOnly("speech:stop", () => {
  if (nativeActions.appleSpeech) stopSpeech();
}));
ipcMain.handle("speech:finish", localOnly("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
}));

ipcMain.handle("skill-recorder:permissions", localOnly("skill-recorder:permissions", () => recorderPermissionStatus()));
ipcMain.handle("skill-recorder:start", localOnly("skill-recorder:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("The recorder window is unavailable");
  return startRecorder(win);
}));
ipcMain.handle("skill-recorder:stop", localOnly("skill-recorder:stop", () => stopRecorder()));
ipcMain.handle("skill-recorder:save", localOnly("skill-recorder:save", (_event, payload) => (
  saveSkillRecording(payload, { dataRoot: desktopDataDir() })
)));

// ── companion sidecar ──────────────────────────────────────────────────
// The renderer gets these five and nothing else: it can turn the companion
// on and off, look at it, open or cancel a pairing window, and remove a
// device. It cannot reach the sidecar's control port itself.
ipcMain.handle("companion:state", localOnly("companion:state", () => desktopCompanionState()));
ipcMain.handle("companion:start", localOnly("companion:start", () => startDesktopCompanion()));
ipcMain.handle("companion:stop", localOnly("companion:stop", () => stopDesktopCompanion()));
ipcMain.handle("companion:keep-awake", localOnly("companion:keep-awake", async (_event, enabled) => {
  rememberCompanionKeepAwake(Boolean(enabled));
  return desktopCompanionState();
}));
ipcMain.handle("companion:refresh-tailscale", localOnly("companion:refresh-tailscale", () => refreshDesktopCompanionTailscale()));
ipcMain.handle("companion:pairing", localOnly("companion:pairing", (_event, open, expectedToken) =>
  companionPairing(Boolean(open), expectedToken).then(decorateDesktopCompanionState),
));
ipcMain.handle("companion:cloud-desktop", localOnly("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
));
ipcMain.handle("companion:revoke", localOnly("companion:revoke", (_event, deviceId) =>
  companionRevoke(deviceId).then(() => desktopCompanionState()),
));

function publicDesktopRemoteState() {
  return desktopRemoteAccess
    ? {
        active: true,
        endpoint: desktopRemoteAccess.endpoint,
        serverName: desktopRemoteAccess.serverName,
        deviceId: desktopRemoteAccess.deviceId,
      }
    : { active: false };
}

function requireMainWindowSender(event) {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) {
    throw new Error("The desktop client window is unavailable");
  }
}

function relaunchAfterDesktopRemoteChange() {
  const timer = setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 250);
  timer.unref?.();
}

ipcMain.handle("desktop-remote:state", () => publicDesktopRemoteState());
ipcMain.handle("desktop-remote:pair", localOnly("desktop-remote:pair", async (event, endpoint, code) => {
  requireMainWindowSender(event);
  const access = await pairDesktopCompanion({
    endpoint,
    code,
    deviceName: `${installationDisplayName()} desktop`,
  });
  await updateSecureCredentialDocument((credentials) => withDesktopCompanionAccess(credentials, access));
  desktopRemoteAccess = access;
  relaunchAfterDesktopRemoteChange();
  return publicDesktopRemoteState();
}));
ipcMain.handle("desktop-remote:disconnect", localOnly("desktop-remote:disconnect", async (event) => {
  requireMainWindowSender(event);
  await updateSecureCredentialDocument(withoutDesktopCompanionAccess);
  desktopRemoteAccess = null;
  relaunchAfterDesktopRemoteChange();
  return { active: false };
}));

// Auth and connector credentials never cross this boundary. Every handler
// returns the same deliberately tiny, secret-free public account state.
ipcMain.handle("companion-account:state", localOnly("companion-account:state", () => ensureCompanionAccountService().state()));
ipcMain.handle("companion-account:request-code", localOnly("companion-account:request-code", (_event, email) =>
  ensureCompanionAccountService().requestCode(email),
));
ipcMain.handle("companion-account:verify-code", localOnly("companion-account:verify-code", (_event, email, code) =>
  ensureCompanionAccountService().verifyCode(email, code),
));
ipcMain.handle("companion-account:retry", localOnly("companion-account:retry", () => ensureCompanionAccountService().retry()));
ipcMain.handle("companion-account:sign-out", localOnly("companion-account:sign-out", () => ensureCompanionAccountService().signOut()));

ipcMain.handle("environments:state", (event) => ({
  localOrigin: rendererOrigin(),
  remote: !senderIsLocal(event),
  activeId: environmentsState.activeId,
  environments: environmentsState.environments,
}));
ipcMain.handle("environments:switch", localOnly("environments:switch", (_event, id) => switchEnvironment(typeof id === "string" ? id : LOCAL_ID)));
ipcMain.handle("environments:add-from-link", localOnly("environments:add-from-link", async (_event, link) => {
  const parsed = parsePairingLink(typeof link === "string" ? link : "");
  if (!parsed) throw new Error("that is not a pairing link (expected https://host/pair#code=…)");
  clipboard.writeText(parsed.url);
  await addServerFromClipboard();
}));
ipcMain.handle("environments:forget", localOnly("environments:forget", (_event, id) => forgetEnvironment(typeof id === "string" ? id : "")));

ipcMain.handle("desktop:capabilities", async (event) =>
  desktopCapabilities({
    remote: !senderIsLocal(event),
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  }),
);

ipcMain.handle("assemblyai:status", localOnly("assemblyai:status", () => ({
  configured: Boolean(assemblyAICredential(secureCredentials)),
})));

ipcMain.handle("assemblyai:set-key", localOnly("assemblyai:set-key", async (_event, value) => {
  if (typeof value !== "string") throw new Error("Unsupported credential");
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  await updateSecureCredentialDocument((credentials) => {
    if (secret) credentials.assemblyAiApiKey = secret;
    else delete credentials.assemblyAiApiKey;
    return credentials;
  });
  return { configured: Boolean(secret) };
}));

ipcMain.handle("assemblyai:streaming-token", localOnly("assemblyai:streaming-token", () =>
  mintAssemblyAIStreamingToken(assemblyAICredential(secureCredentials)),
));

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
};

async function saveWorkspaceCredential(name, value) {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const applyToHarness = async () => {
    // In development the server is a separately launched process, so it
    // cannot receive credentials from Electron at boot. Keep its established
    // local config path there; production always uses the encrypted store.
    const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
      method: "PUT",
      headers: desktopServerHeaders(
        { "content-type": "application/json" },
        { packaged: app.isPackaged, token: desktopMutationToken },
      ),
      body: JSON.stringify(patchFor(secret)),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
    return body;
  };
  if (!app.isPackaged) return applyToHarness();

  // Commit the encrypted value before the server makes it live. The shared
  // state rolls credentials.bin back if validation/reload fails, while also
  // keeping concurrent account and provider updates serialized.
  return updateSecureCredentialDocument(
    (credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    },
    applyToHarness,
  );
}

ipcMain.handle("credential:set", localOnly("credential:set", (_event, name, value) =>
  saveWorkspaceCredential(name, value),
));

ipcMain.handle("approvals:set-trusted-mode", localOnly("approvals:set-trusted-mode", (_event, botId, mode, options) => {
  // Development uses a separately launched server, which is intentionally
  // outside this trust path. Never degrade this grant to loopback HTTP.
  if (!app.isPackaged || !serverProc) {
    throw new Error("Full and Custom approval modes require the embedded desktop server");
  }
  return trustedApprovalMode.request(serverProc, botId, mode, options);
}));

async function broadcastDesktopCapabilities() {
  const localConnection = await cuaReady;
  const build = (remote) =>
    desktopCapabilities({ remote, platform: process.platform, env: process.env, packaged: app.isPackaged, localConnection });
  const local = build(false);
  let redacted = null;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    let isLocal = false;
    try {
      isLocal = new URL(window.webContents.getURL()).origin === rendererOrigin();
    } catch {}
    if (!isLocal) redacted ??= build(true);
    window.webContents.send("desktop:capabilities-changed", isLocal ? local : redacted);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  if (app.isPackaged) {
    try {
      // Acquire before either plaintext credential migration reads or writes
      // config.json. The parent retains ownership across utility-child port
      // fallbacks and restarts for the entire desktop process lifetime.
      desktopDataDirLease = acquireDataDirLease(desktopDataDir(), {
        legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
      });
    } catch (error) {
      dialog.showErrorBox(
        "OpenMausBot could not start safely",
        error?.message ?? "Another process is using this OpenMausBot data folder.",
      );
      app.quit();
      return;
    }
  }
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("openmausbot");
    // Chromium adds this capability below JavaScript, so renderer requests
    // can mutate the local harness while a Full-access shell using curl
    // cannot impersonate the person operating the desktop app.
    installDesktopMutationHeader();
  }
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  secureCredentials = await loadSecureCredentials();
  if (app.isPackaged) {
    await secureComposioConfig();
    await secureWorkspaceConfig();
  }
  // Boot migrations above are deliberately sequential. From this point on,
  // every account/API-key writer must use the shared serialized state.
  // An unreadable store must not become a WRITE of an empty document.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
  });
  secureCredentials = secureCredentialState.read();
  if (app.isPackaged) await ensurePhoneSecretIdentity();
  desktopRemoteAccess = desktopCompanionAccess(secureCredentials);
  const hostedAccount = desktopRemoteAccess ? null : ensureCompanionAccountService();
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
    !desktopRemoteAccess && (process.platform === "darwin" || process.platform === "linux")
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  if (desktopRemoteAccess) {
    try {
      desktopCompanionRelay = await startDesktopCompanionRelay({
        access: desktopRemoteAccess,
        staticDir: app.isPackaged
          ? path.join(process.resourcesPath, "ui")
          : path.join(app.getAppPath(), "dist"),
      });
      SERVER_PORT = desktopCompanionRelay.port;
      serverReady = true;
    } catch (error) {
      serverReady = false;
      slog(`desktop companion relay failed: ${error?.message ?? error}`);
    }
  } else if (app.isPackaged) {
    serverReady = await startServerPackaged();
  }
  // The companion the user left on comes back without anyone finding the
  // toggle again — one attempt, after the harness port is settled, with the
  // exact options the IPC handler uses. A failure surfaces in companionState
  // (the panel shows the error) rather than retrying; and it never delays
  // the window.
  if (!desktopRemoteAccess && serverReady && companionEnabledAtRest()) {
    void startDesktopCompanion({ waitForHosted: false, remember: false });
  }
  setLocalOrigin(rendererOrigin());
  // Device permissions (microphone, camera, notifications, …) are for the
  // local UI only; a remote server's page in this window is refused without
  // a prompt. Client mode's loopback relay is the local UI.
  const localPermission = (url) => {
    try {
      return new URL(String(url)).origin === rendererOrigin();
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) =>
    callback(localPermission(details?.requestingUrl ?? contents?.getURL?.() ?? "")),
  );
  session.defaultSession.setPermissionCheckHandler((contents, _permission, requestingOrigin) =>
    localPermission(requestingOrigin || contents?.getURL?.() || ""),
  );
  environmentsState = readEnvironments();
  createWindow();
  // Reconcile incomplete setup and resume interrupted sign-out only after the
  // local app is usable. This background network work never gates LAN pairing
  // or the first window.
  if (hostedAccount) void hostedAccount.restore().catch(() => {});
  // Registration is optional network work. Start it only after the local
  // server and first window are usable, then update the server child over its
  // private parent port so Connected Apps becomes available without restart.
  // Registering while the store is unreadable would mint a SECOND installation
  // identity for a user who already has one — the first thing they would
  // notice is every connected app gone, permanently.
  if (credentialStoreUnavailable) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (!desktopRemoteAccess && app.isPackaged && composioBrokerUrl() && !credentialStoreUnavailable) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        // The shared credential state performs the one atomic encrypted
        // write after this registration has derived its complete document.
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials);
  }
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater();
  refreshApplicationMenu();
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
let signalQuitRequested = false;

// Package managers, desktop watchdogs, and terminal launchers commonly stop
// Linux apps with SIGTERM/SIGINT. Convert the first signal into Electron's
// normal quit path so the embedded server, Cua descriptor/socket, and private
// AppImage stage receive the same bounded cleanup as a window close. A second
// signal keeps Node's default force-quit behavior because these are `once`
// listeners.
const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

app.on("before-quit", (e) => {
  desktopShutdownStarted = true;
  if (cuaCleanedUp) return;
  e.preventDefault();
  const stoppingServer = serverProc;
  serverProc = null;
  // Release the sleep blocker synchronously; child shutdown is awaited below.
  syncCompanionKeepAwake(false, false);
  try {
    desktopCompanionRelay?.close?.();
  } catch {}
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  if (nativeActions.appleSpeech) stopSpeech();
  stopRecorder();
  const ownedHelperCleanup = Promise.race([
    Promise.all([
      stopCua().catch(() => {}),
      // Both listeners reachable from outside the app are owned children.
      // Shut the connector down first, then the sidecar, without changing the
      // remembered toggle the next launch will restore.
      stopDesktopCompanion({ remember: false }).catch(() => {}),
    ]),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  const cleanup = Promise.all([
    ownedHelperCleanup,
    stopUtilityServer(stoppingServer).then((stopped) => {
      if (!stopped) slog("server child did not stop before desktop exit; retaining the data-directory lease");
    }),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});

function releaseDesktopDataDirLease() {
  if (!desktopDataDirLease) return;
  try {
    desktopDataDirLease.release();
    desktopDataDirLease = null;
  } catch (error) {
    // Never print the private child capability. Lease errors contain only the
    // data-safety reason and, for contention, the owning process id.
    slog(`data-directory lease release failed: ${error?.message ?? error}`);
  }
}

// before-quit is deliberately too early: this app defers it while owned
// helpers shut down. will-quit is the final Electron lifecycle boundary; the
// process hook covers app.exit()/fatal exits that bypass it.
app.on("will-quit", releaseDesktopDataDirLease);
process.once("exit", releaseDesktopDataDirLease);
