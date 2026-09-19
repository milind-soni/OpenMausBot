// Extracted from electron/main.mjs: the environments subsystem — this
// computer's server or a paired remote one: environments.json persistence
// and switching, hosted-workspace connect/forget, the workspace menu, the
// computer-sharing opt-in, and the renderer origin every local page trusts.
// Owns the environmentsState/computerSharing live bindings; main.mjs imports
// them read-only and mutates only through setEnvironmentsState — the
// server-runtime.mjs accessor pattern. The main-owned lets this region reads
// (desktopRemoteAccess, the launch-time desktopMutationToken, cuaReady) stay
// in main.mjs and cross the boundary as wiring-time getters.
import { app, clipboard, dialog, Menu, session } from "electron";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { buildApplicationMenu } from "../menu.mjs";
import { createComputerSharing } from "../computer-sharing.mjs";
import { pasteMenuItem } from "../paste-menu-item.mjs";
import environmentsModule from "../environments.cjs";
import localOriginModule from "../local-origin.cjs";
import { slog } from "./crash-log.mjs";
import { desktopDataDir } from "./secure-config.mjs";
import { SERVER_PORT } from "./server-runtime.mjs";
import { getMainWindow } from "./main-window.mjs";

const require = createRequire(import.meta.url);
const { desktopServerHeaders } = require("../desktop-server-auth.cjs");
const { isLocalSender: senderIsLocal } = localOriginModule;

// Zero-arg live reads into main.mjs's module state; wired once by main.mjs at
// module load. The defaults mirror main.mjs's initial values and would only
// ever apply if a call somehow preceded the wiring.
const deps = {
  desktopRemoteAccess: () => null,
  desktopMutationToken: () => null,
  cuaReady: () => Promise.resolve({ mode: "unavailable", reason: "not-started" }),
};

export function wireEnvironmentsDeps(reads) {
  Object.assign(deps, reads);
}

// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
export const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";

export function rendererOrigin() {
  return new URL(app.isPackaged || deps.desktopRemoteAccess() ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

// ── environments: this computer's server, or a paired remote one ──────
// The app switches by loading the chosen server's own UI (electron/menu.mjs).
// Only {id, name, origin} is stored here; the session credential is the
// HttpOnly cookie /pair set for that origin, kept by Chromium's cookie jar.
const { LOCAL_ID, activeEnvironment, allowedOrigins, parseEnvironments, parseHostedWorkspaceLink, serializeEnvironments, withActive, withEnvironment, withoutEnvironment, workspaceMenuTemplate, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceSummary } = environmentsModule;
export let environmentsState = { environments: [], activeId: LOCAL_ID };
export let computerSharing;
const sharingPrompts = new Set();

// Opt-in computer sharing is gated by the server this desktop runs, the same
// way every other server setting reaches this process: the booleans-only
// /api/config status (server/index.ts configStatus → features). It is read
// before the connector could start and again whenever a workspace control is
// used, so a maintainer who edits config.json and restarts the server does not
// have to reinstall the app. Unreachable or older server → off.
let sharedComputersAllowed = false;

export async function refreshSharedComputersAllowed() {
  sharedComputersAllowed = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, { signal: AbortSignal.timeout(3_000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((status) => status?.features?.sharedComputers === true)
    .catch(() => false);
  return sharedComputersAllowed;
}

/** Refuse a workspace sharing control the server would refuse anyway. */
export async function requireSharedComputers() {
  if (await refreshSharedComputersAllowed()) return;
  throw new Error("Computer sharing is turned off on this server.");
}

export function sharingController() {
  computerSharing ??= createComputerSharing({
    file: path.join(app.getPath("userData"), "computer-sharing.json"),
    // The harness server's data directory holds provider API keys and
    // sessions.json, so a broad share must never reach it either.
    protectedPaths: [desktopDataDir()],
    fetch: (...args) => session.defaultSession.fetch(...args),
    environments: () => environmentsState.environments,
    enabled: refreshSharedComputersAllowed,
    cuaConnection: () => deps.cuaReady(),
    hostControl: async (id, signal) => {
      const lease = async action => {
        const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/desktop/shared-computer-control`, {
          method: "POST",
          headers: desktopServerHeaders({ "content-type": "application/json" }, { packaged: app.isPackaged, token: deps.desktopMutationToken() }),
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

export async function offerComputerSharing(win) {
  const env = activeEnvironment(environmentsState);
  if (!env || sharingPrompts.has(env.id) || win.isDestroyed()) return;
  // Never offer a grant this build's server will not honour.
  if (!(await refreshSharedComputersAllowed()) || win.isDestroyed()) return;
  sharingPrompts.add(env.id);
  try {
    const info = await sharingController().observe(env);
    if (!info || win.isDestroyed() || activeEnvironment(environmentsState)?.id !== env.id || new URL(win.webContents.getURL()).origin !== env.origin) return;
    const choice = await dialog.showMessageBox(win, {
      type: "question", message: `Share this computer with ${env.name}?`,
      detail: "Let this workspace’s bots use folders and capabilities you choose while this desktop app is running. Nothing is shared unless you enable it. You can change this later in Settings → Connected workspaces.",
      buttons: ["Choose access", "Not now"], defaultId: 1, cancelId: 1,
    });
    sharingController().decline(env, info);
    if (choice.response === 0) openWorkspaceSettings(env.id);
  } catch { /* Not paired yet, an older server, or offline: no grant, no prompt. */ }
  finally { sharingPrompts.delete(env.id); }
}

function environmentsFile() {
  return path.join(app.getPath("userData"), "environments.json");
}

export function readEnvironments() {
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
    throw new Error("Could not save workspace connections on this computer. Please try again.");
  }
}

/** Where the main window should be: the active remote server, else Local. */
function activeOrigin() {
  return activeEnvironment(environmentsState)?.origin ?? rendererOrigin();
}


export function refreshApplicationMenu() {
  Menu.setApplicationMenu(
    buildApplicationMenu({
      environments: environmentsState.environments,
      activeId: environmentsState.activeId,
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onAddFromClipboard: () => void addServerFromClipboard(),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
      onOpenSettings: () => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send("app:open-settings");
      },
    }),
  );
}

function persistEnvironments(next) {
  writeEnvironments(next);
  environmentsState = next;
  refreshApplicationMenu();
}


/** main.mjs assigns its startup read of environments.json through this setter. */
export function setEnvironmentsState(next) {
  environmentsState = next;
}
export async function workspaceMenuAction(action) {
  try { await action(); } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not update workspaces", detail: error.message });
  }
}

function navigateMainWindow(url) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  // did-fail-load shows the connection error and returns to the local app.
  void win.loadURL(url).catch(() => {});
}

export function switchEnvironment(id) {
  if (id === environmentsState.activeId || (id !== LOCAL_ID && !environmentsState.environments.some((entry) => entry.id === id))) return;
  persistEnvironments(withActive(environmentsState, id));
  navigateMainWindow(activeOrigin());
}

export function openWorkspaceSettings(computerId) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (senderIsLocal({ sender: win.webContents })) {
    win.webContents.send("workspaces:open-settings", typeof computerId === "string" ? computerId : null);
  } else {
    persistEnvironments(withActive(environmentsState, LOCAL_ID));
    navigateMainWindow(`${rendererOrigin()}/?desktop-settings=workspaces${typeof computerId === "string" ? `&share-computer=${encodeURIComponent(computerId)}` : ""}`);
  }
}

async function addServerFromClipboard() {
  try {
    return await connectHostedWorkspace(clipboard.readText());
  } catch (error) {
    await dialog.showMessageBox({ type: "info", message: "Could not connect workspace", detail: `${error.message}\nYou can also choose Connect hosted workspace to enter an address in Settings.` });
    return false;
  }
}

export async function connectHostedWorkspace(input, name) {
  const link = parseHostedWorkspaceLink(input);
  if (!link) {
    throw new Error("Enter an HTTPS workspace address or a full pairing link. Keep the pairing code after #, not in the URL query.");
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

export async function forgetEnvironment(id) {
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
  sharingController().forget(env);
  const wasActive = environmentsState.activeId === id;
  persistEnvironments(withoutEnvironment(environmentsState, id));
  // Leave a removed workspace immediately; forgetting an inactive connection
  // must not reload the local app or discard a Settings form/chat draft.
  if (wasActive) navigateMainWindow(activeOrigin());
  try {
    // Revoke the session on the server while the cookie is still here.
    const response = await session.defaultSession.fetch(`${env.origin}/api/auth/logout`, { method: "POST", credentials: "include", headers: { origin: env.origin }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    slog(`forget server: logout skipped (${error?.message ?? error})`);
    await dialog.showMessageBox({ type: "warning", message: "Connection forgotten; server sign-out could not be confirmed", detail: "Computer sharing is stopped. Revoke this desktop’s session on that server when it is reachable again." });
  }
  try {
    // Logout clears this server's exact cookie. Cookie storage is host-wide,
    // not port-scoped: clearing it here would sign out other saved workspaces.
    await session.defaultSession.clearStorageData({ origin: env.origin, storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  } catch (error) {
    slog(`forget server: storage clear failed: ${error?.message ?? error}`);
  }
}

/**
 * Displays the native context menu for editable fields, links, and selections,
 * enabling paste if text or a clipboard image is available.
 *
 * @param {Electron.BrowserWindow} win - Target browser window.
 * @param {Electron.ContextMenuParams} params - Context menu parameters from Electron.
 * @returns {void}
 */
export function showContextMenu(win, params) {
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

export { LOCAL_ID, activeEnvironment, allowedOrigins, workspaceMenuTemplate, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceSummary };
