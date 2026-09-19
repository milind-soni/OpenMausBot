import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, safeStorage, screen, session } from "electron";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { installDesktopCrashListeners } from "./diagnostics.mjs";
import { activateExistingWindow, releaseSingleInstanceLock } from "./single-instance.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { packageUrlFromCommandLine } from "./package-link.mjs";
import { collisionFreeDownloadPath } from "./save-file.mjs";
import { appPermissionAllowed } from "./app-permissions.mjs";
import { ensureManagedComposioCredentials } from "./managed-composio.mjs";
import {
  desktopCompanionAccess,
  pairDesktopCompanion,
  startDesktopCompanionRelay,
  withDesktopCompanionAccess,
  withoutDesktopCompanionAccess,
} from "./desktop-companion-client.mjs";
import capabilitiesModule from "./capabilities.cjs";
import localOriginModule from "./local-origin.cjs";
import { validateSharedFolders } from "./computer-sharing.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import {
  LOG_DIR,
  recordDesktopCrash,
  slog,
} from "./main/crash-log.mjs";
import {
  composioBrokerUrl,
  credentialStoreUnavailable,
  desktopDataDir,
  initializeSecureCredentialStore,
  secureCredentials,
  updateSecureCredentialDocument,
} from "./main/secure-config.mjs";
import {
  SERVER_PORT,
  serverProc,
  serverReady,
  stopUtilityServer,
  setServerPort,
  setServerReady,
  adoptUtilityServer,
  markServerUnavailable,
} from "./main/server-runtime.mjs";
import { APP_ICON } from "./main/desktop-viewer.mjs";
import {
  decorateDesktopCompanionState,
  desktopCompanionState,
  ensureCompanionAccountService,
  ensurePhoneSecretIdentity,
  installationDisplayName,
  refreshDesktopCompanionTailscale,
  startDesktopCompanion,
  stopDesktopCompanion,
  syncCompanionKeepAwake,
} from "./main/companion-connection.mjs";

export {
  clearManagedCompanionEndpointCredentials,
  reconcileManagedCompanionEndpointProvision,
} from "./main/companion-connection.mjs";

import { mainWindow } from "./main/main-window.mjs";
import { wireDesktopIpc } from "./main/desktop-ipc.mjs";
import { createWindow, wireCreateWindowDeps } from "./main/create-window.mjs";
import {
  LOCAL_ID,
  activeEnvironment,
  computerSharing,
  connectHostedWorkspace,
  environmentsState,
  forgetEnvironment,
  openWorkspaceSettings,
  readEnvironments,
  refreshApplicationMenu,
  refreshSharedComputersAllowed,
  rendererOrigin,
  requireSharedComputers,
  setEnvironmentsState,
  sharingController,
  switchEnvironment,
  workspaceMenuAction,
  workspaceMenuTemplate,
  workspaceSummary,
  wireEnvironmentsDeps,
} from "./main/environments.mjs";
import {
  companyBackupController,
  companyBackupSchedule,
  desktopMutationToken,
  desktopRemoteAccess,
  desktopShutdownStarted,
  ensureManagedDesktop,
  localWorkspaceOnly,
  managedDesktop,
  setDesktopRemoteAccess,
  setDesktopShutdownStarted,
  workspaceOnly,
} from "./main/company-backup.mjs";
import {
  deliverPackageInstall,
  queuePackageInstall,
  serverUnavailableWindows,
  setPendingPackageInstallUrl,
} from "./main/unread-badge.mjs";
import {
  installDesktopMutationHeader,
  startServerOn,
  startServerPackaged,
  syncManagedComposioCredentials,
  wireServerBootDeps,
} from "./main/server-boot.mjs";
import {
  androidDevice,
  bumpDisplayMediaRequestCount,
  cuaReady,
  displayMediaGuard,
  getCuaReady,
  respondToDisplayMediaRequest,
  setCuaReady,
} from "./main/cua-media.mjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { selectCaptureSource } = require("./screen-preview.cjs");
const { createTrustedApprovalModeCoordinator } = require("./approval-trusted-mode.cjs");
const { desktopServerHeaders } = require("./desktop-server-auth.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

app.on("open-url", (event, url) => {
  if (!queuePackageInstall(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) setPendingPackageInstallUrl(packageUrl);
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
});

let desktopDataDirLease = null;
const trustedApprovalMode = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
const serverSupervisor = createServerSupervisor({
  restart: () => startServerOn(SERVER_PORT),
  stop: stopUtilityServer,
  onReady(proc) {
    adoptUtilityServer(proc);
    serverStartConflictOnly = false;
    slog(`server ready pid=${proc.pid} port=${SERVER_PORT}`);
    // Re-read the latest account credentials; registration may have completed
    // while the replacement child's health probe was pending.
    syncManagedComposioCredentials();
    if (managedDesktop) void managedDesktop.refresh().catch(() => {});
    routineWake.start();
    // Existing chat windows reconnect in place, preserving unsent drafts.
    // A window opened during the outage is still on our error page instead.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!serverUnavailableWindows.has(win) || activeEnvironment(environmentsState)) continue;
      void win.loadURL(`http://127.0.0.1:${SERVER_PORT}`).then(() => {
        serverUnavailableWindows.delete(win);
      }).catch((error) => {
        slog(`recovered server window failed to load: ${error?.message ?? error}`);
      });
    }
  },
  onUnavailable() {
    markServerUnavailable();
    companyBackupSchedule?.reconcile();
    // nothing to hold for while the scheduler is down; polling resumes on ready
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

let desktopCompanionRelay = null;
import {
  companionEnabledAtRest,
  companionPairing,
  companionCloudDesktopAccess,
  companionRevoke,
  rememberCompanionKeepAwake,
} from "./companion.mjs";
import { createRoutineWakeHold, rememberRoutineWake, routineWakeSettings } from "./routine-wake.mjs";

/** IPC that controls this computer, its files, its logins or its updater is
 * answered only for the local server's UI (electron/local-origin.cjs). A
 * remote server's page gets a reduced bridge (preload.cjs) in the first
 * place; this is the second wall, shared with cua.mjs, updater.mjs and
 * android-device.mjs. Declared before any handler registration below: a
 * const declared later would be in its temporal dead zone at module load.
 */
const { isLocalSender: senderIsLocal, localOnly, setLocalOrigin } = localOriginModule;

// Keep this computer awake for scheduled routines (electron/routine-wake.mjs):
// the scheduler lives in the local server, which cannot run while the Mac
// sleeps. One power assertion, held for the hour before a due routine and
// while a run is in flight, plugged in only; the server says when.
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

// Set by startServerPackaged: true only when every failing candidate port was
// taken by another process — decides which error-page message renders.
let serverStartConflictOnly = false;

// server-boot.mjs reads these main-owned bindings through wiring-time
// deps: the supervisor, trusted-approval coordinator and data-dir lease are
// created above, saveWorkspaceCredential is the hoisted function further
// down, and serverStartConflictOnly is assigned from both files (the
// supervisor's onReady resets it here; startServerPackaged sets it inside
// server-boot.mjs).
wireServerBootDeps({
  setServerStartConflictOnly: (value) => {
    serverStartConflictOnly = value;
  },
  desktopDataDirLease: () => desktopDataDirLease,
  serverSupervisor: () => serverSupervisor,
  trustedApprovalMode: () => trustedApprovalMode,
  saveWorkspaceCredential,
});

// environments.mjs reads these live bindings through getters — cross-module
// let reads need the accessor boundary server-runtime.mjs established for
// writes. desktopRemoteAccess is reassigned by later regions of this file;
// cuaReady is owned by cua-media.mjs, and the getter keeps the moved code
// live.
wireEnvironmentsDeps({
  desktopRemoteAccess: () => desktopRemoteAccess,
  desktopMutationToken: () => desktopMutationToken,
  cuaReady: () => getCuaReady(),
});

// desktop-ipc.mjs owns the desktop-surface IPC family that used to live
// here — screen preview, engine terminal, folder picking, diagnostics
// export, save-file, skins and caption controls, the desktop viewer and
// workspace panes, macOS permissions and speech. It registers its
// channels at import time (the company-backup.mjs precedent) and takes
// main.mjs's platform dispatch table through the same wiring boundary
// server-boot.mjs uses, because nativeActions is also read by the quit
// path further down.
wireDesktopIpc({ nativeActions });

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
// ── keep awake for routines ────────────────────────────────────────────
// The Automations page shows the hold and owns the toggle; the decision
// itself stays in the main process with the power assertion.
ipcMain.handle("routines:wake-state", localOnly("routines:wake-state", () => routineWake.poll()));
ipcMain.handle("routines:keep-awake", localOnly("routines:keep-awake", async (_event, enabled) => {
  rememberRoutineWake(app.getPath("userData"), Boolean(enabled));
  return routineWake.poll();
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
  setDesktopRemoteAccess(access);
  relaunchAfterDesktopRemoteChange();
  return publicDesktopRemoteState();
}));
ipcMain.handle("desktop-remote:disconnect", localOnly("desktop-remote:disconnect", async (event) => {
  requireMainWindowSender(event);
  await updateSecureCredentialDocument(withoutDesktopCompanionAccess);
  setDesktopRemoteAccess(null);
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

const savedWorkspace = id => {
  const env = environmentsState.environments.find(entry => entry.id === id);
  if (!env) throw new Error("This workspace is no longer connected");
  return env;
};
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
ipcMain.handle("sharing:save", localWorkspaceOnly("sharing:save", async (_event, id, input) => {
  await requireSharedComputers();
  const env = savedWorkspace(id);
  const info = await sharingController().identity(env);
  const folders = await validateSharedFolders(input?.folders);
  const detail = [
    `Workspace: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}`),
    input?.terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    input?.computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    "Shared content is sent to this hosted workspace and may reach its model provider. Bots from this workspace can use these permissions until you revoke them. Closing the desktop stops access.",
  ].join("\n\n");
  const confirmation = await dialog.showMessageBox(mainWindow, { type: "warning", message: `Allow computer access for ${env.name}?`, detail, buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
  if (confirmation.response !== 0) return null;
  savedWorkspace(id);
  return sharingController().save(env, { folders, terminal: input?.terminal === true, computer: input?.computer === true }, info);
}));

ipcMain.handle("environments:state", localWorkspaceOnly("environments:state", (event) => ({
  localOrigin: rendererOrigin(),
  remote: !senderIsLocal(event),
  activeId: environmentsState.activeId,
  environments: environmentsState.environments,
})));
ipcMain.handle("environments:switch", localWorkspaceOnly("environments:switch", (_event, id) => switchEnvironment(typeof id === "string" ? id : LOCAL_ID)));
ipcMain.handle("environments:add-from-link", localWorkspaceOnly("environments:add-from-link", (_event, link, name) => {
  return connectHostedWorkspace(link, typeof name === "string" ? name : undefined);
}));
ipcMain.handle("environments:forget", localWorkspaceOnly("environments:forget", (_event, id) => forgetEnvironment(typeof id === "string" ? id : "")));

// A cloud page can ask for the native chooser, not choose a destination or
// mutate the desktop's saved list. Only native menu clicks perform those acts.
ipcMain.handle("workspaces:state", workspaceOnly(() => workspaceSummary(environmentsState)));
let workspaceMenuOpen = false;
ipcMain.handle("workspaces:menu", workspaceOnly(async () => {
  if (workspaceMenuOpen) return;
  workspaceMenuOpen = true;
  try {
    const menu = Menu.buildFromTemplate(workspaceMenuTemplate(environmentsState, {
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
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

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  fishAudioKey: (value) => ({ tts: { fishKey: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
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
    if (app.isPackaged && !serverReady) throw new Error("The embedded bot server is unavailable");
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
  setCuaReady(Promise.resolve(connection));
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(collisionFreeDownloadPath(app.getPath("downloads"), item.getFilename()));
  });
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
  // Load credentials.bin, migrate plaintext config.json secrets, then arm
  // the shared serialized credential state (electron/main/secure-config.mjs).
  await initializeSecureCredentialStore();
  if (app.isPackaged) await ensurePhoneSecretIdentity();
  setDesktopRemoteAccess(desktopCompanionAccess(secureCredentials));
  const hostedAccount = desktopRemoteAccess ? null : ensureCompanionAccountService();
  // Display capture remains user-initiated. The renderer first sends a
  // short-lived one-shot intent, then calls getDisplayMedia in the same click.
  // The handler binds that request to the same frame/origin, rejects audio,
  // and requires Electron's active user-gesture signal.
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        bumpDisplayMediaRequestCount();
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
  setCuaReady(
    !desktopRemoteAccess && (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32")
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" }),
  );
  if (desktopRemoteAccess) {
    try {
      desktopCompanionRelay = await startDesktopCompanionRelay({
        access: desktopRemoteAccess,
        staticDir: app.isPackaged
          ? path.join(process.resourcesPath, "ui")
          : path.join(app.getAppPath(), "dist"),
      });
      setServerPort(desktopCompanionRelay.port);
      setServerReady(true);
    } catch (error) {
      setServerReady(false);
      slog(`desktop companion relay failed: ${error?.message ?? error}`);
    }
  } else if (app.isPackaged) {
    await startServerPackaged();
  }
  if (desktopShutdownStarted) return;
  if (app.isPackaged && !desktopRemoteAccess) void ensureManagedDesktop().start().then(() => companyBackupSchedule.start()).catch(() => {});
  // The companion the user left on comes back without anyone finding the
  // toggle again — one attempt, after the harness port is settled, with the
  // exact options the IPC handler uses. A failure surfaces in companionState
  // (the panel shows the error) rather than retrying; and it never delays
  // the window.
  if (!desktopRemoteAccess && serverReady && companionEnabledAtRest()) {
    void startDesktopCompanion({ waitForHosted: false, remember: false });
  }
  setLocalOrigin(rendererOrigin());
  // Device permissions (microphone, notifications, clipboard) are for the
  // local UI only; privileged capabilities (camera, geolocation, USB, MIDI,
  // serial) stay off. Client mode's loopback relay is the local UI.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requesting = details?.requestingUrl ?? contents?.getURL?.() ?? "";
    callback(appPermissionAllowed(permission, requesting, rendererOrigin(), details));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const requesting = requestingOrigin || contents?.getURL?.() || "";
    return appPermissionAllowed(permission, requesting, rendererOrigin(), details);
  });
  setEnvironmentsState(readEnvironments());
  // The outbound connector never starts while computer sharing is off: no
  // poll loop, no registration, no grant replay from disk.
  void refreshSharedComputersAllowed().then((allowed) => { if (allowed) sharingController().start(); });
  // create-window.mjs borrows two main-owned bindings through the same
  // wiring boundary server-boot.mjs uses: __dirname anchors preload.cjs
  // next to this file, and serverStartConflictOnly is the conflict flag
  // both main.mjs and server-boot.mjs assign.
  wireCreateWindowDeps({
    __dirname,
    serverStartConflictOnly: () => serverStartConflictOnly,
  });
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
  setDesktopShutdownStarted(true);
  companyBackupSchedule?.close();
  managedDesktop?.close();
  companyBackupController?.abort();
  computerSharing?.close();
  if (cuaCleanedUp) return;
  e.preventDefault();
  // Cancel a scheduled recovery before yielding, and stop the owned child
  // even if it has not passed its boot probe yet.
  const stoppingServer = serverSupervisor.shutdown();
  // Release the sleep blocker synchronously; child shutdown is awaited below.
  syncCompanionKeepAwake(false, false);
  routineWake.stop();
  try {
    desktopCompanionRelay?.close?.();
  } catch {}
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  if (nativeActions.appleSpeech) stopSpeech();
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
