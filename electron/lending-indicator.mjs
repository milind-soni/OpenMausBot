import nativeText from "./native-text.cjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, device = deviceWord(), t = nativeText.englishText.t }) {
  let tray = null;
  let shown = { lending: false, busy: false };
  const named = () => (device === deviceWord("linux") ? t("native.lendTray.computer") : device);
  const menu = busy => Menu.buildFromTemplate([
    { label: t(busy ? "native.lendTray.busy" : "native.lendTray.idle", { device: named() }), enabled: false },
    { type: "separator" },
    { label: t("native.lendTray.stop"), click: () => onStop() },
    { label: t("native.lendTray.settings"), click: () => onOpen() },
  ]);
  const paint = () => {
    tray.setToolTip(shown.busy ? t("native.lendTray.tipBusy") : t("native.lendTray.tipIdle", { device: named() }));
    // macOS shows the title beside the icon: visible while in use.
    tray.setTitle?.(shown.busy ? t("native.lendTray.inUse") : "");
    tray.setContextMenu(menu(shown.busy));
  };
  return {
    update({ lending, busy }) {
      const next = { lending: Boolean(lending), busy: Boolean(lending && busy) };
      if (next.lending === shown.lending && next.busy === shown.busy && (tray !== null) === next.lending) return;
      shown = next;
      if (!next.lending) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      paint();
    },
    relabel() { if (tray && !tray.isDestroyed()) paint(); },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = { lending: false, busy: false }; },
  };
}
