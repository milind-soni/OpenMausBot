import nativeText from "./native-text.cjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

const listed = (names, t) => names.length < 3 ? names.join(t("native.lendTray.and")) : `${names.slice(0, -1).join(", ")}${t("native.lendTray.and")}${names.at(-1)}`;
const short = (names, t) => names.length < 3 ? listed(names, t) : t("native.lendTray.clouds", { count: names.length });

export function indicatorText({ clouds, using, paused }, device, t = nativeText.englishText.t) {
  const named = device === "computer" ? t("native.lendTray.computer") : device;
  if (paused) return { line: t("native.lendTray.pausedLine", { clouds: listed(clouds, t), device: named }), title: t("native.lendTray.paused") };
  if (using.length) {
    const key = using.length > 1 ? "native.lendTray.usingMany" : "native.lendTray.usingOne";
    return { line: t(key, { clouds: listed(using, t), device: named }), title: t(key, { clouds: short(using, t), device: named }) };
  }
  return { line: t("native.lendTray.canUse", { clouds: listed(clouds, t), device: named }), title: "" };
}

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, device = deviceWord(), t = nativeText.englishText.t }) {
  let tray = null;
  let shown = null;
  const draw = view => {
    const { line, title } = indicatorText(view, device, t);
    tray.setToolTip(`OpenMausBot: ${line}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: "separator" },
      view.paused ? { label: "Resume", click: () => onResume() } : { label: "Pause", click: () => onPause() },
      { label: "See activity", click: () => onActivity() },
    ]));
  };
  return {
    update({ clouds = [], using = [], paused = false }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], paused: paused === true };
      if (shown && JSON.stringify(next) === JSON.stringify(shown)) return;
      shown = next;
      if (!next.clouds.length) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      draw(next);
    },
    relabel() { if (tray && !tray.isDestroyed() && shown) draw(shown); },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = null; },
  };
}
