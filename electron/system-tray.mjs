import nativeText from "./native-text.cjs";

// Retain the Windows notification-area identity across app restarts.
export function createSystemTray({ Tray, Menu, nativeImage, iconPath, getWindow, onQuit, t = nativeText.englishText.t }) {
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }),
    "889af657-21b5-4ec9-b5d0-cb798cbdfd30");
  let hidden = false, lent = false;
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
  const label = () => lent || tray.setContextMenu(Menu.buildFromTemplate([
    { label: t("native.tray.open"), click: show },
    { type: "separator" },
    { label: t("native.tray.quit"), click: onQuit },
  ]));
  tray.setToolTip("OpenMausBot");
  label();
  tray.on("click", show);
  tray.on("double-click", show);
  return {
    show,
    hide(win) { hidden = true; win.setSkipTaskbar(true); win.hide(); },
    isHidden() { return hidden; },
    windowShown(win) { hidden = false; win.setSkipTaskbar(false); },
    relabel() { if (!tray.isDestroyed()) label(); },
    /**
     * Linux gives StatusNotifierItem to the first tray only; a second one falls back to GtkStatusIcon, which GNOME and
     * KDE on Wayland never show. So the lending indicator borrows this icon while it has something to say, and its
     * destroy() hands the icon back with Open and Quit. Clicks stay this tray's: they open the window.
     */
    borrow() {
      lent = true;
      let returned = false;
      return {
        setToolTip: value => tray.setToolTip(value),
        setTitle: value => tray.setTitle?.(value),
        setContextMenu: menu => tray.setContextMenu(menu),
        popUpContextMenu: () => tray.popUpContextMenu?.(),
        on() {},
        isDestroyed: () => returned || tray.isDestroyed(),
        destroy() {
          if (returned) return;
          returned = true; lent = false;
          if (tray.isDestroyed()) return;
          tray.setToolTip("OpenMausBot");
          label();
        },
      };
    },
    /** A Tray class for the lending indicator: constructing one borrows this icon instead of making a second. */
    get Borrowed() { const owner = this; return class { constructor() { return owner.borrow(); } }; },
    destroy() { if (!tray.isDestroyed()) tray.destroy(); },
  };
}
