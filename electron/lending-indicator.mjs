import nativeText from "./native-text.cjs";
import { screenFixLabel, screenLine } from "./screen-words.mjs";
import { dotIcons } from "./color-dot.mjs";

/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

const listed = (names, t) => names.length < 3 ? names.join(t("native.lendTray.and")) : `${names.slice(0, -1).join(", ")}${t("native.lendTray.and")}${names.at(-1)}`;
const short = (names, t) => names.length < 3 ? listed(names, t) : t("native.lendTray.clouds", { count: names.length });

// oxlint-disable-next-line no-control-regex
const NOT_PRINTABLE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
/** The bot a Cloud says an action is for: a short plain name and a colour word, or null. Older Clouds send none. */
export function actingBot(by) {
  const name = typeof by?.name === "string" ? by.name.trim().replace(/\s+/g, " ") : "";
  if (!name || [...name].length > 64 || NOT_PRINTABLE.test(name)) return null;
  return { name, color: typeof by.color === "string" && /^[a-z]{1,16}$/.test(by.color) ? by.color : null };
}

/** `screen`: computer control's state; while it isn't ready the line says what the Clouds
 * can't use, and `screen` why. */
/** `waiting`: lent Clouds that haven't accepted this computer yet; they are never said to be able to use it, and
 * `pending` says who is still being waited for. */
/** `bots`: the bots acting here now, each with the Cloud it acts from; the menu names them, each with its colour dot. */
export function indicatorText({ clouds, using, bots = [], paused, pauseError, screen = null, waiting = [], problems = [] }, device, t = nativeText.englishText.t) {
  const named = device === "computer" ? t("native.lendTray.computer") : device;
  if (pauseError) return { line: t("native.lendTray.pauseUnsaved"), title: t("native.lendTray.pauseUnsavedTitle"), screen: null };
  if (paused) return { line: t("native.lendTray.pausedLine", { clouds: listed(clouds, t), device: named }), title: t("native.lendTray.paused"), screen: null };
  const said = problems.map(problem => t("native.lendTray.problem", { cloud: problem.name, device: named, why: problem.why }));
  const wrong = said.length ? { problems: said } : {};
  if (!clouds.length && said.length) return { line: said[0], title: "", screen: null, problems: said.slice(1) };
  const why = screenLine(screen, device, t);
  const pending = waiting.length ? { pending: t("native.lendTray.waiting", { clouds: listed(waiting, t), device: named }) } : {};
  if (using.length) {
    const say = (names, form) => t(names.length > 1 ? "native.lendTray.usingMany" : "native.lendTray.usingOne", { clouds: form(names, t), device: named });
    const acting = bots.filter(bot => using.includes(bot.cloud));
    const rest = using.filter(name => !acting.some(bot => bot.cloud === name));
    const byBot = acting.length ? { acting: acting.map(bot => ({ label: t("native.lendTray.botUsing", { bot: bot.name, cloud: bot.cloud, device: named }), color: bot.color })) } : {};
    return { line: rest.length ? say(rest, listed) : null, title: say([...acting.map(bot => bot.name), ...rest], short), screen: why, ...byBot, ...pending, ...wrong };
  }
  const ready = clouds.filter(name => !waiting.includes(name));
  if (!ready.length) return { line: pending.pending ?? t("native.lendTray.canUse", { clouds: listed(clouds, t), device: named }), title: "", screen: why, ...wrong };
  const line = t(why ? "native.lendTray.canUseWithoutScreen" : "native.lendTray.canUse", { clouds: listed(ready, t), device: named });
  return { line, title: "", screen: why, ...pending, ...wrong };
}

/** How long lending has to stay broken before a notification says so: a blip is no news. */
const NOTICE_AFTER_MS = 10 * 60_000;

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onPause, onResume, onActivity, onTerminal, onStartScreen = () => {}, device = deviceWord(), t = nativeText.englishText.t, Notification = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let tray = null;
  let shown = null;
  const dot = dotIcons(nativeImage);
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
    const { line, title, screen, pending, problems = [], acting = [] } = indicatorText(view, device, t);
    const fix = screen ? screenFixLabel(view.screen, t) : null;
    const said = [...acting.map(bot => bot.label), ...line ? [line] : []].join(". ");
    tray.setToolTip(`OpenMausBot: ${said}${pending ? `. ${pending}` : ""}${screen ? `. ${screen}` : ""}${problems.length ? `. ${problems.join(". ")}` : ""}`);
    // Electron shows a tray title beside the icon on macOS only.
    tray.setTitle?.(title);
    tray.setContextMenu(Menu.buildFromTemplate([
      // A bot's line opens the activity, so it shows in full colour rather than greyed out.
      ...acting.map(bot => { const icon = dot(bot.color); return { label: bot.label, ...icon ? { icon } : {}, click: () => onActivity() }; }),
      ...line ? [{ label: line, enabled: false }] : [],
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
    ]));
  };
  return {
    update({ clouds = [], using = [], bots = [], paused = false, pauseError, terminal = false, terminalSwitch = true, screen = null, waiting = [], problems = [] }) {
      const next = { clouds: [...clouds], using: paused ? [] : [...using], bots: paused ? [] : bots.map(({ name, color, cloud }) => ({ name, color, cloud })), waiting: paused ? [] : [...waiting], problems: paused ? [] : problems.map(({ name, why }) => ({ name, why })), paused: paused === true, ...pauseError ? { pauseError } : {},
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
