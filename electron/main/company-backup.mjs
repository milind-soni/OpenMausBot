// Extracted from electron/main.mjs: the company-backup and organisation
// sign-in subsystem, verbatim — the managed desktop client, its private
// relay to the server child, the daily backup schedule, the backup and
// restore transfer paths, the desktop mutation-token sync, and every
// organisation:* and company-backups:* IPC registration, together with the
// workspaceOnly and localWorkspaceOnly wrappers those channels introduced
// (main.mjs keeps the sharing/environments/workspaces channels that reuse
// the wrappers and imports them back). The source-slice test
// electron/company-backup-main.node-test.mjs reads THIS file now: it
// executes the function family and the registration block below inside a
// VM fixture, so those two regions must stay valid plain script — no
// import/export syntax inside them, and their bare free names (mainWindow,
// environmentsState, serverProc, desktopRemoteAccess, …) must keep
// resolving, as imports or as the module-scope bindings declared here.
// What stayed in main.mjs: the app lifecycle and startup ordering, the
// before-quit teardown, every non-family IPC registration, and the
// trustedApprovalMode coordinator. This module owns the live bindings the
// pinned regions read as bare names — including desktopRemoteAccess and
// desktopShutdownStarted, which main.mjs reassigns only through the
// exported setters at the exact former assignment points, and the
// launch-time mutation tokens main.mjs still reads (the server-runtime.mjs
// accessor pattern).

import { app, ipcMain, safeStorage, shell } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCompanyBackups } from "../company-backups.mjs";
import { createCompanyBackupSchedule } from "../company-backup-schedule.mjs";
import { createManagedDesktopClient, createManagedDesktopRelay, createManagedDesktopStore } from "../managed-desktop.mjs";
import { slog } from "./crash-log.mjs";
import { activeEnvironment, environmentsState, rendererOrigin, workspaceSenderAllowed } from "./environments.mjs";
import { localOnly } from "./ipc-guards.mjs";
import { mainWindow } from "./main-window.mjs";
import { desktopDataDir } from "./secure-config.mjs";
import { SERVER_PORT, serverProc, serverReady } from "./server-runtime.mjs";

const require = createRequire(import.meta.url);
const { DESKTOP_MUTATION_HEADER } = require("../desktop-server-auth.cjs");

let managedDesktop = null;
let companyBackupController = null;
let companyBackupState = { busy: false };
let preparedCompanyRestore = null;
let companyBackupSchedule = null;
let companyBackupClientStateRequest = null;
let companyRestoreCommitting = false;
let companyBackupConfigurationRevision = 0;
const managedDesktopRelay = createManagedDesktopRelay();
const desktopMutationToken = randomBytes(32).toString("base64url");
const companionMutationToken = randomBytes(32).toString("base64url");
let desktopRemoteAccess = null;
let desktopShutdownStarted = false;

function ensureManagedDesktop() {
  if (managedDesktop) return managedDesktop;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Organisation sign-in requires the installed desktop app running on this computer.");
  const store = createManagedDesktopStore({
    file: path.join(app.getPath("userData"), "company-connection.bin"),
    encryption: {
      available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: value => safeStorage.decryptStringAsync(value),
    },
  });
  managedDesktop = createManagedDesktopClient({
    store, platform: process.platform, deviceName: os.hostname().slice(0, 100) || "My computer",
    applyConnection: connection => managedDesktopRelay.send(serverProc, connection),
    openBrowser: url => shell.openExternal(url),
    onState: state => {
      if (["signed-out", "reauth-required"].includes(state.status) || (state.status === "connected" && !state.cloudBackups)) {
        companyBackupConfigurationRevision++;
        companyBackupController?.abort();
        preparedCompanyRestore = null;
        void companyBackupSchedule?.forget().catch(() => {});
        publishCompanyBackupState({ busy: Boolean(companyBackupController) });
      }
      companyBackupSchedule?.reconcile();
      // Remote pages never receive local identity events, even if they were
      // loaded in this window after an earlier local subscription.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
          !activeEnvironment(environmentsState) && !desktopRemoteAccess) {
        mainWindow.webContents.send("organization:state-changed", state);
      }
    },
  });
  companyBackupSchedule = createCompanyBackupSchedule({
    store: createManagedDesktopStore({
      file: path.join(app.getPath("userData"), "company-backup-schedule.bin"),
      encryption: {
        available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
          (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
        encrypt: value => safeStorage.encryptStringAsync(value),
        decrypt: value => safeStorage.decryptStringAsync(value),
      },
    }),
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
  return { key: JSON.stringify([connection.portalOrigin, connection.organizationId, connection.email, connection.deviceId, path.resolve(desktopDataDir())]),
    generation: client.backupGeneration() };
}

function companyBackupDeferred() {
  return Object.assign(new Error("Wait for the local workspace to be available for its daily backup."), { code: "workspace_busy" });
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
  if (mainWindow && !mainWindow.isDestroyed() && !activeEnvironment(environmentsState) && !desktopRemoteAccess &&
      mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) mainWindow.webContents.send("company-backups:state-changed", companyBackupState);
}

function localBackupRequest(proc, route, init = {}) {
  if (!proc || proc !== serverProc || !serverReady || !/^\/api\/workspace-backup\/(?:status|export|upload|preview|restore|download\/[A-Za-z0-9_-]+)$/.test(route)) {
    throw new Error("The local workspace changed. Start this backup operation again.");
  }
  return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
    headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
}

async function localBackupStatus(proc) {
  const response = await localBackupRequest(proc, "/api/workspace-backup/status", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Local backup status is unavailable. Try again when the workspace is ready.");
  const status = await response.json();
  if (proc !== serverProc || typeof status.busy !== "boolean" || typeof status.pendingRestore !== "boolean") throw new Error("The workspace changed. Check backup status again.");
  return status;
}

async function runCompanyBackup(kind, input, scheduled = null) {
  if (companyBackupController || companyRestoreCommitting || desktopShutdownStarted || (scheduled && preparedCompanyRestore)) throw companyBackupDeferred();
  const client = ensureManagedDesktop(), connection = client.connection();
  if (!connection || !client.state().cloudBackups) throw new Error("Connect your organisation and ask its administrator to enable cloud backups first.");
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
    if (proc !== serverProc || client.backupGeneration() !== generation || client.connection()?.deviceId !== connection.deviceId) throw new Error("The workspace connection changed.");
    if (kind === "restore") preparedCompanyRestore = { id: result.id, proc, deviceId: connection.deviceId };
    publishCompanyBackupState({ busy: false, ...(kind === "backup" ? { lastBackupAt: Date.now() } : {}) });
    return result;
  } catch (error) {
    const message = controller.signal.aborted ? "Cloud backup cancelled. Your workspace has not been replaced."
      : error?.name === "CompanyBackupError" ? error.message : "Cloud backup could not complete. Check your organisation connection and available disk space, then try again.";
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

const workspaceOnly = (handler) => (event, ...args) => {
  if (!workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin())) throw new Error("Workspace controls are only available in the main desktop window");
  return handler(event, ...args);
};
const localWorkspaceOnly = (channel, handler) => localOnly(channel, workspaceOnly(handler));
ipcMain.handle("organization:state", localWorkspaceOnly("organization:state", () => ensureManagedDesktop().state()));
ipcMain.handle("organization:begin", localWorkspaceOnly("organization:begin", (_event, input) => ensureManagedDesktop().begin(input)));
ipcMain.handle("organization:cancel", localWorkspaceOnly("organization:cancel", () => ensureManagedDesktop().cancelEnrollment()));
ipcMain.handle("organization:refresh", localWorkspaceOnly("organization:refresh", () => ensureManagedDesktop().refresh()));
ipcMain.handle("organization:disconnect", localWorkspaceOnly("organization:disconnect", () => {
  companyBackupConfigurationRevision++;
  companyBackupController?.abort(); preparedCompanyRestore = null;
  const client = ensureManagedDesktop();
  // The schedule reports its own failure to forget the stored secret; a file
  // error there must not present a completed disconnect as failed.
  return Promise.allSettled([companyBackupSchedule.forget(), client.disconnect()]).then(([, disconnect]) => {
    if (disconnect.status === "rejected") throw disconnect.reason;
    return disconnect.value;
  });
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
  // Consume the preview before yielding; duplicate IPC cannot commit it twice.
  // On an uncertain response the existing local backup status is authoritative.
  preparedCompanyRestore = null;
  companyRestoreCommitting = true;
  try {
    const response = await localBackupRequest(serverProc, "/api/workspace-backup/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: input.id, confirmation: "REPLACE" }) });
    if (!response.ok) throw new Error("The workspace could not be replaced. Check local backup status before trying again.");
    publishCompanyBackupState({ busy: false, pendingRestore: true });
    return await response.json();
  } finally { companyRestoreCommitting = false; }
}));

// This module owns the desktopRemoteAccess and desktopShutdownStarted live
// bindings above; main.mjs imports them read-only and reassigns them only
// through these setters, at the exact points where it used to assign the
// locals directly — the server-runtime.mjs accessor pattern.
export function setDesktopRemoteAccess(access) {
  desktopRemoteAccess = access;
}

export function setDesktopShutdownStarted(started) {
  desktopShutdownStarted = started;
}

export {
  companyBackupController,
  companyBackupSchedule,
  desktopMutationToken,
  desktopRemoteAccess,
  desktopShutdownStarted,
  ensureManagedDesktop,
  localWorkspaceOnly,
  managedDesktop,
  managedDesktopRelay,
  syncDesktopMutationToken,
  workspaceOnly,
};
