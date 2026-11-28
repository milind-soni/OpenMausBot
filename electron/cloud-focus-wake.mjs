// A person who uses My Cloud comes back to the app: when its window gets focus while My Cloud sleeps on a plan that
// sleeps, My Cloud is asked to wake through the Admin, so the first message the person sends it does not wait for the
// wake. Off unless OMB_CLOUD_FOCUS_WAKE=1: a wake nobody follows keeps the Cloud awake until it is idle again (at least
// CLOUD_IDLE_AWAKE_MS, 2 minutes, plus the Admin's next power read, server/cloud-power.ts).
//
// "Uses My Cloud" is read from this computer alone: the window showed My Cloud's page when it got or lost focus in the
// last 7 days. With no such record nothing is woken.

export const CLOUD_FOCUS_WAKE_FILE = "cloud-focus-wake.json";
/** Fewer wakes than this apart, however often the window is focused. */
export const FOCUS_WAKE_GAP_MS = 15 * 60_000;
export const USED_WITHIN_MS = 7 * 24 * 60 * 60_000;
/** The use record is written at most this often. */
const USED_WRITE_MS = 60 * 60_000;

export const focusWakeEnabled = (env = process.env) => env.OMB_CLOUD_FOCUS_WAKE === "1";

/**
 * `account()`: the Cloud account client (`power()`, the Admin's word on My Cloud; `wakeHome()`, the Admin's wake for
 * My Cloud only). `pref`: a JSON file (`read`, `write`) for the use record.
 */
export function createCloudFocusWake({ enabled = focusWakeEnabled, account, pref, now = Date.now, log = () => {} }) {
  let lastWake = -Infinity, usedAt;
  const readUsed = () => {
    if (usedAt !== undefined) return usedAt;
    try { const at = pref.read()?.usedAt; usedAt = Number.isFinite(at) ? at : null; } catch { usedAt = null; }
    return usedAt;
  };
  const used = () => {
    const at = now(), before = readUsed();
    if (before !== null && at - before < USED_WRITE_MS) return;
    usedAt = at;
    try { pref.write({ usedAt: at }); } catch {}
  };
  return {
    /** The window got focus. `shown`: it is on screen, neither hidden nor minimized. `showingCloud`: it shows My Cloud's
     * page, which wakes My Cloud itself on focus. Returns whether a wake was asked for. */
    focused({ shown, showingCloud }) {
      if (showingCloud) { used(); return false; }
      if (!enabled() || !shown) return false;
      const at = now(), since = readUsed();
      if (since === null || at - since > USED_WITHIN_MS || at - lastWake < FOCUS_WAKE_GAP_MS) return false;
      const client = account();
      if (client?.power()?.state !== "asleep") return false;
      lastWake = at;
      void Promise.resolve().then(() => client.wakeHome()).then((state) => log(`cloud: asked My Cloud to wake on focus (${state ?? "no answer"})`), () => {});
      return true;
    },
    /** The window lost focus. */
    blurred({ showingCloud }) {
      if (showingCloud) used();
    },
  };
}
