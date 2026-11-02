import { screenFixLabel, screenLine } from "./screen-words.mjs";
import { desktopText } from "./i18n.mjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : desktopText("desktop.extra.indicator.computer");

const listed = names => names.length < 3 ? names.join(desktopText("desktop.extra.indicator.listAnd")) : `${names.slice(0, -1).join(desktopText("desktop.extra.indicator.listComma"))}${desktopText("desktop.extra.indicator.listAnd")}${names.at(-1)}`;
/** Beside the icon there is room for two names at most. */
const short = names => names.length < 3 ? listed(names) : desktopText("desktop.extra.indicator.cloudCount", { count: names.length });

/** `screen`: computer control's state; while it isn't ready the line says what the Clouds
 * can't use, and `screen` why. */
export function indicatorText({ clouds, using, paused, screen = null }, device) {
  if (paused) return { line: desktopText("desktop.extra.indicator.paused", { names: listed(clouds), device }), title: desktopText("automations.status.paused"), screen: null };
  const why = screenLine(screen, device);
  if (using.length) return { line: desktopText(using.length > 1 ? "desktop.extra.indicator.usingMany" : "desktop.extra.indicator.usingOne", { names: listed(using), device }), title: desktopText(using.length > 1 ? "desktop.extra.indicator.usingMany" : "desktop.extra.indicator.usingOne", { names: short(using), device }), screen: why };
  return { line: desktopText(why ? "desktop.extra.indicator.limited" : "desktop.extra.indicator.available", { names: listed(clouds), device }), title: "", screen: why };
}

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, onStartScreen = () => {}, device }) {
  let tray = null;
  let shown = null;
  const draw = view => {
    if (!tray || tray.isDestroyed()) return;
    const currentDevice = device ?? deviceWord();
    const { line, title, screen } = indicatorText(view, currentDevice);
    const fix = screen ? screenFixLabel(view.screen) : null;
    tray.setToolTip(`OpenMausBot: ${screen ? desktopText("desktop.extra.indicator.tooltipScreen", { line, screen }) : line}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      ...screen ? [{ label: screen, enabled: false }] : [],
      ...fix ? [{ label: fix, click: () => onStartScreen() }] : [],
      { type: "separator" },
      view.paused ? { label: desktopText("automations.resume"), click: () => onResume() } : { label: desktopText("automations.pause"), click: () => onPause() },
      ...view.paused ? [] : [{ label: desktopText("desktop.extra.indicator.allowTerminal", { device: currentDevice }), type: "checkbox", checked: view.terminal,
        // Electron 43 ticks a checkbox on click by itself: the menu keeps the saved choice until the person confirms one.
        click: () => { draw(view); onTerminal(!view.terminal); } }],
      { label: desktopText("desktop.extra.indicator.activity"), click: () => onActivity() },
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
    refresh() { if (shown) draw(shown); },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = null; },
  };
}
