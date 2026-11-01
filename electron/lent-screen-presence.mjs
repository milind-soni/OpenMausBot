// Bots use a lent computer while the person uses it too, without fighting them for the mouse or keyboard. cua-driver
// acts in the background by default: it reads and acts on an app's window through its accessibility tree and posts
// input to that app alone, so the real pointer, the keyboard focus and the front app stay the person's. Only a call
// that takes the foreground waits until nobody has touched the computer for a while.

/** Nobody touched the keyboard, mouse or trackpad for this long: the person has stepped away. */
export const PERSON_AWAY_SECONDS = 30;

/** Never act: they read the screen, or only steer the bot's own drawn cursor and session. */
const READS = new Set([
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state", "get_screen_size",
  "get_cursor_position", "zoom", "get_browser_state", "start_session", "end_session", "get_session_state", "escalate_session",
  "get_agent_cursor_state", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_style", "move_cursor",
]);

/** Whether a lent screen call would take the person's mouse, keyboard or front app. `launch_app` opens hidden (the driver
 * pushes focus back), and the browser tools drive the page over DevTools, so neither does. Every other action stays in
 * the background only with a window to post to (`pid`): without one it lands on whatever app or field is in front. */
export function takesForeground(name, args) {
  const given = args && typeof args === "object" ? args : {};
  if (READS.has(name) || name === "launch_app" || name.startsWith("browser_")) return false;
  if (name === "bring_to_front" || name === "drag") return true;
  if (given.delivery_mode === "foreground" || given.scope === "desktop") return true;
  return !Number.isSafeInteger(given.pid);
}

export function personActiveText(name) {
  return `The person is using this computer right now, so ${name} was not performed: it would take their mouse, keyboard or front window. ` +
    "Do it in the background instead: give the app's pid and window_id (from launch_app or list_windows) and act on an element from get_window_state, " +
    "without delivery_mode \"foreground\" or scope \"desktop\". " +
    `If it can only be done in the foreground, wait until nobody has touched the computer for ${PERSON_AWAY_SECONDS} seconds, then observe it again and retry.`;
}

/** `idleSeconds()`: seconds since the person last touched this computer, or null when this system cannot tell (then
 * nothing waits, as before). A foreground action's own input can read as a touch, so a touch no later than the end of
 * the bot's last foreground action is the bot's, not the person's. A background action is never counted that way: a
 * bot acting every second must not hide a person who is typing. */
export function createLentScreenPresence({ idleSeconds = () => null, now = Date.now } = {}) {
  let ownInputUntil = -Infinity;
  return {
    /** The plain reason a call must wait, or null when it may run now. */
    refusal(name, args) {
      if (!takesForeground(name, args)) return null;
      const idle = idleSeconds();
      if (typeof idle !== "number" || !Number.isFinite(idle) || idle >= PERSON_AWAY_SECONDS) return null;
      // Seconds are whole, so the last touch was up to a second before `idle` says.
      const touchedAfter = now() - (idle + 1) * 1000;
      return touchedAfter <= ownInputUntil ? null : personActiveText(name);
    },
    /** Called when a call that reached the screen has ended. */
    acted(name, args) {
      if (takesForeground(name, args)) ownInputUntil = now();
    },
  };
}
