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
export function indicatorText({ clouds, using, paused, pauseError, screen = null, waiting = [], problems = [] }, device, t = nativeText.englishText.t) {
  const named = device === "computer" ? t("native.lendTray.computer") : device;
  if (pauseError) return { line: t("native.lendTray.pauseUnsaved"), title: t("native.lendTray.pauseUnsavedTitle"), screen: null };
  if (paused) return { line: t("native.lendTray.pausedLine", { clouds: listed(clouds, t), device: named }), title: t("native.lendTray.paused"), screen: null };
  const said = problems.map(problem => t("native.lendTray.problem", { cloud: problem.name, device: named, why: problem.why }));
  const wrong = said.length ? { problems: said } : {};
  if (!clouds.length && said.length) return { line: said[0], title: "", screen: null, problems: said.slice(1) };
  const why = screenLine(screen, device, t);
  const pending = waiting.length ? { pending: t("native.lendTray.waiting", { clouds: listed(waiting, t), device: named }) } : {};
  if (using.length) {
    const key = using.length > 1 ? "native.lendTray.usingMany" : "native.lendTray.usingOne";
    return { line: t(key, { clouds: listed(using, t), device: named }), title: t(key, { clouds: short(using, t), device: named }), screen: why, ...pending, ...wrong };
  }
  const ready = clouds.filter(name => !waiting.includes(name));
  if (!ready.length) return { line: pending.pending ?? t("native.lendTray.canUse", { clouds: listed(clouds, t), device: named }), title: "", screen: why, ...wrong };
  const line = t(why ? "native.lendTray.canUseWithoutScreen" : "native.lendTray.canUse", { clouds: listed(ready, t), device: named });
  return { line, title: "", screen: why, ...pending, ...wrong };
}

/** How long lending has to stay broken before a notification says so: a blip is no news. */
const NOTICE_AFTER_MS = 10 * 60_000;

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, onStartScreen = () => {}, onQuit = null, device = deviceWord(), t = nativeText.englishText.t, Notification = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let tray = null;
  let shown = null;
  /** Each problem now, by what it says, until the notification for it goes out or it clears. */
  const noticeTimers = new Map(), notified = new Set();
  const followProblems = problems => {
    const now = new Set(problems.map(problem => `${problem.name}\n${problem.why}`));
    for (const key of noticeTimers.keys()) if (!now.has(key)) { clearTimer(noticeTimers.get(key)); noticeTimers.delete(key); }
    for (const key of notified) if (!now.has(key)) notified.delete(key);
    for (const problem of problems) {
      const key = `${problem.name}\n${problem.why}`;
      if (noticeTimers.has(key) || notified.has(key)) continue;
      const timer = setTimer(() => {
        noticeTimers.delete(key);
        notified.add(key);
        if (!Notification || Notification.isSupported?.() === false) return;
        try {
          new Notification({ title: t("native.lendTray.problemNoticeTitle", { cloud: problem.name, device: device === "computer" ? t("native.lendTray.computer") : device }), body: problem.why }).show();
        } catch {}
      }, NOTICE_AFTER_MS);
      timer?.unref?.();
      noticeTimers.set(key, timer);
    }
  };
  const draw = view => {
    if (!tray || tray.isDestroyed()) return;
    const { line, title, screen, pending, problems = [] } = indicatorText(view, device, t);
    const fix = screen ? screenFixLabel(view.screen, t) : null;
    tray.setToolTip(`OpenMausBot: ${line}${pending ? `. ${pending}` : ""}${screen ? `. ${screen}` : ""}${problems.length ? `. ${problems.join(". ")}` : ""}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      ...pending ? [{ label: pending, enabled: false }] : [],
      ...problems.map(problem => ({ label: problem, enabled: false })),
      ...screen ? [{ label: screen, enabled: false }] : [],
      ...fix ? [{ label: fix, click: () => onStartScreen() }] : [],
      { type: "separator" },
      ...view.pauseError ? [{ label: t("native.lendTray.retryPause"), click: () => onPause() }] : [],
      view.paused ? { label: t("native.lendTray.resume"), click: () => onResume() } : { label: t("native.lendTray.pause"), click: () => onPause() },
      ...view.paused || !view.terminalSwitch ? [] : [{ label: t("native.lendTray.terminal", { device: device === "computer" ? t("native.lendTray.computer") : device }), type: "checkbox", checked: view.terminal,
        // Electron 43 ticks a checkbox on click by itself: the menu keeps the saved choice until the person confirms one.
        click: () => { draw(view); onTerminal(!view.terminal); } }],
      { label: t("native.lendTray.activity"), click: () => onActivity() },
      ...onQuit ? [{ type: "separator" }, { label: t("native.tray.quit"), click: () => onQuit() }] : [],
    ]));
  };
  return {
    update({ clouds = [], using = [], paused = false, pauseError, terminal = false, terminalSwitch = true, screen = null, waiting = [], problems = [] }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], waiting: paused ? [] : [...waiting], problems: paused ? [] : problems.map(({ name, why }) => ({ name, why })), paused: paused === true, ...pauseError ? { pauseError } : {},
        terminal: terminal === true, terminalSwitch: terminalSwitch !== false,
        screen: screen ? { ready: screen.ready === true, reason: screen.reason ?? null, fix: screen.fix ?? null, ...(screen.message ? { message: screen.message } : {}) } : null };
      if (shown && JSON.stringify(next) === JSON.stringify(shown)) return;
      shown = next;
      followProblems(next.problems);
      if (!next.clouds.length && !next.problems.length) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      draw(next);
    },
    relabel() { if (tray && !tray.isDestroyed() && shown) draw(shown); },
    destroy() { for (const timer of noticeTimers.values()) clearTimer(timer); noticeTimers.clear(); if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = null; },
  };
}
