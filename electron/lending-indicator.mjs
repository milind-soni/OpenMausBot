/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

const listed = names => names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
/** Beside the icon there is room for two names at most. */
const short = names => names.length < 3 ? listed(names) : `${names.length} Clouds`;

export function indicatorText({ clouds, using, paused, pauseError }, device) {
  const it = `this ${device}`;
  if (pauseError) return { line: pauseError, title: "Paused: save needs attention" };
  if (paused) return { line: `Paused: ${listed(clouds)} can't use ${it}`, title: "Paused" };
  if (using.length) return { line: `${listed(using)} ${using.length > 1 ? "are" : "is"} using ${it}`, title: `${short(using)} ${using.length > 1 ? "are" : "is"} using ${it}` };
  return { line: `${listed(clouds)} can use ${it}`, title: "" };
}

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, device = deviceWord() }) {
  let tray = null;
  let shown = null;
  const draw = view => {
    if (!tray || tray.isDestroyed()) return;
    const { line, title } = indicatorText(view, device);
    tray.setToolTip(`OpenMausBot: ${line}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: "separator" },
      ...(view.pauseError ? [{ label: "Retry saving pause", click: () => onPause() }] : []),
      view.paused ? { label: "Resume", click: () => onResume() } : { label: "Pause", click: () => onPause() },
      ...view.paused ? [] : [{ label: `Let Clouds run commands on this ${device}`, type: "checkbox", checked: view.terminal,
        // Electron 43 ticks a checkbox on click by itself: the menu keeps the saved choice until the person confirms one.
        click: () => { draw(view); onTerminal(!view.terminal); } }],
      { label: "See activity", click: () => onActivity() },
    ]));
  };
  return {
    update({ clouds = [], using = [], paused = false, terminal = false, pauseError }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], paused: paused === true, terminal: terminal === true, ...(pauseError ? { pauseError } : {}) };
      if (shown && JSON.stringify(next) === JSON.stringify(shown)) return;
      shown = next;
      if (!next.clouds.length) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      draw(next);
    },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = null; },
  };
}
