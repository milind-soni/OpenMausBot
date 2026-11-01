import { desktopText as text } from "./i18n.mjs";

// Retain the Windows notification-area identity across app restarts.
export function createSystemTray({ Tray, Menu, nativeImage, iconPath, getWindow, onQuit }) {
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }),
    "889af657-21b5-4ec9-b5d0-cb798cbdfd30");
  let hidden = false;
  const show = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    hidden = false;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  };
  const refresh = () => {
    tray.setToolTip("OpenMaus Bot");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: text("desktop.tray.open"), click: show },
      { type: "separator" },
      { label: text("desktop.tray.quit"), click: onQuit },
    ]));
  };
  refresh();
  tray.on("click", show);
  tray.on("double-click", show);
  return {
    refresh,
    show,
    hide(win) { hidden = true; win.setSkipTaskbar(true); win.hide(); },
    isHidden() { return hidden; },
    windowShown(win) { hidden = false; win.setSkipTaskbar(false); },
    destroy() { if (!tray.isDestroyed()) tray.destroy(); },
  };
}
