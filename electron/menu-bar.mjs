/**
 * Optional menu-bar / system-tray popover. Off until Settings turns it on.
 * The compact renderer is the same app at ?surface=menubar.
 */
import { BrowserWindow, Menu, Tray, nativeImage, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MENU_BAR_POPOVER_HEIGHT,
  MENU_BAR_POPOVER_WIDTH,
  menuBarPopoverBounds,
} from "./menu-bar-geometry.mjs";

const RESOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), "resources");

/** Official Cursor mascot for the tray: template (body + face holes) on
 * macOS so it tints with the menu bar; full-color elsewhere. */
export function loadMenuBarTrayImage() {
  const template = process.platform === "darwin";
  const stem = template ? "menu-bar-mascotTemplate" : "menu-bar-mascot";
  const image = nativeImage.createEmpty();
  const files = [
    [1, `${stem}.png`],
    [2, `${stem}@2x.png`],
  ];
  for (const [scaleFactor, name] of files) {
    const file = path.join(RESOURCES, name);
    if (!fs.existsSync(file)) continue;
    image.addRepresentation({ scaleFactor, buffer: fs.readFileSync(file) });
  }
  if (template) image.setTemplateImage(true);
  return image;
}

export function createMenuBarController({ iconPath, preload, getAppUrl, showMainWindow }) {
  let tray = null;
  let popover = null;
  let enabled = false;

  function destroyPopover() {
    if (!popover || popover.isDestroyed()) {
      popover = null;
      return;
    }
    popover.destroy();
    popover = null;
  }

  function destroyTray() {
    destroyPopover();
    if (!tray) return;
    tray.destroy();
    tray = null;
  }

  function positionPopover() {
    if (!tray || !popover || popover.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = menuBarPopoverBounds({
      tray: tray.getBounds(),
      workArea: display.workArea,
      width: MENU_BAR_POPOVER_WIDTH,
      height: MENU_BAR_POPOVER_HEIGHT,
    });
    popover.setBounds(bounds);
  }

  function hide() {
    if (!popover || popover.isDestroyed()) return;
    popover.hide();
  }

  function ensurePopover() {
    const url = getAppUrl();
    if (!url) return null;
    if (popover && !popover.isDestroyed()) {
      if (popover.webContents.getURL() !== url) void popover.loadURL(url);
      return popover;
    }
    const win = new BrowserWindow({
      width: MENU_BAR_POPOVER_WIDTH,
      height: MENU_BAR_POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      movable: false,
      backgroundColor: "#111111",
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        preload,
      },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, "floating");
    win.on("blur", () => hide());
    win.on("closed", () => {
      if (popover === win) popover = null;
    });
    void win.loadURL(url);
    popover = win;
    return win;
  }

  function show() {
    const win = ensurePopover();
    if (!win) return;
    positionPopover();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  function toggle() {
    if (popover && !popover.isDestroyed() && popover.isVisible()) hide();
    else show();
  }

  function installTray() {
    if (tray) return;
    let image = loadMenuBarTrayImage();
    if (image.isEmpty() && iconPath) {
      image = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
      if (process.platform === "darwin") image.setTemplateImage(true);
    }
    tray = new Tray(image);
    tray.setToolTip("OpenMausBot");
    tray.on("click", () => toggle());
    tray.on("right-click", () => {
      const menu = Menu.buildFromTemplate([
        {
          label: "Open OpenMausBot",
          click: () => {
            hide();
            showMainWindow();
          },
        },
        {
          label: "Show menu bar window",
          click: () => show(),
        },
        { type: "separator" },
        { role: "quit" },
      ]);
      tray.popUpContextMenu(menu);
    });
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (enabled) installTray();
    else destroyTray();
    return enabled;
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    hide,
    show,
    openMain: () => {
      hide();
      showMainWindow();
    },
    dispose: destroyTray,
  };
}
