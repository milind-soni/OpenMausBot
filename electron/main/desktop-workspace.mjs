// Extracted from electron/main.mjs: the desktop workspace — the native
// WebContentsView panes a workspace bot's live desktop renders into, plus the
// manager/owner pair that pins them to the main app window. Owns the
// desktopWorkspaceManager/desktopWorkspaceOwner live bindings (assigned only
// here, at the same points as before); the workspace IPC handlers stay in
// main.mjs.
import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getMainWindow } from "./main-window.mjs";

const require = createRequire(import.meta.url);
const { createDesktopWorkspaceManager } = require("../desktop-workspace.cjs");

let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;

export function ensureDesktopWorkspace(owner) {
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

export function desktopWorkspaceForEvent(event, create = false) {
  const owner = getMainWindow();
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The desktop workspace is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The desktop workspace belongs to another app window");
  }
  return create ? ensureDesktopWorkspace(owner) : desktopWorkspaceManager;
}
