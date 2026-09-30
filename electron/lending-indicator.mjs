// The menu-bar (notification-area) sign that this computer is lent to the
// person's OMB Cloud. It exists only while lending is on, says when the Cloud
// is using the computer right now, and has the one instant control: Stop
// lending. Native menu text is English, like the app's other native menus.
export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen }) {
  let tray = null;
  let shown = { lending: false, busy: false };
  const menu = busy => Menu.buildFromTemplate([
    { label: busy ? "Your Cloud is using this computer now" : "Your Cloud can use this computer", enabled: false },
    { type: "separator" },
    { label: "Stop lending", click: () => onStop() },
    { label: "Lending settings…", click: () => onOpen() },
  ]);
  return {
    /** `lending`: at least one Cloud grant is on; `busy`: an action runs now. */
    update({ lending, busy }) {
      const next = { lending: Boolean(lending), busy: Boolean(lending && busy) };
      if (next.lending === shown.lending && next.busy === shown.busy && (tray !== null) === next.lending) return;
      shown = next;
      if (!next.lending) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      tray.setToolTip(next.busy ? "OpenMaus Bot: your Cloud is using this computer" : "OpenMaus Bot: lent to your Cloud");
      // macOS shows the title beside the icon: visible while in use.
      tray.setTitle?.(next.busy ? "In use" : "");
      tray.setContextMenu(menu(next.busy));
    },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = { lending: false, busy: false }; },
  };
}
