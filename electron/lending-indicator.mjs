import nativeText from "./native-text.cjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

/** `onTerminal(on)` asks before it lends the terminal and settles once main answers. Electron ticks a checkbox item on click (Electron 43), so the menu
 * is built again from what is lent once it settles: a No leaves it unticked. */
export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, onTerminal, device = deviceWord(), t = nativeText.englishText.t }) {
  let tray = null;
  const off = { lending: false, busy: false, internetOnly: false, terminal: false };
  let shown = off;
  const named = () => device === deviceWord("linux") ? t("native.lendTray.computer") : device;
  const menu = ({ busy, internetOnly, terminal }) => Menu.buildFromTemplate([
    { label: t(internetOnly ? (busy ? "native.lendTray.busyInternet" : "native.lendTray.idleInternet") : (busy ? "native.lendTray.busy" : "native.lendTray.idle"), { device: named() }), enabled: false },
    { type: "separator" },
    ...(onTerminal ? [{ label: t("native.lendTray.terminal"), type: "checkbox", checked: terminal, click: () => void onTerminal(!terminal).finally(redraw) }] : []),
    { label: t("native.lendTray.stop"), click: () => onStop() },
    { label: t("native.lendTray.settings"), click: () => onOpen() },
  ]);
  const paint = () => {
    tray.setToolTip(shown.busy ? t("native.lendTray.tipBusy") : t(shown.internetOnly ? "native.lendTray.tipIdleInternet" : "native.lendTray.tipIdle", { device: named() }));
    tray.setTitle?.(shown.busy ? t("native.lendTray.inUse") : "");
    redraw();
  };
  const redraw = () => { if (tray && !tray.isDestroyed()) tray.setContextMenu(menu(shown)); };
  return {
    update({ lending, busy, internetOnly, terminal }) {
      const next = { lending: Boolean(lending), busy: Boolean(lending && busy), internetOnly: Boolean(lending && internetOnly), terminal: Boolean(lending && terminal) };
      if (Object.keys(off).every(key => next[key] === shown[key]) && (tray !== null) === next.lending) return;
      shown = next;
      if (!next.lending) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      paint();
    },
    relabel() { if (tray && !tray.isDestroyed()) paint(); },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = off; },
  };
}
