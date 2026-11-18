// The desktop app's launch, stage by stage, for usage analytics: the app's pages can count only launches that got as
// far as a page, so main says how far each launch got. It honours the same Usage analytics switch as the pages.
import { randomUUID } from "node:crypto";
import { readLastRunVersion } from "./startup-cache-eviction.mjs";

// The app's own PostHog project; the phc_ token is a write-only public key, the same one the app's pages send with.
const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";
const ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
const SEND_TIMEOUT_MS = 10_000;

export const LAUNCH_STAGES = Object.freeze([
  "started", "server_spawned", "server_ready", "server_failed", "window_shown", "page_load_failed", "page_crashed",
]);
/** Why the server did not start, how the window came up, and Electron's render-process-gone reasons. */
export const LAUNCH_REASONS = Object.freeze([
  "timeout", "exited", "foreign-owner", "stuck-child", "relay",
  "painted", "crashed", "shown", "hidden",
  "abnormal-exit", "integrity-failure", "killed", "launch-failed", "oom",
]);
const OS = { darwin: "Mac OS X", win32: "Windows", linux: "Linux" };

/** The first version whose page moves an opt-out kept only in its own storage to the desktop's switch on start. */
const OPT_OUT_KEPT_SINCE = [0, 1, 113];

function atLeast(version, minimum) {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
  if (!parts) return false;
  for (let index = 0; index < 3; index++) {
    const part = Number(parts[index + 1]);
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

/**
 * Security: main sends only where the pages would. The switch says so (`true`), or no choice was kept (`null`) and either
 * this is the computer's first launch or its last launch ran a version whose page had already moved any opt-out kept
 * only in the page's storage into the switch. Packaged builds only, never under the smoke tests or CI.
 */
export function launchAnalyticsAllowed({ choice, firstLaunch, lastVersion, packaged, env }) {
  if (!packaged || env.OMB_SMOKE_TEST === "1" || env.CI) return false;
  if (choice === true) return true;
  if (choice !== null) return false;
  return firstLaunch || atLeast(lastVersion, OPT_OUT_KEPT_SINCE);
}

const allowed = (value, list) => (typeof value === "string" && list.includes(value) ? value : "other");

/**
 * One `desktop_launch` event per stage reached, under a random id made for this launch alone and kept nowhere: it ties
 * the stages of one launch together, never one launch to another, to a page's id or to a person.
 */
export function createLaunchAnalytics({ fetch, choice, lastVersion, version, platform, packaged, env, now = Date.now, id = randomUUID() }) {
  const startedAt = now();
  const firstLaunch = lastVersion === null;
  const updated = !firstLaunch && lastVersion !== version;
  const reached = new Set();
  let serverFailure = null;
  const stage = (name, { reason, hidden } = {}) => {
    if (!LAUNCH_STAGES.includes(name) || reached.has(name)) return;
    reached.add(name);
    if (!launchAnalyticsAllowed({ choice: choice(), firstLaunch, lastVersion, packaged, env })) return;
    const why = reason ?? (name === "server_failed" ? serverFailure : undefined);
    const properties = {
      stage: name, ms: Math.max(0, Math.round(now() - startedAt)), first_launch: firstLaunch, updated,
      ...(typeof hidden === "boolean" ? { hidden } : {}), ...(why === undefined || why === null ? {} : { reason: allowed(why, LAUNCH_REASONS) }),
      app_version: version, platform: "desktop", surface: "main", $os: OS[platform] ?? "other", $process_person_profile: false,
    };
    try {
      void Promise.resolve(fetch(ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", cache: "no-store",
        body: JSON.stringify({ api_key: TOKEN, event: "desktop_launch", distinct_id: id, timestamp: new Date(now()).toISOString(), properties }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })).catch(() => {});
    } catch {}
  };
  return {
    stage,
    /** The latest reason a server child did not come up; sent with `server_failed`. */
    serverFailed(outcome) { serverFailure = outcome; },
    /** A recorded crash: only the main window's page counts. */
    crashed(event) {
      if (event?.kind === "renderer" && event.surface === "main-window" && event.reason !== "clean-exit") stage("page_crashed", { reason: event.reason });
    },
  };
}

/** This app's launch: Electron's own `app` and `session`, and the desktop's kept choices. */
export function desktopLaunchAnalytics({ app, session, prefs, env = process.env }) {
  return createLaunchAnalytics({
    fetch: (...args) => session.defaultSession.fetch(...args), choice: () => prefs.analytics(), lastVersion: readLastRunVersion(app.getPath("userData")),
    version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, env,
  });
}
