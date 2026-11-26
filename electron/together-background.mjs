// "This computer and My Cloud together" for a person whose home is My Cloud: this computer's own bots live in a workspace of
// its own (This Mac or This PC, the `default` profile, clean-workspace.mjs), which runs only once opened, while the folder
// the app starts on is the copy the move froze. With together on, this starts that workspace's server in the background
// after launch, so the one list and the link work without first clicking This Mac; the window stays where it is.
//
// Only when: My Cloud is home; the switch is on for the signed-in account; the window shows My Cloud (not while it loads
// or shows the screen of a Cloud waking up); the frozen copy runs (no other workspace was opened); the workspace exists and
// holds at least one bot. Never the frozen copy, never a new workspace made for it. Tried at TRY_AT_MS after launch and
// when the window settles in between, never inside the launch's quiet start, and started at most once a launch.
//
// Turned off again while the workspace it started runs and the window is not on it: the link is ended first, on that
// workspace's own server (its Cloud is told and forgets it), then the frozen copy runs again, once no turn is under way
// there (asked again every BUSY_RETRY_MS, at most BUSY_TRIES times; past that it stays until relaunch). Turned on again in
// the same session, it is tried again on the same schedule, from then.
import nodeFs from "node:fs";
import path from "node:path";

import { DEFAULT_PROFILE, profileDir } from "./clean-workspace.mjs";
import { START_QUIET_MS } from "./places-together.mjs";

/** When after launch it is tried: past the quiet start, and again while the window may still be loading. */
export const TRY_AT_MS = [START_QUIET_MS, 45_000, 120_000];
export const BUSY_RETRY_MS = 30_000;
export const BUSY_TRIES = 20;

/** Whether the workspace in `dir` holds a bot of its own: its bots.json lists one that is not hidden and did not move. A
 * folder or file that is missing or can't be read holds none. */
export function holdsBots(dir, fs = nodeFs) {
  let bots;
  try { bots = JSON.parse(fs.readFileSync(path.join(dir, "bots.json"), "utf8")); } catch { return false; }
  return Array.isArray(bots) && bots.some((bot) => bot && typeof bot === "object" && typeof bot.id === "string" && !bot.hidden && !bot.movedTo);
}

/**
 * @param {{
 *   cloudHome(): boolean,
 *   togetherOn(): boolean,
 *   shown(): string | null,
 *   ownCopyRuns(): boolean,
 *   running(): string | null,
 *   dataDir(): string,
 *   open(id: string): Promise<boolean>,
 *   leave(): Promise<boolean>,
 *   busy(): Promise<boolean>,
 *   linkOff(): Promise<unknown>,
 *   fs?: typeof nodeFs,
 *   tryAt?: number[],
 *   now?(): number,
 *   later?: typeof setTimeout,
 *   cancel?: typeof clearTimeout,
 *   log?(line: string): void,
 * }} deps `togetherOn()`: the switch is on for the signed-in account (places-together.mjs `switchOn`). `shown()`: the place
 * the window shows ("cloud", "computer", "waking", "other", null while a page loads). `ownCopyRuns()`: this computer's
 * server runs on the frozen copy. `running()`: the workspace that runs now (clean-workspace.mjs `profile`). `open(id)` and
 * `leave()`: start that workspace's server, or the frozen copy's again, without moving the window. `busy()`: a turn is
 * under way in the workspace that runs (or it could not say). `linkOff()`: the link is brought in line with the switch
 * (bot-link-main.mjs `look`), ended on the server that runs now, before that server stops.
 */
export function createTogetherBackground({ cloudHome, togetherOn, shown, ownCopyRuns, running, dataDir, open, leave, busy, linkOff = async () => {}, fs = nodeFs, tryAt = TRY_AT_MS,
  now = Date.now, later = setTimeout, cancel = clearTimeout, log = () => {} }) {
  /** When the tries were last scheduled from: the launch, or the switch turned on again. */
  let launchedAt = now(), wasOn = null;
  const timers = new Set();
  let started = false, opening = false, startedHere = false, stopping = null;
  const schedule = (run, ms) => { const timer = later(() => { timers.delete(timer); void run(); }, ms); timer?.unref?.(); timers.add(timer); };

  async function run() {
    if (started || opening || now() - launchedAt < tryAt[0] || now() - launchedAt > tryAt.at(-1) + 1_000) return false;
    if (!cloudHome() || !togetherOn() || shown() !== "cloud" || !ownCopyRuns()) return false;
    if (!holdsBots(profileDir(dataDir(), DEFAULT_PROFILE), fs)) return false;
    opening = true;
    const opened = await open(DEFAULT_PROFILE).catch((error) => { log(`together: this computer's workspace did not start (${error?.message ?? error})`); return false; }).finally(() => { opening = false; });
    if (opened !== true) return false;
    started = startedHere = true;
    log("together: this computer's workspace started in the background");
    return true;
  }

  /** Turned off: the frozen copy again, once the workspace this started is idle, unless the window shows it. */
  async function stopOnce(tries) {
    stopping = null;
    if (!startedHere || togetherOn() || running() !== DEFAULT_PROFILE) { startedHere = startedHere && running() === DEFAULT_PROFILE; return; }
    if (shown() === "computer") return;
    // The link ends on this workspace's own server, and its Cloud is told, before that server stops.
    await linkOff().catch((error) => log(`together: the link did not end before the workspace stopped (${error?.message ?? error})`));
    if (togetherOn() || running() !== DEFAULT_PROFILE) return;
    if (await busy().catch(() => true)) {
      if (tries + 1 < BUSY_TRIES) { stopping = tries + 1; schedule(() => stopOnce(tries + 1), BUSY_RETRY_MS); }
      else log("together: this computer's workspace keeps working; it stops at the next launch");
      return;
    }
    if (await leave().catch(() => false)) { startedHere = false; log("together: off, so this computer's workspace stopped and the frozen copy runs again"); }
  }

  const scheduleTries = () => { for (const ms of tryAt) schedule(run, Math.max(0, ms - (now() - launchedAt))); };
  return {
    /** The launch is under way: tried at each of TRY_AT_MS. */
    start() { wasOn = togetherOn(); scheduleTries(); },
    /** The window finished loading a page: tried now, within the launch's tries. */
    settled() { void run(); },
    /** The switch changed: turned off, the workspace this started stops; turned on again, it is tried again from now. */
    changed() {
      const on = togetherOn();
      if (!on && startedHere && stopping === null) void stopOnce(0);
      if (on && wasOn === false && !startedHere) { started = false; launchedAt = now(); for (const timer of timers) cancel(timer); timers.clear(); scheduleTries(); }
      wasOn = on;
    },
    run,
    close() { for (const timer of timers) cancel(timer); timers.clear(); },
  };
}
