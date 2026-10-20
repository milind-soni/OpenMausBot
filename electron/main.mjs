import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Tray, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";
import { attachUpdaterWindow, startUpdater, registerUpdaterIpc, sendUpdaterState } from "./updater.mjs";
import {
  appendDesktopCrashRecord,
  buildDiagnosticsReport,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
} from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { evictStartupCacheOnce } from "./startup-cache-eviction.mjs";
import { activateExistingWindow, releaseSingleInstanceLock } from "./single-instance.mjs";
import { bootFailureMessage, listeningSignal, pollServerIdentity, SERVER_BOOT_TIMEOUT_MS, SERVER_LISTENING_GRACE_MS } from "./server-boot-probe.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { serverChildLaunch } from "./server-child-launch.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { chatLinkFrom, chatLinkFromCommandLine } from "./chat-link.mjs";
import { createOrganizationEntry, isOrganizationDeepLink, takeOrganizationDeepLink, organizationRestartIntent, withOrganizationRestartIntent, withoutOrganizationRestartIntent } from "./organization-entry.mjs";
import { windowChromeOptions } from "./window-chrome.mjs";
import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";
import { createStartupScreen } from "./startup-screen.mjs";
import { createSystemTray } from "./system-tray.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
let startupScreen = null;
let desktopTray = null;
import { collisionFreeDownloadPath, defaultSaveName, openLogsFolder, revealDownloadWhenDone, revealInFolder, withSavableFile } from "./save-file.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import { appPermissionHandlers, externalWebUrl } from "./app-permissions.mjs";
import { writeClipboardText } from "./clipboard-write.mjs";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioBrokerUrl,
  managedComposioChildEnvironment,
} from "./managed-composio.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  resolveManagedCompanionGuardian,
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
import { isKnownSkin, skinChrome } from "./skin-overlay.cjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  companionAccountCleanupPending,
  createCompanionAccountService,
  managedEndpointNeed,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import capabilitiesModule from "./capabilities.cjs";
import environmentsModule from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";
import { buildApplicationMenu } from "./menu.mjs";
import { createComputerSharing, validateSharedFolders } from "./computer-sharing.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { switchLocalEnvironment } from "./environment-switch.mjs";
import { createManagedDesktopClient, createManagedDesktopRelay, createManagedDesktopStore } from "./managed-desktop.mjs";
import { CHECKOUT_SOURCES, cloudMenuSublabel, cloudPlanSnapshot, cloudTarget, createCloudAccountClient, createCloudAccountStore } from "./cloud-account.mjs";
import { cloudLinkOpensSheet, colorDotIcons, createCloudLook, createCloudReadyNotice, installCloudBuy, lookFile } from "./cloud-buy.mjs";
import { createTrialNotices } from "./cloud-trial-notice.mjs";
import { DESKTOP_PORTS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { createDesktopIncludedX } from "./included-x.mjs";
import { CLOUD_HOME_NAME, cloudHomeConnectUrl, cloudPlanDisk, cloudUnreachableText, createCloudPowerGate, installOneWorkspace, isCloudHomeEntry, myCloudOrigin, openSleepingCloud, rememberedCloudHome, savedCloudHomeOrigin, signInCloudSession, withCloudHome } from "./cloud-home.mjs";
import { installCloudFiles } from "./cloud-sync-main.mjs";
import { createCloudEntry } from "./cloud-entry.mjs";
import { DEFAULT_FOLDERS, grantSentence, installCloudLending, usualFolders } from "./cloud-lending-ipc.mjs";
import { cloudPageSenderAllowed, createCloudMove, mintOwnerCode, moveBlocked, moveFit, moveRefusal, moveSenderDestination, parseCloudMoveStatus } from "./cloud-move.mjs";
import { installCloudSend } from "./cloud-send-main.mjs";
import { cloudMoveChoices } from "./cloud-move-choices.mjs";
import { createOrgLibrary } from "./org-library.mjs";
import { createCompanyBackups } from "./company-backups.mjs";
import { createCompanyBackupSchedule } from "./company-backup-schedule.mjs";
import { installServerSessions, reportOwnListeners } from "./server-session.mjs";

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
const { MIN_BOUNDS, normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// vite binds IPv4; a bare "localhost" can resolve to ::1.
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
let desktopViewerWindow = null;
let desktopViewerOwner = null;
let desktopViewerContextId = null;
let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;
let pendingOrganizationEntry = takeOrganizationDeepLink(process.argv);
const cloudEntry = createCloudEntry({
  reveal: () => { if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows()); },
  open: async () => {
    let delivered = false;
    await workspaceMenuAction(async () => { delivered = await openCloudEntry(); });
    return delivered;
  },
});
cloudEntry.fromLaunch(process.argv);
let pendingPackageInstallUrl = pendingOrganizationEntry ? null : packageUrlFromCommandLine(process.argv);
let pendingChatLink = pendingOrganizationEntry ? null : chatLinkFromCommandLine(process.argv);
let organizationEntryReady = false;
let mainWindow = null;
const serverUnavailableWindows = new WeakSet();
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
  const pushMaximized = () => {
    try {
      if (!win.isDestroyed()) win.webContents.send("window:maximized-changed", win.isMaximized());
    } catch {}
  };
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
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

// GNOME groups the window with its desktop entry only when both identities match; set before ready.
// Chromium's GPU process crashed on NVIDIA/libGLES and left an invisible window intercepting input.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.setDesktopName("com.openmausbot.app.desktop");
}

if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] OpenMausBot is already running — focusing that window");
  process.exit(0);
}

// Only an update-driven quit emits before-quit-for-update (the vendored electron-updater re-emits it
// before app.quit()). The new build can start before before-quit cleanup ends, so release the lock here.
nativeAutoUpdater.on("before-quit-for-update", () => releaseSingleInstanceLock(app));

function sendToLocalPage(win, channel, value) {
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return false;
  let showingLocal = false;
  try {
    showingLocal = new URL(win.webContents.getURL()).origin === rendererOrigin();
  } catch {}
  if (!showingLocal) {
    if (activeRemote(environmentsState)) void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
    return false;
  }
  win.webContents.send(channel, value);
  return true;
}

function deliverPackageInstall(win = mainWindow) {
  if (pendingPackageInstallUrl && sendToLocalPage(win, "package:install", pendingPackageInstallUrl)) pendingPackageInstallUrl = null;
}

function deliverChatLink(win = mainWindow) {
  if (pendingChatLink && sendToLocalPage(win, "chat:open", pendingChatLink)) pendingChatLink = null;
}

let openWindowForLink = null;

/** macOS open-url does not fire activate, so a link that finds no window opens one. */
function revealForLink() {
  if (desktopTray?.show()) return;
  const appWindow = !startupScreen && mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : BrowserWindow.getAllWindows();
  if (activateExistingWindow(appWindow)) return;
  openWindowForLink?.();
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  revealForLink();
  deliverPackageInstall();
  return true;
}

function queueChatLink(rawLink) {
  const link = chatLinkFrom(rawLink);
  if (!link) return false;
  pendingChatLink = link;
  revealForLink();
  deliverChatLink();
  return true;
}

app.on("open-url", (event, url) => {
  if (!queueOrganizationEntry(url) && !cloudEntry.fromUrl(url) && !queuePackageInstall(url) && !queueChatLink(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  if (takeOrganizationDeepLink(commandLine)) {
    queueOrganizationEntry("openmausbot://organization");
    return;
  }
  if (cloudEntry.fromArgs(commandLine)) return;
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  const chatLink = chatLinkFromCommandLine(commandLine);
  if (chatLink) pendingChatLink = chatLink;
  revealForLink();
  deliverPackageInstall();
  deliverChatLink();
});

let serverProc = null;
let serverReady = !app.isPackaged;
let secureCredentials = {};
let secureCredentialState = null;
let desktopDataDirLease = null;
// The folder this process leases; environmentsState.activeId can name a remote server instead.
let runningDataDir = null;
let localSwitchInFlight = false;
let managedDesktop = null;
let cloudAccount = null;
let cloudAccountStarted = Promise.resolve();
let cloudAccountRestoring = false;
let cloudSignInRestored = false;
function cloudAccountRestored() {
  return Promise.race([cloudAccountStarted, new Promise(resolve => setTimeout(resolve, 5_000).unref?.())]);
}
let orgLibrary = null;
let companyBackupController = null;
let companyBackupState = { busy: false };
let preparedCompanyRestore = null;
let companyBackupSchedule = null;
let companyBackupClientStateRequest = null;
let companyRestoreCommitting = false;
let companyBackupConfigurationRevision = 0;
const managedDesktopRelay = createManagedDesktopRelay();
const includedX = createDesktopIncludedX({ account: () => cloudAccount, server: () => serverProc, log: slog });
const cloudPower = createCloudPowerGate({ power: () => cloudAccount?.power() ?? null, wanted: () => Boolean(cloudSync?.running() || computerSharing?.lendingToCloud()) });
const utilityServerExits = new WeakMap();
const UTILITY_SERVER_STOP_TIMEOUT_MS = 6_500;
const trustedApprovalMode = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
const desktopMutationToken = randomBytes(32).toString("base64url");
const desktopLaunchId = randomUUID();
const companionMutationToken = randomBytes(32).toString("base64url");
const serverSupervisor = createServerSupervisor({
  restart: () => startServerOn(SERVER_PORT),
  stop: stopUtilityServer,
  onReady(proc) {
    serverProc = proc;
    serverReady = true;
    serverStartConflictOnly = false;
    slog(`server ready pid=${proc.pid} port=${SERVER_PORT}`);
    void readCloudOfferBrand();
    syncManagedComposioCredentials(); includedX.serverStarted();
    reportOwnListeners(proc);
    orgLibrary?.runtimeReady();
    if (managedDesktop) void managedDesktop.refresh().catch(() => {});
    routineWake.start();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!serverUnavailableWindows.has(win) || activeRemote(environmentsState)) continue;
      void win.loadURL(`http://127.0.0.1:${SERVER_PORT}`).then(() => {
        serverUnavailableWindows.delete(win);
      }).catch((error) => {
        slog(`recovered server window failed to load: ${error?.message ?? error}`);
      });
    }
  },
  onUnavailable() {
    serverReady = false;
    serverProc = null;
    companyBackupSchedule?.reconcile();
    routineWake.stop();
  },
  onExhausted() {
    slog("server recovery paused after repeated failures; quit and reopen to retry");
    dialog.showErrorBox(
      "The bot server stopped",
      "Automatic recovery could not restart the background server. Quit and reopen OpenMausBot to try again. Interrupted chat turns were not resent.\n\n" +
        `Server log: ${path.join(LOG_DIR, "server.log")}`,
    );
  },
  log: slog,
});

function desktopDataDir() {
  // An empty OMB_DATA_DIR falls back here too; server/config.ts would not, so the child gets this path.
  return process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
}

async function stopUtilityServer(proc, timeoutMs = UTILITY_SERVER_STOP_TIMEOUT_MS) {
  if (!proc) return true;
  const exited = utilityServerExits.get(proc);
  if (!exited) return false;
  try {
    proc.kill();
  } catch {
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

/** True when the store could not be read, which is not the same as nothing saved. */
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
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  // Writing from an unread store would drop the secrets it could not read.
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
    // Unread legacy fields, removed so an unused secret is not left in plaintext.
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

async function secureWorkspaceConfig() {
  const dataDir = desktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    // credentials.bin first, so a failed save never loses the only copy of a secret.
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
  return managedComposioBrokerUrl(process.env.OMB_COMPOSIO_BROKER_URL, app.isPackaged);
}

// Finder/Explorer launches have no usable stdio, so the server child's output goes to server.log here.
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
  companionBrowserControlAccess,
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
import { createRoutineWakeHold, rememberRoutineWake, routineWakeSettings } from "./routine-wake.mjs";
import { CREDENTIAL_PATCH, credentialSaveError } from "./credential-patch.mjs";

/** Second wall after preload's reduced bridge: computer-controlling IPC answers only the local server's UI.
 * Declared before any handler registration (temporal dead zone). */
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

const routineWake = createRoutineWakeHold({
  fetchStatus: () => (serverReady
    ? fetch(`http://127.0.0.1:${SERVER_PORT}/api/routines/wake`, { signal: AbortSignal.timeout(5_000), redirect: "error", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
    : Promise.resolve(null)),
  isOnBattery: () => {
    try {
      return powerMonitor.isOnBatteryPower();
    } catch {
      return false;
    }
  },
  blocker: powerSaveBlocker,
  settings: () => routineWakeSettings(app.getPath("userData")),
  log: (line) => slog(line),
});

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
  }
}

// Synchronous: a fatal exception can end Electron before an async write flushes.
// uncaughtExceptionMonitor observes Node's fatal path without handling it, so the process still exits.
installDesktopCrashListeners({
  appTarget: app,
  processTarget: process,
  record: (event) => appendDesktopCrashRecord(DESKTOP_CRASH_LOG, DESKTOP_CRASH_LOG_MAX_BYTES, formatDesktopCrashRecord(event)),
  isShuttingDown: () => desktopShutdownStarted,
  mainWebContents: () => mainWindow?.webContents ?? null,
});

let managedCompanionConnector = null;
let companionAccountService = null;
let companionDesiredThisLaunch = false;
let companionLaunchGeneration = 0;
let advertisementTransition = Promise.resolve();

/** Every credential writer goes through this one serialized hook, so concurrent saves never overwrite each other. */
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
    // Only an embedded server receives the private half; a dev server must not advertise the public key.
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
  const refusal = managedRemoteAccessRefusal();
  if (refusal) throw new Error(refusal);
  companionDesiredThisLaunch = true;
  companionLaunchGeneration += 1;
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
  void managedCompanionConnector?.stop().catch(() => {});
});

/** Stops advertising the hosted route but keeps the retry credentials until remote cleanup is scheduled. */
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
    autoRecover: true,
    onDemand: true,
    managedEndpointNeeded: async () =>
      companionRunning() ? managedEndpointNeed(await companionState().catch(() => null)) : null,
    log: (line) => slog(line),
  });
  return companionAccountService;
}

// Everything the bug-report bundle needs: config is booleans only and the log is redacted, since it is pasted into public issues.
async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readSafeLogTail(logPath);
  const desktopLog = readSafeLogTail(DESKTOP_CRASH_LOG);
  const updaterLog = readSafeLogTail(path.join(LOG_DIR, "updater.log"));
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
    updaterLogTail: updaterLog?.tail ?? "",
    logTail: log?.tail ?? "",
  });
}

let serverStartConflictOnly = false;

function syncPhoneSecretKey(proc) {
  const message = phoneSecretPrivateKeyMessage(phoneSecretIdentity);
  if (!message) return;
  try {
    proc.postMessage(message);
  } catch (error) {
    slog(`phone credential key sync failed: ${error?.message ?? error}`);
  }
}

function ensureCloudAccount() {
  if (cloudAccount) return cloudAccount;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("MausBot Cloud sign-in requires the local desktop app.");
  cloudAccount = createCloudAccountClient({
    store: createCloudAccountStore({ file: path.join(app.getPath("userData"), cloudTarget(process.env).file), encryption: {
      available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: value => safeStorage.encryptStringAsync(value), decrypt: value => safeStorage.decryptStringAsync(value),
    } }),
    platform: process.platform, deviceName: os.hostname().slice(0, 100) || "My computer", appVersion: app.getVersion(), origin: cloudTarget(process.env).origin,
    openBrowser: url => shell.openExternal(url), awaitingWake: () => cloudPower.awaiting(),
    onState: state => {
      rememberCloudHome(state);
      rememberedHome = rememberedCloudHome(rememberedHome, state);
      sendUpdaterState();
      cloudPower.changed(); computerSharing?.cloudChanged();
      void includedX.onState(state);
      refreshCloudMenus();
      announceCloudReady(state);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
        !activeRemote(environmentsState) && !desktopRemoteAccess) mainWindow.webContents.send("cloud-account:state-changed", state);
    },
  });
  return cloudAccount;
}

/** The free trial's popup, at most once a day per notice across this computer's page and the Cloud's. */
let trialNotices = null;
function cloudTrialNotices() {
  return trialNotices ??= createTrialNotices(jsonFile(path.join(app.getPath("userData"), "cloud-trial-notices.json")));
}

let brandedBuild = null;
async function readCloudOfferBrand() {
  if (brandedBuild !== null || !app.isPackaged || desktopRemoteAccess) return;
  const status = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/brand`, { signal: AbortSignal.timeout(3_000) })
    .then(res => (res.ok ? res.json() : null)).catch(() => null);
  if (!status || brandedBuild !== null) return;
  brandedBuild = status.source === "file";
  refreshApplicationMenu();
}
function cloudOffersAllowed() {
  return app.isPackaged && !desktopRemoteAccess && brandedBuild === false;
}
async function cloudOffersReady() {
  if (brandedBuild === null && serverReady) await readCloudOfferBrand();
  return cloudOffersAllowed();
}
const menuDate = value => new Intl.DateTimeFormat(app.getLocale() || "en-US", { day: "numeric", month: "short" }).format(new Date(value));
function cloudHomeEntry() {
  const homeOrigin = cloudAccount?.homeTarget()?.origin ?? null;
  return environmentsState.environments.find(candidate => isCloudHomeEntry(candidate, { homeOrigin, remembered: rememberedHome })) ?? null;
}
function cloudMenuSublabels() {
  const entry = cloudHomeEntry();
  const line = entry ? cloudMenuSublabel(cloudAccount?.state(), menuDate) : null;
  return entry && line ? { [entry.id]: line } : {};
}
const cloudColorDot = colorDotIcons(nativeImage);
function cloudMenuOptions(source = "app_menu") {
  return { sublabels: cloudMenuSublabels(), iconFor: cloudColorDot, ...(cloudOffersAllowed() ? { onAddCloud: () => void workspaceMenuAction(() => openCloudAdd(source)) } : {}) };
}
let cloudMenuKey = "";
function refreshCloudMenus() {
  const key = JSON.stringify([cloudOffersAllowed(), cloudMenuSublabels()]);
  if (key === cloudMenuKey) return;
  cloudMenuKey = key;
  refreshApplicationMenu();
}
/** Add a Cloud… is always the sheet on this computer's page, which says what is true now (setting up, one Cloud for now). */
async function openCloudAdd(source) {
  if (!cloudOffersAllowed() || !serverReady) return;
  await cloudAccountRestored();
  if (activeRemote(environmentsState)) persistEnvironments(withActive(environmentsState, LOCAL_ID));
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  const action = source === "app_howto" ? "cloud-add-howto" : "cloud-add";
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) win.webContents.send("app:open-settings", action);
  else await win.loadURL(`${rendererOrigin()}/?desktop-settings=${action}`);
}
const announceCloudReady = createCloudReadyNotice({ Notification, focused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  sheetOpen: () => cloudBuy.sheetOpen(), name: () => cloudLook.current().name, shown: () => cloudAccount?.checkoutDone(),
  open: () => { if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows()); void workspaceMenuAction(() => connectCloudHome()); } });

function ensureManagedDesktop() {
  if (managedDesktop) return managedDesktop;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Organization sign-in requires the installed desktop app running on this computer.");
  const encryption = {
    available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: value => safeStorage.decryptStringAsync(value),
  };
  const store = createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-connection.bin"), encryption });
  orgLibrary = createOrgLibrary({
    dataDir: path.join(desktopDataDir(), "org-library"),
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-library.bin"), encryption }),
    fetchBytes: (route, maxBytes, options) => managedDesktop.fetchLibraryBytes(route, maxBytes, options),
    relay: library => managedDesktopRelay.sendLibrary(serverProc, library),
    appVersion: app.getVersion(),
    log: message => slog(message),
  });
  managedDesktop = createManagedDesktopClient({
    store, platform: process.platform, deviceName: os.hostname().slice(0, 100) || "My computer",
    applyConnection: connection => managedDesktopRelay.send(serverProc, connection),
    applyPolicy: policy => managedDesktopRelay.sendPolicy(serverProc, policy),
    migrateIdentity: identity => managedDesktopRelay.sendIdentity(serverProc, identity),
    library: orgLibrary,
    appVersion: app.getVersion(),
    openBrowser: url => shell.openExternal(url),
    onState: state => {
      if (state.status === "license-expired") companyBackupController?.abort();
      const lost = ["signed-out", "reauth-required"].includes(state.status), withoutStorage = state.status === "connected" && !state.cloudBackups;
      if (lost || withoutStorage) {
        companyBackupConfigurationRevision++;
        companyBackupController?.abort();
        preparedCompanyRestore = null;
        if (withoutStorage) void companyBackupSchedule?.forget().catch(() => {});
        publishCompanyBackupState({ busy: Boolean(companyBackupController) });
      }
      companyBackupSchedule?.reconcile();
      // Remote pages never receive local identity events, even in a window that once subscribed locally.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
          !activeRemote(environmentsState) && !desktopRemoteAccess) {
        mainWindow.webContents.send("organization:state-changed", state);
      }
    },
  });
  companyBackupSchedule = createCompanyBackupSchedule({
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-backup-schedule.bin"), encryption }),
    scope: companyBackupScope,
    run: async (signal, scope) => {
      if (companyBackupController || preparedCompanyRestore || companyRestoreCommitting || desktopShutdownStarted) throw companyBackupDeferred();
      const proc = serverProc;
      const status = await localBackupStatus(proc);
      if (status.busy || status.pendingRestore) throw companyBackupDeferred();
      const clientState = await collectCompanyBackupClientState(signal, scope, proc);
      signal.throwIfAborted();
      const current = companyBackupScope();
      if (!current || current.key !== scope.key || current.generation !== scope.generation || proc !== serverProc || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
      return runCompanyBackup("backup", { clientState }, { signal, scope });
    },
    onState: schedule => publishCompanyBackupState({ ...companyBackupState, schedule }),
  });
  return managedDesktop;
}

function companyBackupScope() {
  if (desktopShutdownStarted || desktopRemoteAccess || !serverReady || !serverProc || activeEnvironment(environmentsState)) return null;
  const client = managedDesktop, connection = client?.connection(), state = client?.state();
  if (!connection || state?.status !== "connected" || !state.cloudBackups || connection.expiresAt <= Date.now()) return null;
  const dataDir = path.resolve(desktopDataDir());
  return { key: JSON.stringify([connection.portalOrigin, connection.organizationId, connection.email, dataDir]),
    adopts: saved => {
      try {
        const value = JSON.parse(saved);
        return Array.isArray(value) && value.length === 5 && typeof value[3] === "string" && value[0] === connection.portalOrigin &&
          value[1] === connection.organizationId && value[2] === connection.email && value[4] === dataDir;
      } catch { return false; }
    },
    generation: client.backupGeneration() };
}

function companyBackupDeferred() {
  return Object.assign(new Error("Wait for this installation to be available for its daily backup."), { code: "workspace_busy" });
}

function collectCompanyBackupClientState(signal, scope, proc) {
  const win = mainWindow, contents = win?.webContents, frame = contents?.mainFrame;
  if (companyBackupClientStateRequest || !win || win.isDestroyed() || desktopRemoteAccess || activeEnvironment(environmentsState) ||
      !frame?.url.startsWith(`${rendererOrigin()}/`)) return Promise.reject(companyBackupDeferred());
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error, value) => {
      if (companyBackupClientStateRequest?.requestId !== requestId) return;
      companyBackupClientStateRequest = null;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(companyBackupDeferred());
    const timer = setTimeout(abort, 10_000); timer.unref?.();
    companyBackupClientStateRequest = { requestId, win, contents, frame, url: frame.url, scope, proc, finish };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { contents.send("company-backups:collect-client-state", { requestId }); }
    catch { abort(); }
  });
}

function receiveCompanyBackupClientState(event, input) {
  const pending = companyBackupClientStateRequest;
  if (!pending || input?.requestId !== pending.requestId || event.sender !== pending.contents || event.senderFrame !== pending.frame) return;
  const scope = companyBackupScope();
  if (pending.win !== mainWindow || mainWindow.isDestroyed() || pending.url !== pending.frame.url ||
      !workspaceSenderAllowed(event, mainWindow.webContents, environmentsState, rendererOrigin()) ||
      procUnavailable() || !scope || scope.key !== pending.scope.key || scope.generation !== pending.scope.generation) {
    pending.finish(companyBackupDeferred()); return;
  }
  function procUnavailable() { return pending.proc !== serverProc || !serverReady || desktopRemoteAccess || desktopShutdownStarted; }
  const value = input.clientState;
  if (input.unavailable || !value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some(entry => typeof entry !== "string") || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) {
    pending.finish(companyBackupDeferred()); return;
  }
  pending.finish(null, Object.fromEntries(Object.entries(value)));
}

function publishCompanyBackupState(value) {
  companyBackupState = { ...value, ...(companyBackupSchedule ? { schedule: companyBackupSchedule.state() } : {}) };
  if (mainWindow && !mainWindow.isDestroyed() && !activeRemote(environmentsState) && !desktopRemoteAccess &&
      mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) mainWindow.webContents.send("company-backups:state-changed", companyBackupState);
}

function localBackupRequest(proc, route, init = {}) {
  if (!proc || proc !== serverProc || !serverReady || !/^\/api\/workspace-backup\/(?:status|export|upload|preview|restore|download\/[A-Za-z0-9_-]+)$/.test(route)) {
    throw new Error("This installation changed. Start this backup operation again.");
  }
  return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
    headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
}

async function localBackupStatus(proc) {
  const response = await localBackupRequest(proc, "/api/workspace-backup/status", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Local backup status is unavailable. Try again when this installation is ready.");
  const status = await response.json();
  if (proc !== serverProc || typeof status.busy !== "boolean" || typeof status.pendingRestore !== "boolean") throw new Error("This installation changed. Check backup status again.");
  return status;
}

async function runCompanyBackup(kind, input, scheduled = null) {
  if (companyBackupController || companyRestoreCommitting || desktopShutdownStarted || (scheduled && preparedCompanyRestore)) throw companyBackupDeferred();
  const client = ensureManagedDesktop(), connection = client.connection();
  if (!connection || !client.state().cloudBackups) throw new Error("Connect your organization and ask its administrator to enable cloud backups first.");
  const generation = client.backupGeneration();
  if (scheduled) {
    scheduled.signal.throwIfAborted();
    const scope = companyBackupScope();
    if (!scope || scope.key !== scheduled.scope.key || scope.generation !== scheduled.scope.generation) throw companyBackupDeferred();
  }
  const proc = serverProc, controller = new AbortController();
  const cancelScheduled = () => controller.abort();
  scheduled?.signal.addEventListener("abort", cancelScheduled, { once: true });
  const deadline = setTimeout(() => controller.abort(), 2 * 60 * 60_000); deadline.unref?.();
  companyBackupController = controller;
  preparedCompanyRestore = null;
  publishCompanyBackupState({ busy: true, kind });
  const progress = progress => publishCompanyBackupState({ busy: true, kind, progress });
  try {
    const status = await localBackupStatus(proc);
    if (status.pendingRestore) {
      publishCompanyBackupState({ busy: false, pendingRestore: true });
      throw new Error("Restart OpenMausBot to finish the pending restore before starting another backup operation.");
    }
    if (status.busy) throw companyBackupDeferred();
    const transfers = createCompanyBackups({
      tempRoot: path.join(app.getPath("temp"), "openmaus-company-backups"),
      localRequest: (route, init) => localBackupRequest(proc, route, init),
      portalRequest: (route, options) => client.requestBackup(route, { ...options, generation }),
      availableBytes: async temporary => {
        const volumes = await Promise.all([fs.promises.statfs(temporary), fs.promises.statfs(desktopDataDir())]);
        return Math.min(...volumes.map(volume => volume.bavail * volume.bsize));
      },
    });
    const result = kind === "backup" ? await transfers.backup({ ...input, appVersion: app.getVersion() }, controller.signal, progress)
      : await transfers.prepareRestore(input, controller.signal, progress);
    controller.signal.throwIfAborted();
    if (proc !== serverProc || client.backupGeneration() !== generation || client.connection()?.deviceId !== connection.deviceId) throw new Error("This installation or its organization connection changed.");
    if (kind === "restore") preparedCompanyRestore = { id: result.id, proc, deviceId: connection.deviceId };
    publishCompanyBackupState({ busy: false, ...(kind === "backup" ? { lastBackupAt: Date.now() } : {}) });
    return result;
  } catch (error) {
    const message = controller.signal.aborted ? "Cloud backup cancelled. This installation has not been replaced."
      : error?.name === "CompanyBackupError" ? error.message : "Cloud backup could not complete. Check your organization connection and available disk space, then try again.";
    publishCompanyBackupState({ busy: false, pendingRestore: companyBackupState.pendingRestore, message });
    throw Object.assign(new Error(message), error?.code === "workspace_busy" ? { code: "workspace_busy" } : {});
  } finally {
    clearTimeout(deadline);
    scheduled?.signal.removeEventListener("abort", cancelScheduled);
    if (companyBackupController === controller) companyBackupController = null;
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

async function startServerOn(port, dataDir = runningDataDir ?? startupEnvironmentDir(environmentsState, desktopDataDir())) {
  if (desktopShutdownStarted) return { proc: null, abort: true };
  const { entry, compileCacheDir } = serverChildLaunch({
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
  });
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    // The parent owns the data-dir lease; a child only validates it, so fallback-port children never replace it.
    ...desktopDataDirLease.utilityServerLeaseEnvironment(),
    OMB_DATA_DIR: dataDir,
    // Fail-closed until this process sends the private connection; never a descriptor inherited from the shell.
    OMB_DESKTOP_PARENT: "1",
    OMB_DESKTOP_LAUNCH_ID: desktopLaunchId,
    OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    OMB_RESOURCES_PATH: process.resourcesPath,
    OMB_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    OMB_PORT: String(port),
    OMB_APP_VERSION: app.getVersion(),
    OMB_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    OMB_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.OMB_BROWSER_CONNECTION;
  delete childEnv.OMB_SERVER_COMPILE_CACHE;
  if (compileCacheDir) childEnv.OMB_SERVER_COMPILE_CACHE = compileCacheDir;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveServerExit;
  utilityServerExits.set(proc, new Promise((resolve) => {
    resolveServerExit = resolve;
  }));
  const listening = listeningSignal();
  proc.stdout?.on("data", (d) => {
    listening.hear(String(d));
    slog(`[out] ${String(d).trimEnd()}`);
  });
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    if (!serverSupervisor.isCurrent(proc)) return;
    try {
      if (trustedApprovalMode.receive(proc, message)) return;
      if (managedDesktopRelay.receive(proc, message)) return;
      if (orgLibrary?.receive(message)) return;
      if (receivePhoneSecretSave(proc, message) || cloudLogins.receive(proc, message)) return;
    } catch (error) {
      slog(`desktop private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    if (!serverSupervisor.isCurrent(proc)) return;
    syncDesktopMutationToken(proc);
    syncPhoneSecretKey(proc);
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    trustedApprovalMode.rejectProcess(proc);
    managedDesktopRelay.rejectProcess(proc);
    resolveServerExit();
    slog(`exited code=${code}`);
  });
  serverSupervisor.watch(proc);
  const identity = await pollServerIdentity({
    port,
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited || desktopShutdownStarted,
    isListening: listening.heard,
    listeningGraceMs: SERVER_LISTENING_GRACE_MS,
  });
  if (identity.outcome === "ready" && serverSupervisor.isCurrent(proc)) return { proc };
  slog(bootFailureMessage(port, identity));
  const stopped = await stopUtilityServer(proc);
  if (!stopped) {
    slog(`child on port ${port} did not exit after termination; refusing to start a sibling server`);
  }
  return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
}

async function startServerPackaged() {
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of DESKTOP_PORTS) {
      if (desktopShutdownStarted) return false;
      const started = await startServerOn(port);
      if (started.proc) {
        SERVER_PORT = port;
        if (serverSupervisor.ready(started.proc)) return true;
      }
      if (started.abort) return false;
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

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged || desktopRemoteAccess ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
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

  // Clear the ref first so the stale window's close handler no-ops; a token-bearing URL is never retained.
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
      // Non-persistent partition: provider cookies stay out of the app renderer and die on exit.
      partition: "openmausbot-desktop-viewer",
    },
  });
  desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;

  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  // A child window gets keystrokes only once focused; unfocused, typing lands in the app's composer.
  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
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
    }
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {
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
      throw new Error("The two-desktop view belongs to another app window");
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

  // Native child views outlive the renderer DOM; close both panes so no secret-bearing noVNC URL survives.
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
    throw new Error("The two-desktop view is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The two-desktop view belongs to another app window");
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

const { LOCAL_ID, activeEnvironment, activeRemote, allowedOrigins, bootEnvironmentDir, parseEnvironments, parseHostedWorkspaceLink, serializeEnvironments, startupEnvironmentDir, withActive, withEnvironment, withEnvironmentLook, withLocalEnvironment, withMicrophone, withoutEnvironment, placesMenuOptions, workspaceMenuTemplate, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceSummary, workspaceWindowTitle } = environmentsModule;
let environmentsState = { environments: [], activeId: LOCAL_ID };
let computerSharing;
const sharingPrompts = new Set();

let sharedComputersAllowed = false;

async function refreshSharedComputersAllowed() {
  sharedComputersAllowed = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, { signal: AbortSignal.timeout(3_000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((status) => status?.features?.sharedComputers === true)
    .catch(() => false);
  return sharedComputersAllowed;
}

async function requireSharedComputers() {
  if (await refreshSharedComputersAllowed()) return;
  throw new Error("Computer sharing is turned off on this server.");
}

function sharingController() {
  computerSharing ??= createComputerSharing({
    file: path.join(app.getPath("userData"), "computer-sharing.json"),
    // Holds provider API keys and sessions.json: a broad share must never reach it.
    protectedPaths: [desktopDataDir()],
    fetch: (...args) => session.defaultSession.fetch(...args),
    environments: () => environmentsState.environments,
    enabled: refreshSharedComputersAllowed,
    cloud: cloudLendingSnapshot, power: cloudPower, reconnect: origin => signInCloudSession({ origin, mine: myCloud(), pair: () => ensureCloudAccount().pairHome(), fetch: (...args) => session.defaultSession.fetch(...args) }),
    onChange: summary => lendingIndicator().update({ lending: summary.lending.length > 0, busy: Boolean(summary.busy && summary.lending.includes(summary.busy.env)) }),
    cuaConnection: () => cuaReady, screenLocked: () => powerMonitor.getSystemIdleState(1) === "locked",
    hostControl: async (id, signal) => {
      const lease = async action => {
        const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/desktop/shared-computer-control`, {
          method: "POST",
          headers: desktopServerHeaders({ "content-type": "application/json" }, { packaged: app.isPackaged, token: desktopMutationToken }),
          body: JSON.stringify({ id, action }),
          signal: action === "release" ? AbortSignal.timeout(3000) : AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        if (!response.ok) throw new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting.");
      };
      await lease("acquire");
      return { renew: () => lease("acquire"), release: () => lease("release") };
    },
  });
  return computerSharing;
}

let lastCloudHome = null;
function cloudLendingSnapshot() {
  if (!cloudAccount) return null;
  const state = cloudAccount.state();
  const accountId = state.account?.id ?? null;
  const origin = state.status === "connected" ? (state.machine?.origin ?? null) : null;
  if (origin && accountId) lastCloudHome = { accountId, origin };
  else if (!accountId || lastCloudHome?.accountId !== accountId) lastCloudHome = null;
  return { status: state.status === "signed-out" && state.message === "restoring" ? "restoring" : state.status, accountId, origin };
}

function cloudLendingEnvironment() {
  const snapshot = cloudLendingSnapshot();
  const origin = snapshot?.origin ?? (lastCloudHome?.accountId === snapshot?.accountId ? lastCloudHome?.origin : null);
  return origin ? environmentsState.environments.find(entry => entry.origin === origin) ?? null : null;
}

function stopLending() {
  for (const env of environmentsState.environments) if (computerSharing?.cloudState(env).enabled) computerSharing.revoke(env);
}

async function openLendingSettings() {
  if (!app.isPackaged || desktopRemoteAccess || !serverReady) return;
  if (activeRemote(environmentsState)) persistEnvironments(withActive(environmentsState, LOCAL_ID));
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) win.webContents.send("app:open-settings", "cloud-settings");
  else await win.loadURL(`${rendererOrigin()}/?desktop-settings=cloud-settings`);
}

let lendingTray = null;
function lendingIndicator() {
  lendingTray ??= createLendingIndicator({
    Tray, Menu, nativeImage, iconPath: APP_ICON,
    onStop: stopLending,
    onOpen: () => void openLendingSettings().catch(error => slog(`lending settings: ${error?.message ?? error}`)),
  });
  return lendingTray;
}

async function offerComputerSharing(win) {
  const env = activeEnvironment(environmentsState);
  if (!env || sharingPrompts.has(env.id) || win.isDestroyed()) return;
  if (env.origin === cloudAccount?.homeTarget()?.origin) return;
  if (!(await refreshSharedComputersAllowed()) || win.isDestroyed()) return;
  sharingPrompts.add(env.id);
  try {
    const info = await sharingController().observe(env);
    if (!info || win.isDestroyed() || activeEnvironment(environmentsState)?.id !== env.id || new URL(win.webContents.getURL()).origin !== env.origin) return;
    const choice = await dialog.showMessageBox(win, {
      type: "question", message: `Share this computer with ${env.name}?`,
      detail: "Let this server’s bots use folders and capabilities you choose while this desktop app is running. Nothing is shared unless you enable it. You can change this later in Settings → Servers.",
      buttons: ["Choose access", "Not now"], defaultId: 1, cancelId: 1,
    });
    sharingController().decline(env, info);
    if (choice.response === 0) openWorkspaceSettings(env.id);
  } catch {}
  finally { sharingPrompts.delete(env.id); }
}

function environmentsFile() {
  return path.join(app.getPath("userData"), cloudTarget(process.env).environments);
}

function readEnvironments() {
  try {
    const state = parseEnvironments(fs.readFileSync(environmentsFile(), "utf8"));
    return {
      ...state,
      environments: state.environments.map((entry) =>
        entry.kind === "local" ? { ...entry, missing: !fs.existsSync(entry.dataDir) } : { ...entry, missing: false }),
    };
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
    throw new Error("Could not save server connections on this computer. Please try again.");
  }
}

function activeOrigin() {
  return activeEnvironment(environmentsState)?.origin ?? rendererOrigin();
}

function refreshApplicationMenu() {
  Menu.setApplicationMenu(
    buildApplicationMenu({
      environments: environmentsState.environments,
      activeId: environmentsState.activeId,
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onAddFromClipboard: () => void addServerFromClipboard(),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onOrganizationSignIn: () => queueOrganizationEntry("openmausbot://organization"),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
      onOpenSettings: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:open-settings");
      },
      ...cloudMenuOptions(),
    }),
  );
}

function persistEnvironments(next) {
  writeEnvironments(next);
  environmentsState = next;
  refreshApplicationMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(workspaceWindowTitle(environmentsState, desktopRemoteAccess));
}

async function workspaceMenuAction(action) {
  try { await action(); } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not update servers", detail: error.message });
  }
}

function navigateMainWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  return mainWindow.loadURL(url).then(() => true, () => false);
}

let rememberedHome = null;

function acquireDataDirLeaseFor(dir) {
  return dir === desktopDataDir()
    ? acquireDataDirLease(dir, { legacyDataDir: path.join(app.getPath("home"), ".opengrokbot") })
    : acquireDataDirLease(dir);
}

/** Pause the supervisor first, or its recovery forks on the wrong data dir; resume() stays in the finally. */
async function switchLocalEnvironmentTo(targetDir, targetId) {
  if (!app.isPackaged) return { ok: false, error: "dev" };
  // A second switch would be un-paused by the first's finally mid-handoff.
  if (localSwitchInFlight) return { ok: false, error: "busy" };
  const previousDir = runningDataDir ?? startupEnvironmentDir(environmentsState, desktopDataDir());
  let startedProc = null;
  let switchSucceeded = false;
  const failedSwitch = () => {
    dialog.showErrorBox(
      "Could not switch environments",
      "OpenMausBot could not switch to that environment. The app log has the details.",
    );
    return { ok: false, error: "switch-failed" };
  };
  localSwitchInFlight = true;
  serverSupervisor.pause();
  try {
    const result = await switchLocalEnvironment({
      targetDir,
      targetId,
      port: SERVER_PORT,
      deps: {
        stopChild: async () => {
          // A child that will not die still writes to its folder: abort with the lease still held.
          const proc = serverProc;
          if (proc && !(await stopUtilityServer(proc))) throw new Error("the server child did not stop");
        },
        releaseLease: async () => {
          desktopDataDirLease?.release();
          desktopDataDirLease = null;
        },
        acquireLease: async (dir) => {
          desktopDataDirLease = acquireDataDirLeaseFor(dir);
          runningDataDir = dir;
        },
        createDir: async (dir) => {
          await fs.promises.mkdir(dir, { recursive: true });
        },
        startChild: async (port) => {
          const started = await startServerOn(port, targetDir);
          if (!started.proc) return null;
          startedProc = started.proc;
          serverSupervisor.ready(started.proc);
          return started.proc;
        },
        probeReady: async () => "ready",
        rollback: async () => {
          if (startedProc) await stopUtilityServer(startedProc);
          try {
            desktopDataDirLease?.release();
          } catch (error) {
            slog(`switch rollback lease release failed: ${error?.message ?? error}`);
          }
          desktopDataDirLease = null;
          desktopDataDirLease = acquireDataDirLeaseFor(previousDir);
          runningDataDir = previousDir;
          const restored = await startServerOn(SERVER_PORT, previousDir);
          // startServerOn only watches; without ready() the rolled-back child has no owner.
          if (restored.proc) serverSupervisor.ready(restored.proc);
          else {
            const error = new Error(`could not restart the server on ${previousDir}`);
            slog(`switch rollback ${error.message}`);
            throw error;
          }
        },
        persistActive: (id) => persistEnvironments(withActive(environmentsState, id)),
        log: slog,
      },
    });
    if (!result.ok) {
      slog(`environment switch to ${targetDir} failed (${result.error})`);
      return failedSwitch();
    }
    switchSucceeded = true;
    navigateMainWindow(rendererOrigin());
    return { ok: true };
  } catch (error) {
    slog(`environment switch to ${targetDir} failed (${error?.message ?? error})`);
    return failedSwitch();
  } finally {
    localSwitchInFlight = false;
    serverSupervisor.resume();
    if (!switchSucceeded && (!serverProc || !serverSupervisor.isCurrent(serverProc))) {
      slog(`environment switch to ${targetDir} left no server child; restarting the active environment`);
      try {
        const revived = await startServerOn(SERVER_PORT);
        if (revived.proc) serverSupervisor.ready(revived.proc);
        else slog(`could not restart the server after the failed environment switch`);
      } catch (error) {
        slog(`restart after failed environment switch threw (${error?.message ?? error})`);
      }
    }
  }
}

async function switchEnvironment(id) {
  if (id === environmentsState.activeId || (id !== LOCAL_ID && !environmentsState.environments.some((entry) => entry.id === id))) return;
  const entry = environmentsState.environments.find((candidate) => candidate.id === id);
  if (entry?.kind === "local") return await switchLocalEnvironmentTo(entry.dataDir, entry.id);
  if (id === LOCAL_ID && (runningDataDir ?? desktopDataDir()) !== desktopDataDir()) {
    return await switchLocalEnvironmentTo(desktopDataDir(), LOCAL_ID);
  }
  if (entry && cloudAccount && isCloudHomeEntry(entry, { homeOrigin: cloudAccount.homeTarget()?.origin, remembered: rememberedHome })) {
    try { await connectCloudHome(); return; } catch (error) {
      slog(`cloud home: could not connect from the Server menu (${error?.message ?? error})`);
      if (!(await cloudHomeSignedIn(entry.origin))) { await openLendingSettings(); return; }
    }
  }
  persistEnvironments(withActive(environmentsState, id));
  navigateMainWindow(activeOrigin());
}

function createLocalEnvironment(name, dataDir) {
  if (!app.isPackaged) return { ok: false, error: "dev", state: environmentsState };
  const state = environmentsState;
  let candidateDir;
  if (dataDir === undefined || dataDir === null || dataDir === "") {
    const slug = typeof name === "string"
      ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      : "";
    if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name", state };
    candidateDir = path.join(os.homedir(), `.openmausbot-${slug || randomUUID().slice(0, 8)}`);
  } else {
    candidateDir = typeof dataDir === "string" ? dataDir.trim() : "";
    if (
      !candidateDir
      || candidateDir.split("/").some((segment) => segment === "." || segment === "..")
      || candidateDir !== path.normalize(candidateDir)
    ) {
      return { ok: false, error: "path", state };
    }
  }
  const result = withLocalEnvironment(state, { name, dataDir: candidateDir }, randomUUID, desktopDataDir());
  if (!result.ok) return { ok: false, error: result.error, state };
  persistEnvironments(result.state);
  return { ok: true, state: environmentsState };
}

const organizationEntry = createOrganizationEntry({
  readState: () => ({ environments: environmentsState, remoteAccess: desktopRemoteAccess,
    restartIntent: organizationRestartIntent(secureCredentialState?.read() ?? secureCredentials) }),
  confirm: async ({ kind, name, origin }) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: [kind === "companion" ? "Disconnect and restart locally" : "Use this computer", "Cancel"],
      defaultId: 1, cancelId: 1,
      message: kind === "companion" ? `Disconnect from ${name} to sign in locally?` : `Leave ${name} and sign in on this computer?`,
      detail: `${origin}\n\nOrganization sign-in connects company models to this computer. ${kind === "companion" ? "This disconnects desktop companion access and restarts the app. You can pair again later." : "The hosted connection stays saved and can be selected again from the Server menu."} No remote bots, conversations or provider accounts are moved or deleted.`,
    });
    return response === 0;
  },
  saveEnvironments: persistEnvironments,
  disconnectAndRemember: async expected => {
    await updateSecureCredentialDocument(credentials => {
      const current = desktopCompanionAccess(credentials);
      if (!current || current.endpoint !== expected.endpoint || current.deviceId !== expected.deviceId || current.token !== expected.token) {
        throw new Error("The companion connection changed. Choose organization sign-in again.");
      }
      return withOrganizationRestartIntent(credentials);
    });
    desktopRemoteAccess = null;
  },
  clearRestartIntent: () => updateSecureCredentialDocument(credentials =>
    organizationRestartIntent(credentials) && !desktopCompanionAccess(credentials)
      ? withoutOrganizationRestartIntent(credentials) : credentials),
  openLocalSettings: async () => {
    if (!app.isPackaged) throw new Error("Organization sign-in requires the installed desktop app.");
    if (!serverReady) throw new Error("This installation is unavailable. Restart the app and try organization sign-in again.");
    if (desktopRemoteAccess || activeRemote(environmentsState)) throw new Error("Choose this computer before signing in with your organization.");
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
    if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
      win.webContents.send("app:open-settings", "organization");
    } else {
      await win.loadURL(`${rendererOrigin()}/?desktop-settings=organization`);
    }
  },
  relaunch: relaunchAfterDesktopRemoteChange,
});

function queueOrganizationEntry(link) {
  if (!isOrganizationDeepLink(link)) return false;
  pendingOrganizationEntry = true;
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  void deliverOrganizationEntry();
  return true;
}

async function deliverOrganizationEntry() {
  if (!organizationEntryReady || !pendingOrganizationEntry) return false;
  pendingOrganizationEntry = false;
  let delivered = false;
  await workspaceMenuAction(async () => { delivered = await organizationEntry.request(); });
  return delivered;
}

async function openCloudEntry() {
  if (!app.isPackaged) throw new Error("MausBot Cloud requires the installed desktop app.");
  if (desktopRemoteAccess) throw new Error("This app is connected to another computer. Disconnect it to use MausBot Cloud on this computer.");
  if (!serverReady) throw new Error("This installation is unavailable. Restart the app and open My Cloud again.");
  await cloudAccountRestored();
  const active = activeRemote(environmentsState);
  const showingCloud = Boolean(active) && active.origin === cloudAccount?.homeTarget()?.origin;
  if (active && !showingCloud) persistEnvironments(withActive(environmentsState, LOCAL_ID));
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: !showingCloud });
  if (showingCloud) return true;
  const action = cloudLinkOpensSheet(cloudAccount?.state()) ? "cloud-add" : "cloud";
  void cloudAccount?.refresh().catch(() => {});
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
    win.webContents.send("app:open-settings", action);
  } else {
    await win.loadURL(`${rendererOrigin()}/?desktop-settings=${action}`);
  }
  return true;
}

function openWorkspaceSettings(computerId, panel = "computer") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const id = typeof computerId === "string" ? computerId : null, copy = panel === "copy";
  if (senderIsLocal({ sender: mainWindow.webContents })) {
    mainWindow.webContents.send("workspaces:open-settings", id, ...(copy ? ["copy"] : []));
  } else {
    persistEnvironments(withActive(environmentsState, LOCAL_ID));
    navigateMainWindow(`${rendererOrigin()}/?desktop-settings=workspaces${id ? `&${copy ? "copy-to" : "share-computer"}=${encodeURIComponent(id)}` : ""}`);
  }
}

async function addServerFromClipboard() {
  try {
    return await connectHostedWorkspace(clipboard.readText());
  } catch (error) {
    await dialog.showMessageBox({ type: "info", message: "Could not connect to the server", detail: `${error.message}\nYou can also choose Connect to a server to enter an address in Settings.` });
    return false;
  }
}

async function connectHostedWorkspace(input, name) {
  const link = parseHostedWorkspaceLink(input);
  if (!link) {
    throw new Error("Enter an HTTPS server address or a full pairing link. Keep the pairing code after #, not in the URL query.");
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
  if (response !== 0) return false;
  let next = withEnvironment(environmentsState, { origin: link.origin, name }, () => randomUUID());
  const added = next.environments.find((e) => e.origin === link.origin);
  next = withActive(next, added.id);
  persistEnvironments(next);
  navigateMainWindow(link.url);
  return true;
}

function rememberCloudHome(state) {
  try {
    const next = withCloudHome(environmentsState, state?.status === "connected" ? state.machine : null, () => randomUUID(), cloudLook.pending());
    if (next !== environmentsState) persistEnvironments(next);
  } catch (error) {
    slog(`cloud home: could not list the Cloud machine under Servers (${error?.message ?? error})`);
  }
}

async function connectCloudHome(open = null) {
  const client = ensureCloudAccount();
  const target = client.homeTarget();
  if (!target) throw new Error("My Cloud is not ready to connect yet.");
  const signedIn = await openSleepingCloud({ power: client.power(), wake: client.wakeHome, waking: client.setWaking, signedIn: timeoutMs => cloudHomeSignedIn(target.origin, timeoutMs) });
  const grant = signedIn ? null : await client.pairHome();
  let next = withCloudHome(environmentsState, { status: "ready", origin: target.origin }, () => randomUUID(), cloudLook.pending());
  const entry = next.environments.find((candidate) => candidate.origin === target.origin);
  if (!entry) throw new Error("My Cloud could not be added to Servers.");
  next = withActive(next, entry.id);
  persistEnvironments(next);
  navigateMainWindow(cloudHomeConnectUrl({ origin: target.origin, grant }, Date.now(), open));
  cloudPower.woke(); client.checkoutDone(); return client.state();
}

async function cloudHomeSignedIn(origin, timeoutMs = 5_000) {
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/auth/session`, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && (await response.json())?.kind === "session";
  } catch { return false; }
}

// Per-server microphone consent; "Don't Allow" holds until quit or forget, so a page cannot keep re-asking.
const remoteMicrophoneAsks = new Map();
const remoteMicrophoneRefused = new Set();
function askRemoteMicrophone(origin) {
  const env = activeEnvironment(environmentsState);
  if (!env || env.origin !== origin || env.microphone === true || remoteMicrophoneRefused.has(origin)) return null;
  if (!remoteMicrophoneAsks.has(origin)) {
    const ask = (async () => {
      const options = {
        type: "question",
        buttons: ["Allow", "Don’t Allow"],
        defaultId: 1,
        cancelId: 1,
        message: `Allow “${env.name}” to use the microphone?`,
        detail: `${new URL(origin).host} wants to hear you for a Live call. Allow only a server you trust; this app remembers your answer for this server until you forget it.`,
      };
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 0) return void remoteMicrophoneRefused.add(origin);
      if (environmentsState.environments.some((e) => e.id === env.id && e.origin === origin)) persistEnvironments(withMicrophone(environmentsState, env.id));
    })().finally(() => remoteMicrophoneAsks.delete(origin));
    remoteMicrophoneAsks.set(origin, ask);
  }
  return remoteMicrophoneAsks.get(origin);
}

async function forgetEnvironment(id, purge = false) {
  const env = environmentsState.environments.find((e) => e.id === id);
  if (!env) return;
  if (env.kind === "local" && environmentsState.activeId === id) return { ok: false, error: "active" };
  if (env.kind !== "local") {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Forget", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Forget “${env.name}”?`,
      detail: "This app signs out of that server. The server keeps its own session list; revoke it there too if the device is gone.",
    });
    if (response !== 0) return;
  }
  sharingController().forget(env);
  remoteMicrophoneRefused.delete(env.origin);
  const wasActive = environmentsState.activeId === id;
  if (purge === true && env.kind === "local") {
    // Never rm -rf "This computer"'s dir; the entry stays until the delete has actually happened.
    if (localSwitchInFlight) return { ok: false, error: "busy" };
    const resolved = path.resolve(env.dataDir);
    const root = path.resolve(desktopDataDir());
    // realpath, so a symlink named like a data dir cannot fool the guard.
    const canonical = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };
    const resolvedCanon = canonical(resolved);
    const rootCanon = canonical(root);
    if (runningDataDir && canonical(runningDataDir) === resolvedCanon) return { ok: false, error: "active" };
    if (path.basename(resolved).startsWith(".openmausbot") && resolvedCanon !== rootCanon && !resolvedCanon.startsWith(rootCanon + path.sep)) {
      try {
        await fs.promises.rm(resolved, { recursive: true, force: true });
      } catch (error) {
        slog(`forget environment: purge failed (${error?.message ?? error})`);
        return { ok: false, error: "purge" };
      }
    } else {
      slog(`forget environment: purge skipped for ${env.dataDir}`);
    }
  }
  persistEnvironments(withoutEnvironment(environmentsState, id));
  if (wasActive) navigateMainWindow(activeOrigin());
  if (!env.origin) return { ok: true };
  try {
    // Revoke the session on the server while the cookie is still here.
    const response = await session.defaultSession.fetch(`${env.origin}/api/auth/logout`, { method: "POST", credentials: "include", headers: { origin: env.origin }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    slog(`forget server: logout skipped (${error?.message ?? error})`);
    await dialog.showMessageBox({ type: "warning", message: "Connection forgotten; server sign-out could not be confirmed", detail: "Computer sharing is stopped. Revoke this desktop’s session on that server when it is reachable again." });
  }
  try {
    // Not cookies: Chromium's cookie storage is host-wide, not port-scoped, so other saved servers would sign out.
    await session.defaultSession.clearStorageData({ origin: env.origin, storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  } catch (error) {
    slog(`forget server: storage clear failed: ${error?.message ?? error}`);
  }
  return { ok: true };
}

function showContextMenu(win, params) {
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

function createWindow({ deferNavigation = false } = {}) {
  const waitsForSkinSync = process.platform === "win32";
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: !waitsForSkinSync && !startupScreen,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [...desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess),
        ...(app.isPackaged && !desktopRemoteAccess ? ["--omb-company-desktop=1"] : [])],
    },
  });
  mainWindow = win;
  win.on("show", () => desktopTray?.windowShown(win));
  win.on("focus", () => { if (cloudAccount?.checkoutPending()) void cloudAccount.refresh().catch(() => {}); });
  win.on("close", (event) => {
    if (process.platform === "win32" && !desktopShutdownStarted && desktopTray) {
      event.preventDefault();
      desktopTray.hide(win);
    }
  });
  win.setTitle(workspaceWindowTitle(environmentsState, desktopRemoteAccess));
  win.webContents.on("page-title-updated", event => {
    if (!desktopRemoteAccess && !activeEnvironment(environmentsState)) return;
    event.preventDefault();
    win.setTitle(workspaceWindowTitle(environmentsState, desktopRemoteAccess));
  });
  attachUpdaterWindow(win);
  if (startupScreen) startupScreen.attach(win, { maximized: restored.maximized });
  else if (waitsForSkinSync) {
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
  if (restored.maximized && !startupScreen) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(externalWebUrl(url)).catch(() => {
        console.warn("The external web link could not be opened");
      });
    } catch {
    }
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    if (workspaceNavigationAllowed(url, environmentsState, rendererOrigin())) return;
    event.preventDefault();
    slog(`blocked navigation to ${origin ?? "an invalid address"}`);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  // No page may embed the local server, or any saved server, in this preload-bearing window.
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
    const remote = activeRemote(environmentsState);
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
      detail: `${cloudUnreachableText(cloudAccount?.state(), remote.origin) ?? `${errorDescription}.`} Showing the local server instead; choose it again from the Server menu when it is back.`,
    });
    void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
  });
  // Not did-finish-load: Electron still reports the main frame as loading then.
  win.webContents.on("did-stop-loading", () => {
    deliverPackageInstall(win);
    deliverChatLink(win);
  });
  win.webContents.on("did-finish-load", () => void offerComputerSharing(win));

  // Electron has no default context menu.
  win.webContents.on("context-menu", (_event, params) => {
    showContextMenu(win, params);
  });

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

  const remote = activeRemote(environmentsState);
  if (!serverReady && (desktopRemoteAccess || (app.isPackaged && !remote))) serverUnavailableWindows.add(win);
  if (deferNavigation) return win;
  if (desktopRemoteAccess) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else if (remote) {
    void win.loadURL(remote.origin).catch(() => {});
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// From main so macOS attributes the Screen Recording prompt to the app, not the server.
ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
}));

// Renderer-controlled text must never become a process argument: the user reviews and pastes it.
ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
}));

ipcMain.handle("clipboard:write-text", localOnly("clipboard:write-text", (_event, text) => writeClipboardText(clipboard, text)));

ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}));

// Secrets are never read, and the report is redacted again on the way out.
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

// The path is renderer-controlled: it must resolve inside ~/.openmausbot to a regular file, never a symlink escape.
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
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
}));

ipcMain.handle("desktop:reveal-file", localOnly("desktop:reveal-file", async (_event, rawPath) => {
  if (desktopRemoteAccess) throw new Error("That file is on the computer this app is connected to");
  return revealInFolder(rawPath, { reveal: (target) => shell.showItemInFolder(target) });
}));
ipcMain.handle("desktop:open-logs", localOnly("desktop:open-logs", () => openLogsFolder(LOG_DIR, { open: (folder) => shell.openPath(folder) })));
ipcMain.handle("desktop:skin", (event, skin) => {
  if (!isKnownSkin(skin)) return false;
  try {
    const { color } = skinChrome(skin);
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) {
      try { win.setBackgroundColor(color); } catch {}
    }
  } catch {}
  return true;
});

for (const [channel, act] of [
  ["window:minimize", (win) => win.minimize()],
  ["window:toggle-maximize", (win) => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ["window:close", (win) => win.close()],
]) {
  ipcMain.handle(channel, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win || win.isDestroyed()) return false;
    act(win);
    return true;
  });
}
ipcMain.handle("window:state", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});

// Links resolved after Chromium's click gesture ended would be blocked as popups via window.open.
ipcMain.handle("desktop:open-external", localOnly("desktop:open-external", async (_event, rawUrl) => {
  await shell.openExternal(externalWebUrl(rawUrl));
  return true;
}));

// The Boat VNC viewer must be a top-level page for its token exchange.
ipcMain.handle("desktop-viewer:open", localOnly("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
}));

// URL validation, sandboxing, session isolation and the one-interactive-pane rule stay here, not in the renderer.
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

// Only the owner of the current viewer may close it.
ipcMain.handle("desktop-viewer:close", localOnly("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
}));

ipcMain.handle("desktop-viewer:state-now", localOnly("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
})));

// No Screen Recording request path: on macOS 15+ preflight caches per process, a helper is TCC-attributed
// to itself on macOS 26, and Sequoia re-prompts anyway. The first real in-process capture prompts correctly.
let appPermissions = null;
ipcMain.handle("perm:status", (event) => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
  pageMic: appPermissions?.pageMicrophone(event) ?? "refused",
}));
ipcMain.handle("perm:request-mic", localOnly("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}));

// macOS never re-prompts a denied permission; System Settings is the only path.
ipcMain.handle("perm:open-settings", localOnly("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  // Own-property lookup: "__proto__" or "constructor" must not resolve up the prototype chain.
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
}));

ipcMain.handle("desktop:relaunch", localOnly("desktop:relaunch", (event) => {
  requireMainWindowSender(event);
  relaunchAfterDesktopRemoteChange();
  return true;
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

ipcMain.handle("companion:state", localOnly("companion:state", () => desktopCompanionState()));
function managedRemoteAccessRefusal() {
  const policy = managedDesktop?.policy?.();
  return policy?.remoteAccess === false ? `${policy.organizationName} does not allow remote access to this computer.` : null;
}
ipcMain.handle("companion:start", localOnly("companion:start", () => startDesktopCompanion()));
ipcMain.handle("companion:stop", localOnly("companion:stop", () => stopDesktopCompanion()));
ipcMain.handle("companion:keep-awake", localOnly("companion:keep-awake", async (_event, enabled) => {
  rememberCompanionKeepAwake(Boolean(enabled));
  return desktopCompanionState();
}));
ipcMain.handle("routines:wake-state", localOnly("routines:wake-state", () => routineWake.poll()));
ipcMain.handle("routines:keep-awake", localOnly("routines:keep-awake", async (_event, enabled) => {
  rememberRoutineWake(app.getPath("userData"), Boolean(enabled));
  return routineWake.poll();
}));
ipcMain.handle("companion:refresh-tailscale", localOnly("companion:refresh-tailscale", () => refreshDesktopCompanionTailscale()));
ipcMain.handle("companion:pairing", localOnly("companion:pairing", (_event, open, expectedToken) => {
  const refusal = open ? managedRemoteAccessRefusal() : null;
  if (refusal) throw new Error(refusal);
  return companionPairing(Boolean(open), expectedToken).then(decorateDesktopCompanionState);
}));
ipcMain.handle("companion:cloud-desktop", localOnly("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
));
ipcMain.handle("companion:browser-control", localOnly("companion:browser-control", (_event, deviceId, allowed) =>
  companionBrowserControlAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
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
  if (!sender || sender !== mainWindow || sender.isDestroyed() ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("The desktop client window is unavailable");
  }
}

function relaunchAfterDesktopRemoteChange() {
  if (desktopShutdownStarted) return;
  desktopShutdownStarted = true;
  const timer = setTimeout(() => {
    // Electron's default relaunch reuses the native argv, which still holds the consumed one-shot action.
    app.relaunch({ args: process.argv.slice(1) });
    app.quit();
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
  await updateSecureCredentialDocument((credentials) => withoutOrganizationRestartIntent(withDesktopCompanionAccess(credentials, access)));
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

// Auth and connector credentials never cross this boundary.
ipcMain.handle("companion-account:state", localOnly("companion-account:state", () => ensureCompanionAccountService().state()));
ipcMain.handle("companion-account:request-code", localOnly("companion-account:request-code", (_event, email) =>
  ensureCompanionAccountService().requestCode(email),
));
ipcMain.handle("companion-account:verify-code", localOnly("companion-account:verify-code", (_event, email, code) =>
  ensureCompanionAccountService().verifyCode(email, code),
));
ipcMain.handle("companion-account:retry", localOnly("companion-account:retry", () => ensureCompanionAccountService().retry()));
ipcMain.handle("companion-account:prepare", localOnly("companion-account:prepare", () => {
  const refusal = managedRemoteAccessRefusal();
  if (refusal) throw new Error(refusal);
  return ensureCompanionAccountService().prepare();
}));
ipcMain.handle("companion-account:sign-out", localOnly("companion-account:sign-out", () => ensureCompanionAccountService().signOut()));

const workspaceOnly = (handler) => (event, ...args) => {
  if (!workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin())) throw new Error("These controls are only available in the main desktop window");
  return handler(event, ...args);
};
const localWorkspaceOnly = (channel, handler) => localOnly(channel, workspaceOnly(handler));
// No renderer-supplied address, token, paid flag or callback can choose an account or activate Pro.
for (const method of ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard", "offer"]) {
  ipcMain.handle(`cloud-account:${method}`, localWorkspaceOnly(`cloud-account:${method}`, () => ensureCloudAccount()[method]()));
}
ipcMain.handle("cloud-account:checkout", localWorkspaceOnly("cloud-account:checkout", async (_event, plan, source) => {
  if (!(await cloudOffersReady())) throw new Error("MausBot Cloud isn't offered in this app.");
  const client = ensureCloudAccount();
  if (typeof plan !== "string" || !CHECKOUT_SOURCES.includes(source)) throw new Error("Choose a plan to continue.");
  const offer = await client.offer();
  if (!offer?.plans.some(entry => entry.tier === plan)) throw new Error("Choose a plan to continue.");
  return client.checkout(plan, source);
}));
// The machine and its code come from the verified session in main, never from the renderer.
ipcMain.handle("cloud-account:connectHome", localWorkspaceOnly("cloud-account:connectHome", () => connectCloudHome()));
ipcMain.handle("cloud-account:connectHomeForPhone", localWorkspaceOnly("cloud-account:connectHomeForPhone", () => connectCloudHome("phone")));
ipcMain.handle("organization:settings-opened", localWorkspaceOnly("organization:settings-opened", () => organizationEntry.settingsOpened()));
ipcMain.handle("organization:state", localWorkspaceOnly("organization:state", () => ensureManagedDesktop().state()));
ipcMain.handle("organization:begin", localWorkspaceOnly("organization:begin", (_event, input) => ensureManagedDesktop().begin(input)));
ipcMain.handle("organization:reopen", localWorkspaceOnly("organization:reopen", () => ensureManagedDesktop().reopen()));
ipcMain.handle("organization:cancel", localWorkspaceOnly("organization:cancel", () => ensureManagedDesktop().cancelEnrollment()));
ipcMain.handle("organization:refresh", localWorkspaceOnly("organization:refresh", () => ensureManagedDesktop().refresh()));
ipcMain.handle("organization:disconnect", localWorkspaceOnly("organization:disconnect", () => {
  companyBackupConfigurationRevision++;
  companyBackupController?.abort(); preparedCompanyRestore = null;
  const client = ensureManagedDesktop();
  return client.disconnect();
}));
ipcMain.on("company-backups:client-state", receiveCompanyBackupClientState);
ipcMain.handle("company-backups:configure-schedule", localWorkspaceOnly("company-backups:configure-schedule", async (_event, input) => {
  ensureManagedDesktop();
  const revision = ++companyBackupConfigurationRevision;
  if (input?.enabled === true) {
    const scope = companyBackupScope(), proc = serverProc;
    if (!scope || companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
    const status = await localBackupStatus(proc), current = companyBackupScope();
    if (revision !== companyBackupConfigurationRevision || status.busy || status.pendingRestore || !current || scope.key !== current.key || scope.generation !== current.generation ||
        companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
  }
  await companyBackupSchedule.configure(input);
  return { ...companyBackupState, schedule: companyBackupSchedule.state() };
}));
ipcMain.handle("company-backups:state", localWorkspaceOnly("company-backups:state", async () => {
  const status = await localBackupStatus(serverProc);
  return { ...companyBackupState, pendingRestore: status.pendingRestore };
}));
ipcMain.handle("company-backups:list", localWorkspaceOnly("company-backups:list", () => ensureManagedDesktop().requestBackup("/api/desktop/backups")));
ipcMain.handle("company-backups:create", localWorkspaceOnly("company-backups:create", (_event, input) => runCompanyBackup("backup", input)));
ipcMain.handle("company-backups:preview", localWorkspaceOnly("company-backups:preview", (_event, input) => runCompanyBackup("restore", input)));
ipcMain.handle("company-backups:cancel", localWorkspaceOnly("company-backups:cancel", () => { companyBackupController?.abort(); }));
ipcMain.handle("company-backups:delete", localWorkspaceOnly("company-backups:delete", (_event, input) => {
  if (companyBackupController || input?.confirmation !== "DELETE" || !/^[a-f0-9-]{36}$/.test(input?.id)) throw new Error("Confirm the exact backup to delete when no transfer is running.");
  return ensureManagedDesktop().requestBackup(`/api/desktop/backups/${input.id}`, { method: "DELETE" });
}));
ipcMain.handle("company-backups:restore", localWorkspaceOnly("company-backups:restore", async (_event, input) => {
  const client = ensureManagedDesktop(), connection = client.connection();
  if (companyBackupController || companyRestoreCommitting || !preparedCompanyRestore || preparedCompanyRestore.id !== input?.id || input?.confirmation !== "REPLACE" ||
      !connection || client.state().status !== "connected" || !client.state().cloudBackups || connection.expiresAt <= Date.now() ||
      preparedCompanyRestore.proc !== serverProc || preparedCompanyRestore.deviceId !== connection.deviceId) throw new Error("Preview this backup again and type REPLACE to confirm.");
  // Consume the preview before yielding, so duplicate IPC cannot commit it twice.
  preparedCompanyRestore = null;
  companyRestoreCommitting = true;
  try {
    const response = await localBackupRequest(serverProc, "/api/workspace-backup/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: input.id, confirmation: "REPLACE" }) });
    if (!response.ok) throw new Error("This installation could not be replaced. Check local backup status before trying again.");
    publishCompanyBackupState({ busy: false, pendingRestore: true });
    return await response.json();
  } finally { companyRestoreCommitting = false; }
}));

let cloudMove = null;
const CLOUD_MOVE_LOCAL_ROUTES = /^\/api\/(?:workspace-backup\/(?:status|export|download\/[a-f\d-]{36})|cloud-move\/estimate)$/;

function ensureCloudMove() {
  if (cloudMove) return cloudMove;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Copying this computer's bots and chats needs the local desktop app on this computer.");
  cloudMove = createCloudMove({
    localRequest: (route, init) => {
      if (!serverProc || !serverReady || !CLOUD_MOVE_LOCAL_ROUTES.test(route)) throw new Error("This installation changed. Start the copy again.");
      return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
        headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
    },
    tempRoot: path.join(app.getPath("temp"), "openmaus-cloud-move"),
    availableBytes: async directory => { const disk = await fs.promises.statfs(directory); return disk.bavail * disk.bsize; },
    onState: publishCloudMoveState,
  });
  return cloudMove;
}

function publishCloudMoveState(state) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents || desktopRemoteAccess) return;
  const active = activeEnvironment(environmentsState)?.origin;
  let frame = null;
  try { frame = new URL(contents.mainFrame.url).origin; } catch {}
  if ((!active && contents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) || (active && frame === active && state.destination?.origin === active)) {
    contents.send("cloud-move:state-changed", state);
  }
}

async function peekCloudMove(origin) {
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/cloud-move`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { status: null, refusal: moveRefusal(response.status, await response.json().catch(() => null)) };
    const status = parseCloudMoveStatus(await response.json());
    return { status: status && { contents: status.contents, empty: status.empty, freeBytes: status.freeBytes, previous: status.previous, heldBytes: status.heldBytes,
      uploadReceived: status.uploadReceived, volumeBytes: status.volumeBytes, appVersion: status.appVersion, environmentId: status.environmentId }, refusal: status ? null : "unreachable" };
  } catch { return { status: null, refusal: "unreachable" }; }
}

const moveChoices = () => cloudMoveChoices(path.join(app.getPath("userData"), "cloud-move.json"));
function dismissCloudMove(origin) {
  const move = ensureCloudMove();
  if (!move.running() && move.state().destination?.origin === origin) move.reset();
  moveChoices().dismiss(origin);
}

async function cloudMoveOverview(dest, onServerPage) {
  const move = ensureCloudMove(), state = move.state();
  if (!dest) return { ...state, local: null, cloud: null, fit: null, suggest: false, destination: null, blocked: null, movedHome: await cloudAccountRestored().then(() => moveChoices().movedHome(myCloud())) };
  const [local, peek] = await Promise.all([move.estimate().catch(() => null), dest.origin ? peekCloudMove(dest.origin) : { status: null, refusal: "unreachable" }]);
  const own = !state.destination || state.destination.origin === dest.origin;
  const cloud = peek.status;
  let disk = null;
  if (dest.kind === "cloud") { try { disk = dest.disk(); } catch {} }
  const fit = local && cloud ? moveFit({ localBytes: local.bytes, freeBytes: cloud.freeBytes, uploadReceived: cloud.uploadReceived, volumeBytes: cloud.volumeBytes, disk }) : null;
  const blocked = moveBlocked({ kind: dest.kind, refusal: peek.refusal, local, cloud, busyElsewhere: move.running() && !own });
  const hasWork = Boolean(local && (local.bots > 1 || local.rooms > 0 || local.chats > 0));
  const view = own ? state : { phase: "idle" };
  const suggest = Boolean(onServerPage && !blocked && cloud?.empty && hasWork && fit?.fit !== "never" && view.phase === "idle" && !moveChoices().dismissed(dest.origin));
  const shown = value => { if (!value) return null; const { environmentId: _, ...rest } = value; return rest; };
  return { ...view, local: shown(local), cloud: shown(cloud), fit, suggest, destination: { id: dest.id, name: dest.name, origin: dest.origin, kind: dest.kind }, blocked,
    ...(blocked === "busy_elsewhere" ? { busyWith: state.destination?.name } : {}) };
}

// ── Who asks, and where to: local Settings, and the server open in this window ──
function destinationFor(entry) {
  const homeOrigin = cloudAccount?.homeTarget()?.origin ?? null;
  if (entry.cloud || isCloudHomeEntry(entry, { homeOrigin })) {
    return { id: entry.id, name: entry.name, origin: entry.origin ?? homeOrigin, kind: "cloud",
      grant: () => ensureCloudAccount().pairHome(),
      disk: () => cloudPlanDisk(ensureCloudAccount().state()),
      grow: sizeGb => ensureCloudAccount().growDisk(sizeGb) };
  }
  return { id: entry.id, name: entry.name, origin: entry.origin, kind: "server",
    grant: () => mintOwnerCode((...args) => session.defaultSession.fetch(...args), entry.origin) };
}
function moveSender(channel, event, id, { localOnly = false } = {}) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  const local = senderIsLocal(event) && workspaceSenderAllowed(event, contents, environmentsState, rendererOrigin());
  if (local || (!localOnly && !desktopRemoteAccess)) {
    const asked = moveSenderDestination(event, { contents, environments: environmentsState, localOrigin: rendererOrigin(), cloudHomeOrigin: cloudAccount?.homeTarget()?.origin ?? null, id });
    if (asked && asked.remote === !local) return { remote: asked.remote, dest: asked.entry ? destinationFor(asked.entry) : null };
  }
  throw new Error(`${channel} is only available in this app's window`);
}
const named = dest => { if (!dest) throw new Error("Choose a server to copy this computer's bots and chats to."); return dest; };
const afterCloudMove = dest => async result => {
  if (result.phase !== "done") return result;
  try { if (dest.kind === "cloud") moveChoices().setHome(result.action === "move" ? dest.origin : null); } catch {}
  try {
    if (dest.id === environmentsState.activeId) navigateMainWindow(dest.origin);
    else if (environmentsState.environments.some(entry => entry.id === dest.id)) await switchEnvironment(dest.id);
    else if (dest.kind === "cloud") await connectCloudHome();
  } catch (error) { slog(`workspace copy: could not open ${dest.name} (${error?.message ?? error})`); }
  return result;
};
ipcMain.handle("cloud-move:state", (event, id) => { const asked = moveSender("cloud-move:state", event, id); return cloudMoveOverview(asked.dest, asked.remote); });
// A server's word about itself is untrusted: only the verified Cloud may start a copy from its own page.
ipcMain.handle("cloud-move:start", (event, id) => {
  const asked = moveSender("cloud-move:start", event, id), dest = named(asked.dest);
  if (asked.remote) {
    const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    const verifiedCloud = dest.kind === "cloud" && !desktopRemoteAccess &&
      cloudPageSenderAllowed(event, { contents, homeOrigin: cloudAccount?.homeTarget()?.origin ?? null, activeOrigin: activeEnvironment(environmentsState)?.origin });
    if (!verifiedCloud) { openWorkspaceSettings(dest.id, "copy"); return { phase: "idle" }; }
  }
  return ensureCloudMove().move(dest, { requireEmpty: asked.remote }).then(afterCloudMove(dest));
});
// A server's page stops only a copy to itself.
ipcMain.handle("cloud-move:cancel", (event) => {
  const asked = moveSender("cloud-move:cancel", event, undefined), move = ensureCloudMove();
  return asked.remote && move.state().destination?.origin !== asked.dest?.origin ? move.state() : move.cancel();
});
ipcMain.handle("cloud-move:dismiss", (event, id) => {
  const asked = moveSender("cloud-move:dismiss", event, id);
  if (asked.dest) dismissCloudMove(asked.dest.origin);
  return cloudMoveOverview(asked.dest, asked.remote);
});
// Adds what the destination lacks and stays on this computer's Settings, where the result shows.
ipcMain.handle("cloud-move:bring", (event, id) => ensureCloudMove().bring(named(moveSender("cloud-move:bring", event, id, { localOnly: true }).dest)));
ipcMain.handle("cloud-move:restore-previous", (event, id) => {
  const dest = named(moveSender("cloud-move:restore-previous", event, id, { localOnly: true }).dest);
  return ensureCloudMove().restorePrevious(dest).then(afterCloudMove(dest));
});
function myCloud() {
  return myCloudOrigin({ account: cloudAccount, remembered: rememberedHome, remoteAccess: desktopRemoteAccess });
}
const cloudPageAsking = (event) => {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (senderIsLocal(event) && workspaceSenderAllowed(event, contents, environmentsState, rendererOrigin())) return "local";
  if (cloudPageSenderAllowed(event, { contents, homeOrigin: myCloud(), activeOrigin: activeEnvironment(environmentsState)?.origin })) return "cloud";
  return null;
};
const cloudPageSender = (channel, handler) => (event) => {
  const asking = cloudPageAsking(event);
  if (!asking) throw new Error(`${channel} is only available in this app's window`);
  return handler(asking === "cloud");
};
const updaterPageAllowed = event => cloudPageAsking(event) !== null;
const updaterPageOffered = event => {
  if (updaterPageAllowed(event)) return true;
  if (desktopRemoteAccess || cloudSignInRestored) return false;
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  return cloudPageSenderAllowed(event, { contents, homeOrigin: savedCloudHomeOrigin(environmentsState), activeOrigin: activeEnvironment(environmentsState)?.origin });
};
ipcMain.on("update:offered", event => {
  try { event.returnValue = updaterPageOffered(event) === true; } catch { event.returnValue = false; }
});
ipcMain.handle("cloud-lending:open", cloudPageSender("cloud-lending:open", () => openLendingSettings()));
ipcMain.handle("cloud-plan:state", cloudPageSender("cloud-plan:state", () => {
  const state = cloudAccount?.state();
  return cloudPlanSnapshot(state, { notice: cloudTrialNotices().due(state) });
}));
ipcMain.handle("cloud-plan:notice-seen", cloudPageSender("cloud-plan:notice-seen", () => { cloudTrialNotices().seen(cloudAccount?.state()); }));
ipcMain.handle("cloud-plan:manage", cloudPageSender("cloud-plan:manage", async () => { await ensureCloudAccount().openDashboard(); }));
ipcMain.handle("cloud-plan:local", cloudPageSender("cloud-plan:local", () => workspaceMenuAction(() => switchEnvironment(LOCAL_ID))));
// ── end Copy this computer here ──

const savedWorkspace = id => {
  const env = environmentsState.environments.find(entry => entry.id === id);
  if (!env) throw new Error("This server is no longer connected");
  return env;
};
// The buying sheet (cloud-buy.mjs): its channels, and the Cloud's name and colour (Servers entry once listed).
const cloudLook = createCloudLook({ store: lookFile(() => path.join(app.getPath("userData"), cloudTarget(process.env).look), fs), accountId: () => cloudAccount?.state().account?.id ?? null,
  homeEntry: cloudHomeEntry, saveEntry: (origin, look) => persistEnvironments(withEnvironmentLook(environmentsState, origin, look)) });
const cloudBuy = installCloudBuy({ ipcMain, guard: localWorkspaceOnly, client: ensureCloudAccount, offersReady: cloudOffersReady, clipboard, look: cloudLook });
const localServer = route => (serverProc && serverReady ? fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000), headers: { [DESKTOP_MUTATION_HEADER]: desktopMutationToken } }) : Promise.reject(new Error("not running"))), reconnectCloud = origin => signInCloudSession({ origin, mine: myCloud(), pair: () => ensureCloudAccount().pairHome(), fetch: (...args) => session.defaultSession.fetch(...args) });
const cloudLogins = installCloudSend({ ipcMain, localOnly, cloudPage: cloudPageAsking, server: () => serverProc, cookieFetch: (...args) => session.defaultSession.fetch(...args), home: () => (myCloud() && cloudAccount ? { origin: myCloud(), grant: () => cloudAccount.pairHome() } : null), power: cloudPower, file: () => path.join(app.getPath("userData"), "cloud-send.json"), local: localServer, reconnect: reconnectCloud, window: () => (desktopRemoteAccess ? null : mainWindow), localOrigin: rendererOrigin, openSettings: () => void openLendingSettings(), bringChats: app.isPackaged ? () => ensureCloudMove().bring(destinationFor(cloudHomeEntry() ?? { id: null, name: CLOUD_HOME_NAME, origin: myCloud(), cloud: true })) : null });
const oneWorkspace = installOneWorkspace({ ipcMain, page: cloudPageAsking, window: () => (desktopRemoteAccess ? null : mainWindow), localOrigin: rendererOrigin, file: () => path.join(app.getPath("userData"), "one-workspace.json"), cloud: () => (myCloud() ? { origin: myCloud(), name: cloudHomeEntry()?.name ?? CLOUD_HOME_NAME } : null), cookieFetch: (...args) => session.defaultSession.fetch(...args), reconnect: reconnectCloud, power: cloudPower, local: localServer, localDefault: () => !desktopRemoteAccess && (runningDataDir ?? desktopDataDir()) === desktopDataDir(), twinHome: () => (moveChoices().movedHome(myCloud()) ? "cloud" : "computer"), reason: () => cloudUnreachableText(cloudAccount?.state() ?? null), chatsArrive: (id) => cloudLogins.chatsArrive(id), goCloud: () => connectCloudHome(), goLocal: () => switchEnvironment(LOCAL_ID) });
ipcMain.handle("sharing:state", localWorkspaceOnly("sharing:state", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().state(savedWorkspace(id).id);
}));
ipcMain.handle("sharing:folder", localWorkspaceOnly("sharing:folder", async () => {
  await requireSharedComputers();
  const picked = await dialog.showOpenDialog(mainWindow, { title: "Choose a folder to share", properties: ["openDirectory"] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return (await validateSharedFolders([{ id: randomUUID(), path: picked.filePaths[0], write: false }]))[0];
}));
ipcMain.handle("sharing:revoke", localWorkspaceOnly("sharing:revoke", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().revoke(savedWorkspace(id));
}));
// What that server's bots did here: the local log, never a server's claim.
ipcMain.handle("sharing:activity", localWorkspaceOnly("sharing:activity", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().activity(savedWorkspace(id).id, 50);
}));
ipcMain.handle("sharing:save", localWorkspaceOnly("sharing:save", async (_event, id, input) => {
  await requireSharedComputers();
  const env = savedWorkspace(id);
  const info = await sharingController().identity(env);
  const folders = await validateSharedFolders(input?.folders);
  const detail = [
    `Server: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}`),
    input?.terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    input?.computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    "Shared content is sent to this server and may reach its model provider. Bots on this server can use these permissions until you revoke them. Closing the desktop stops access.",
  ].join("\n\n");
  const confirmation = await dialog.showMessageBox(mainWindow, { type: "warning", message: `Allow computer access for ${env.name}?`, detail, buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
  if (confirmation.response !== 0) return null;
  savedWorkspace(id);
  return sharingController().save(env, { folders, terminal: input?.terminal === true, computer: input?.computer === true }, info);
}));

// Decided from the verified Cloud sign-in alone: the renderer names no server, account or origin.
async function lendingSnapshot() {
  const env = cloudLendingEnvironment();
  const connection = await cuaReady.catch(() => null);
  return { available: Boolean(env), screenAvailable: Boolean(connection?.mcpCommand), ...(env ? { state: sharingController().cloudState(env), activity: sharingController().activity(env.id, 30) } : {}) };
}
installCloudLending({ ipcMain, localOnly: localWorkspaceOnly, snapshot: lendingSnapshot, environment: cloudLendingEnvironment, save: (env, choice) => sharingController().saveCloud(env, choice), stop: () => { sharingController(); stopLending(); },
  cloudPage: (channel, handler) => (event, ...args) => { if (!cloudPageAsking(event)) throw new Error(`${channel} is only available in this app's window`); return handler(event, ...args); },
  chooseFolder: async () => { const picked = await dialog.showOpenDialog(mainWindow, { title: "Choose a folder My Cloud can use", properties: ["openDirectory"] }); return picked.canceled || !picked.filePaths[0] ? null : (await validateSharedFolders([{ id: randomUUID(), path: picked.filePaths[0], write: false }]))[0]; },
  defaults: () => usualFolders(DEFAULT_FOLDERS.map(name => app.getPath(name)), validateSharedFolders), validate: validateSharedFolders,
  confirm: async grant => (await dialog.showMessageBox(mainWindow, { type: "question", message: "Let My Cloud use this computer?", detail: grantSentence(grant), buttons: ["Let My Cloud use it", "Cancel"], defaultId: 0, cancelId: 1 })).response === 0 });
const cloudSync = installCloudFiles({
  app, ipcMain, dialog, shell, powerMonitor, localWorkspaceOnly, localDataDir: desktopDataDir(),
  fetch: (...args) => session.defaultSession.fetch(...args),
  send: (channel, value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value); },
  cloudOrigin: () => myCloud(), cloudAccount: () => ensureCloudAccount(), stateDir: cloudTarget(process.env).sync, power: cloudPower,
});

// window.confirm() has no parent window, so (tiling) window managers cannot center it over the app.
ipcMain.handle("dialog:confirm", localWorkspaceOnly("dialog:confirm", async (_event, message) => {
  if (typeof message !== "string" || !message.trim() || message.length > 4096 || !mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message,
    buttons: ["OK", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}));

ipcMain.handle("environments:state", localWorkspaceOnly("environments:state", (event) => ({
  localOrigin: rendererOrigin(),
  remote: !senderIsLocal(event),
  packaged: app.isPackaged,
  activeId: environmentsState.activeId,
  environments: environmentsState.environments,
})));
ipcMain.handle("environments:switch", localWorkspaceOnly("environments:switch", (_event, id) => switchEnvironment(typeof id === "string" ? id : LOCAL_ID)));
ipcMain.handle("environments:create", localWorkspaceOnly("environments:create", (_event, name, dataDir) => createLocalEnvironment(
  typeof name === "string" ? name : "",
  typeof dataDir === "string" ? dataDir : undefined,
)));
ipcMain.handle("environments:pick-dir", localWorkspaceOnly("environments:pick-dir", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  const chosen = canceled ? null : filePaths[0];
  return chosen ? { ok: true, path: chosen } : { ok: false };
}));
ipcMain.handle("environments:add-from-link", localWorkspaceOnly("environments:add-from-link", (_event, link, name) => {
  return connectHostedWorkspace(link, typeof name === "string" ? name : undefined);
}));
ipcMain.handle("environments:forget", localWorkspaceOnly("environments:forget", (_event, id, purge) => forgetEnvironment(typeof id === "string" ? id : "", purge === true)));

// A cloud page may open the native chooser, never choose a destination or edit the saved list.
ipcMain.handle("workspaces:state", workspaceOnly(() => workspaceSummary(environmentsState)));
let workspaceMenuOpen = false;
ipcMain.handle("workspaces:menu", workspaceOnly(async (_event, from) => {
  if (workspaceMenuOpen) return;
  workspaceMenuOpen = true;
  try {
    await cloudOffersReady();
    const menu = Menu.buildFromTemplate(workspaceMenuTemplate(environmentsState, {
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
      ...cloudMenuOptions(from === "howto" ? "app_howto" : "app_menu"),
      ...(await placesMenuOptions({ cloud: cloudHomeEntry(), activeId: environmentsState.activeId, platform: process.platform, port: SERVER_PORT, send: cloudLogins.menu() })), ...oneWorkspace.menu(cloudHomeEntry()),
    }));
    await new Promise((resolve) => menu.popup({ window: mainWindow, callback: resolve }));
  } finally {
    workspaceMenuOpen = false;
  }
}));

ipcMain.handle("desktop:capabilities", async (event) =>
  desktopCapabilities({
    remote: !senderIsLocal(event),
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  }),
);

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
    if (app.isPackaged && !serverReady) throw new Error("The embedded bot server is unavailable");
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
    if (!response.ok) throw credentialSaveError(response.status, body);
    return body;
  };
  if (!app.isPackaged) return applyToHarness();

  // Commit the encrypted value before the server makes it live; a failed reload rolls credentials.bin back.
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
  // A separately launched dev server is outside this trust path: never degrade this grant to loopback HTTP.
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
  await evictStartupCacheOnce({
    userData: app.getPath("userData"),
    currentVersion: app.getVersion(),
    clearCache: () => session.defaultSession.clearCache(),
    log: slog,
  });
  if (process.platform === "win32") {
    try {
      desktopTray = createSystemTray({
        Tray, Menu, nativeImage, iconPath: APP_ICON,
        getWindow: () => startupScreen?.window ?? mainWindow,
        onQuit: () => app.quit(),
      });
    } catch (error) {
      slog(`system tray unavailable: ${error?.message ?? error}`);
    }
  }
  startupScreen = createStartupScreen({
    BrowserWindow, iconPath: APP_ICON, isQuitting: () => desktopShutdownStarted,
    onQuit: () => app.quit(),
    onHide: desktopTray ? (win) => desktopTray.hide(win) : undefined,
    isHidden: () => desktopTray?.isHidden() ?? false,
    onShow: (win) => desktopTray?.windowShown(win),
    onFinished: () => { startupScreen = null; },
  });
  await startupScreen.ready;
  if (desktopShutdownStarted) return;
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(collisionFreeDownloadPath(app.getPath("downloads"), item.getFilename()));
    revealDownloadWhenDone(item, (filePath) => shell.showItemInFolder(filePath));
  });
  // Registry before lease: the lease and the child's OMB_DATA_DIR both follow a named environment.
  environmentsState = readEnvironments();
  let bootDataDir = desktopDataDir();
  if (app.isPackaged) {
    const boot = bootEnvironmentDir(environmentsState, desktopDataDir());
    if (boot.fellBack) {
      slog(`boot environment ${boot.missingDir} is missing; falling back to the default data dir`);
      persistEnvironments({ ...environmentsState, activeId: LOCAL_ID });
      dialog.showErrorBox(
        "The environment's folder is missing",
        `${boot.missingDir} is not there anymore, so OpenMausBot came up on this computer's default data folder instead. Restore or remount that folder, then choose the environment again from the Server menu.`,
      );
    }
    bootDataDir = boot.dataDir;
  }
  if (app.isPackaged) {
    try {
      // Acquire before either plaintext credential migration touches config.json.
      desktopDataDirLease = acquireDataDirLease(bootDataDir, {
        legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
      });
      runningDataDir = bootDataDir;
    } catch (error) {
      dialog.showErrorBox(
        "OpenMausBot could not start safely",
        error?.message ?? "Another process is using this OpenMausBot data folder.",
      );
      app.quit();
      return;
    }
  }
  installServerSessions({ app, defaultSession: session.defaultSession, serverPort: () => SERVER_PORT,
    ownerToken: () => (app.isPackaged && serverReady ? desktopMutationToken : null) });
  if (app.isPackaged) app.setAsDefaultProtocolClient("openmausbot");
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  secureCredentials = await loadSecureCredentials();
  // An orphaned third-party key with no clear handler left: drop it rather than keep it at rest.
  if (secureCredentials && Object.hasOwn(secureCredentials, "assemblyAiApiKey") && !credentialStoreUnavailable) {
    try {
      const { assemblyAiApiKey: _removed, ...rest } = secureCredentials;
      await saveSecureCredentials(rest);
      secureCredentials = rest;
    } catch (error) {
      slog(`orphaned AssemblyAI key not removed: ${error?.message ?? error}`);
    }
  }
  if (app.isPackaged) {
    await secureComposioConfig();
    await secureWorkspaceConfig();
  }
  // From here on every credential writer must go through this serialized state.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
  });
  secureCredentials = secureCredentialState.read();
  if (app.isPackaged) await ensurePhoneSecretIdentity();
  desktopRemoteAccess = desktopCompanionAccess(secureCredentials);
  const hostedAccount = desktopRemoteAccess ? null : ensureCompanionAccountService();
  // Display capture needs a one-shot renderer intent from the same frame/origin, no audio, and a user gesture.
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
  registerUpdaterIpc({ pageAllowed: updaterPageAllowed });
  registerDesktopPrefs({ ipcMain, ...jsonFile(path.join(app.getPath("userData"), "desktop-prefs.json")), localConfig: jsonFile(path.join(desktopDataDir(), "config.json")).read, cloudOffered: () => cloudAccountRestored().then(cloudOffersReady),
    page: event => senderIsLocal(event) ? "local" : cloudPageAsking(event) ?? (workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin()) ? "server" : null),
    thisComputer: async landing => { let ok = false; if (serverReady) await workspaceMenuAction(async () => { ok = (await switchEnvironment(LOCAL_ID))?.ok !== false; }); return ok && await navigateMainWindow(`${rendererOrigin()}/${landing}`); } });
  // Before the window, so the harness has the CUA descriptor on first render.
  cuaReady =
    !desktopRemoteAccess && (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32")
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
    const booted = await startServerPackaged();
    if (!booted && !desktopShutdownStarted && bootDataDir !== desktopDataDir()) {
      slog(`boot environment ${bootDataDir} did not start; falling back to the default data dir`);
      persistEnvironments({ ...environmentsState, activeId: LOCAL_ID });
      try {
        desktopDataDirLease?.release();
      } catch (error) {
        slog(`boot fallback lease release failed: ${error?.message ?? error}`);
      }
      desktopDataDirLease = null;
      try {
        desktopDataDirLease = acquireDataDirLease(desktopDataDir(), {
          legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
        });
        runningDataDir = desktopDataDir();
      } catch (error) {
        dialog.showErrorBox(
          "OpenMausBot could not start safely",
          error?.message ?? "Another process is using this OpenMausBot data folder.",
        );
        app.quit();
        return;
      }
      const retried = await startServerPackaged();
      if (retried) {
        dialog.showErrorBox(
          "The environment was unhealthy",
          `OpenMausBot could not start on ${bootDataDir} and came up on this computer's default data folder instead. Choose that environment again from the Server menu once it is available.`,
        );
      } else {
        dialog.showErrorBox(
          "OpenMausBot could not start",
          `OpenMausBot could not start on ${bootDataDir} or on this computer's default data folder. Check that both folders are readable, then start the app again.`,
        );
        app.quit();
      }
    }
  }
  if (desktopShutdownStarted) return;
  if (app.isPackaged && !desktopRemoteAccess) void ensureManagedDesktop().start().then(() => companyBackupSchedule.start()).catch(() => {});
  // Fresh local use never makes a Cloud request; start only restores an existing grant.
  if (app.isPackaged && !desktopRemoteAccess) {
    cloudAccountRestoring = true;
    cloudAccountStarted = ensureCloudAccount().start().catch(() => {}).finally(() => { cloudAccountRestoring = false; });
  }
  void cloudAccountStarted.then(() => { cloudSignInRestored = true; });
  if (!desktopRemoteAccess && serverReady && companionEnabledAtRest()) {
    // Wait until a saved organisation policy is known: it may turn remote access off.
    void (managedDesktop?.whenRestored() ?? Promise.resolve())
      .then(() => startDesktopCompanion({ waitForHosted: false, remember: false }))
      .catch(error => slog(`companion auto-start skipped: ${error?.message ?? error}`));
  }
  setLocalOrigin(rendererOrigin());
  appPermissions = appPermissionHandlers({
    rendererOrigin,
    mainContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    cloudHomeOrigin: myCloud,
    cloudHomeRestoring: () => cloudAccountRestoring ? cloudAccountRestored() : null,
    activeRemoteOrigin: () => activeEnvironment(environmentsState)?.origin ?? null,
    activeRemoteMicrophone: () => activeEnvironment(environmentsState)?.microphone === true,
    askRemoteMicrophone,
  });
  session.defaultSession.setPermissionRequestHandler(appPermissions.request);
  session.defaultSession.setPermissionCheckHandler(appPermissions.check);
  // Maintainer grants never start while computer sharing is off; Cloud lending waits for a verified sign-in.
  void refreshSharedComputersAllowed().then((allowed) => {
    sharingController().start({ maintainer: allowed });
    cloudSync.start();
    void cloudAccountStarted.then(() => computerSharing?.cloudChanged());
  });
  let restoredOrganizationEntry = false;
  await workspaceMenuAction(async () => { restoredOrganizationEntry = await organizationEntry.restore(); });
  organizationEntryReady = true;
  // A cold-start action owns its first navigation; a default load started first would be aborted by it.
  const deliveredOrganizationEntry = await deliverOrganizationEntry();
  const deliveredCloudEntry = await cloudEntry.ready();
  if (!restoredOrganizationEntry && !deliveredOrganizationEntry && !deliveredCloudEntry && (!mainWindow || mainWindow.isDestroyed())) createWindow();
  // Reconcile incomplete setup and resume interrupted sign-out only once the local app is usable.
  if (hostedAccount) void hostedAccount.restore().catch(() => {});
  // Registering from an unreadable store would mint a second installation identity.
  if (credentialStoreUnavailable) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (!desktopRemoteAccess && app.isPackaged && composioBrokerUrl() && !credentialStoreUnavailable) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials);
  }
  startUpdater();
  refreshApplicationMenu();
  openWindowForLink = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  };
  app.on("activate", () => {
    if (desktopTray?.show()) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).finally(() => allWindowsClosedQuit.settleStartup());

const allWindowsClosedQuit = createAllWindowsClosedQuit({
  app,
  allWindows: () => BrowserWindow.getAllWindows(),
});

// The embedded CUA daemon's async cleanup cannot run after the host exits, so the first quit waits for it (capped).
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
let signalQuitRequested = false;

// Linux package managers and watchdogs stop apps with SIGTERM/SIGINT: the first becomes a normal quit,
// a second keeps Node's default force-quit (`once` listeners).
const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

app.on("before-quit", (e) => {
  desktopShutdownStarted = true;
  startupScreen?.dispose();
  companyBackupSchedule?.close();
  orgLibrary?.close();
  managedDesktop?.close();
  cloudAccount?.close();
  void cloudMove?.close();
  companyBackupController?.abort();
  computerSharing?.close();
  cloudSync.close();
  lendingTray?.destroy();
  if (cuaCleanedUp) return;
  e.preventDefault();
  // Cancel a scheduled recovery before yielding.
  const stoppingServer = serverSupervisor.shutdown();
  syncCompanionKeepAwake(false, false);
  routineWake.stop();
  try {
    desktopCompanionRelay?.close?.();
  } catch {}
  if (nativeActions.appleSpeech) stopSpeech();
  const ownedHelperCleanup = Promise.race([
    Promise.all([
      stopCua().catch(() => {}),
      stopDesktopCompanion({ remember: false }).catch(() => {}),
    ]),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  const cleanup = Promise.all([
    ownedHelperCleanup,
    stoppingServer.then((stopped) => {
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
    // Never print the private child capability.
    slog(`data-directory lease release failed: ${error?.message ?? error}`);
  }
}

// before-quit is too early (this app defers it); will-quit is Electron's last boundary, and the process hook covers app.exit().
app.on("will-quit", releaseDesktopDataDirLease);
app.on("will-quit", () => desktopTray?.destroy());
process.once("exit", releaseDesktopDataDirLease);
