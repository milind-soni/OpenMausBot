// Extracted from electron/main.mjs: the unread badge and package-install
// subsystem, verbatim — the dock/overlay badge state, the deep-link package
// install queue and its delivery into the local page, the WeakSet of windows
// left on the server-unavailable error page, and the desktop:unread-count
// IPC registration (a feature registration, not an app lifecycle hook — the
// company-backup.mjs precedent). This module owns the
// pendingPackageInstallUrl/unreadCount/unreadOverlayIcon live bindings;
// main.mjs keeps the open-url and second-instance lifecycle hooks and
// reassigns pendingPackageInstallUrl only through setPendingPackageInstallUrl
// at the exact former assignment point — the server-runtime.mjs accessor
// pattern. serverUnavailableWindows is a const WeakSet and crosses as-is.

import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { createRequire } from "node:module";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "../package-link.mjs";
import { activateExistingWindow } from "../single-instance.mjs";
import { APP_ICON } from "./desktop-viewer.mjs";
import { mainWindow } from "./main-window.mjs";
import {
  LOCAL_ID,
  activeEnvironment,
  environmentsState,
  rendererOrigin,
  switchEnvironment,
  workspaceMenuAction,
} from "./environments.mjs";

const require = createRequire(import.meta.url);
const { normalizeUnreadCount } = require("../window-state.cjs");

let pendingPackageInstallUrl = packageUrlFromCommandLine(process.argv);
const serverUnavailableWindows = new WeakSet();
let unreadCount = 0;
let unreadOverlayIcon = null;

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
    if (activeEnvironment(environmentsState)) void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
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

ipcMain.on("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

// This module owns the pendingPackageInstallUrl live binding; main.mjs
// reassigns it only through this setter, at the exact former assignment
// point inside its second-instance lifecycle hook.
export function setPendingPackageInstallUrl(url) {
  pendingPackageInstallUrl = url;
}

export {
  applyUnreadBadge,
  deliverPackageInstall,
  queuePackageInstall,
  serverUnavailableWindows,
};
