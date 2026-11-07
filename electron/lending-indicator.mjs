import nativeText from "./native-text.cjs";
import { screenFixLabel, screenLine } from "./screen-words.mjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

const listed = (names, t) => names.length < 3 ? names.join(t("native.lendTray.and")) : `${names.slice(0, -1).join(", ")}${t("native.lendTray.and")}${names.at(-1)}`;
const short = (names, t) => names.length < 3 ? listed(names, t) : t("native.lendTray.clouds", { count: names.length });

/** `screen`: computer control's state; while it isn't ready the line says what the Clouds
 * can't use, and `screen` why. */
/** `waiting`: lent Clouds that haven't accepted this computer yet; they are never said to be able to use it, and
 * `pending` says who is still being waited for. */
export function indicatorText({ clouds, using, paused, screen = null, waiting = [] }, device, t = nativeText.englishText.t) {
  const named = device === "computer" ? t("native.lendTray.computer") : device;
  if (paused) return { line: t("native.lendTray.pausedLine", { clouds: listed(clouds, t), device: named }), title: t("native.lendTray.paused"), screen: null };
  const why = screenLine(screen, device, t);
  const pending = waiting.length ? { pending: t("native.lendTray.waiting", { clouds: listed(waiting, t), device: named }) } : {};
  if (using.length) {
    const key = using.length > 1 ? "native.lendTray.usingMany" : "native.lendTray.usingOne";
    return { line: t(key, { clouds: listed(using, t), device: named }), title: t(key, { clouds: short(using, t), device: named }), screen: why, ...pending };
  }
  const ready = clouds.filter(name => !waiting.includes(name));
  if (!ready.length) return { line: pending.pending ?? t("native.lendTray.canUse", { clouds: listed(clouds, t), device: named }), title: "", screen: why };
  const line = t(why ? "native.lendTray.canUseWithoutScreen" : "native.lendTray.canUse", { clouds: listed(ready, t), device: named });
  return { line, title: "", screen: why, ...pending };
}

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, onMcp = () => {}, onStartScreen = () => {}, device = deviceWord(), t = nativeText.englishText.t }) {
  let tray = null;
  let shown = null;
  const draw = view => {
    if (!tray || tray.isDestroyed()) return;
    const { line, title, screen, pending } = indicatorText(view, device, t);
    const fix = screen ? screenFixLabel(view.screen, t) : null;
    tray.setToolTip(`OpenMausBot: ${line}${pending ? `. ${pending}` : ""}${screen ? `. ${screen}` : ""}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      ...pending ? [{ label: pending, enabled: false }] : [],
      ...screen ? [{ label: screen, enabled: false }] : [],
      ...fix ? [{ label: fix, click: () => onStartScreen() }] : [],
      { type: "separator" },
      view.paused ? { label: t("native.lendTray.resume"), click: () => onResume() } : { label: t("native.lendTray.pause"), click: () => onPause() },
      ...view.paused ? [] : [{ label: t("native.lendTray.terminal", { device: device === "computer" ? t("native.lendTray.computer") : device }), type: "checkbox", checked: view.terminal,
        // Electron 43 ticks a checkbox on click by itself: the menu keeps the saved choice until the person confirms one.
        click: () => { draw(view); onTerminal(!view.terminal); } },
      { label: t("native.lendTray.mcp", { device: device === "computer" ? t("native.lendTray.computer") : device }), type: "checkbox", checked: view.mcp,
        click: () => { draw(view); onMcp(!view.mcp); } }],
      { label: t("native.lendTray.activity"), click: () => onActivity() },
    ]));
  };
  return {
    update({ clouds = [], using = [], paused = false, terminal = false, mcp = false, screen = null, waiting = [] }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], waiting: paused ? [] : [...waiting], paused: paused === true, terminal: terminal === true, mcp: mcp === true,
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
    relabel() { if (tray && !tray.isDestroyed() && shown) draw(shown); },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = null; },
  };
}
