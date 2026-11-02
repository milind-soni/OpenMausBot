import { screenFixLabel, screenLine } from "./screen-words.mjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

const listed = names => names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
/** Beside the icon there is room for two names at most. */
const short = names => names.length < 3 ? listed(names) : `${names.length} Clouds`;

/** `screen`: computer control's state; while it isn't ready the line says what the Clouds
 * can't use, and `screen` why. */
export function indicatorText({ clouds, using, paused, screen = null }, device) {
  const it = `this ${device}`;
  if (paused) return { line: `Paused: ${listed(clouds)} can't use ${it}`, title: "Paused", screen: null };
  const why = screenLine(screen, device);
  if (using.length) return { line: `${listed(using)} ${using.length > 1 ? "are" : "is"} using ${it}`, title: `${short(using)} ${using.length > 1 ? "are" : "is"} using ${it}`, screen: why };
  return { line: why ? `${listed(clouds)} can use ${it}, but not its apps and screen` : `${listed(clouds)} can use ${it}`, title: "", screen: why };
}

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, onStartScreen = () => {}, device = deviceWord() }) {
  let tray = null;
  let shown = null;
  const draw = view => {
    if (!tray || tray.isDestroyed()) return;
    const { line, title, screen } = indicatorText(view, device);
    const fix = screen ? screenFixLabel(view.screen) : null;
    tray.setToolTip(`OpenMausBot: ${line}${screen ? `. ${screen}` : ""}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      ...screen ? [{ label: screen, enabled: false }] : [],
      ...fix ? [{ label: fix, click: () => onStartScreen() }] : [],
      { type: "separator" },
      view.paused ? { label: "Resume", click: () => onResume() } : { label: "Pause", click: () => onPause() },
      ...view.paused ? [] : [{ label: `Let Clouds run commands on this ${device}`, type: "checkbox", checked: view.terminal,
        // Electron 43 ticks a checkbox on click by itself: the menu keeps the saved choice until the person confirms one.
        click: () => { draw(view); onTerminal(!view.terminal); } }],
      { label: "See activity", click: () => onActivity() },
    ]));
  };
  return {
    update({ clouds = [], using = [], paused = false, terminal = false, screen = null }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], paused: paused === true, terminal: terminal === true,
        screen: screen ? { ready: screen.ready === true, reason: screen.reason ?? null, fix: screen.fix ?? null, ...(screen.message ? { message: screen.message } : {}) } : null };
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
