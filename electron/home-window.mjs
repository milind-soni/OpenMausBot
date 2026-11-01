// The desktop window once the person's bots moved to My Cloud (one-home.mjs): every path that shows a window goes
// through show(), which opens the place asked for (My Cloud, or a team's Cloud from the verified session), waking My
// Cloud through the Admin and signing in again by itself, or this computer's own screen at HOME_SCREEN_PATH while that
// place can't be reached, its plan has a problem, or this device must sign in again. Until the move is done, and for
// someone with no Cloud, show() is exactly what the app did before, except that a team's Cloud opens the same way.
//
// Security: this computer's frozen copy is never shown once its bots moved, and never lifted for another account or a
// signed-out app (its automations would run twice). The page that counts as home is the main window's main frame at the
// shown place's verified origin, nothing else. A team is only ever one the Admin's session lists, paired through the
// Admin's team pairing (its claims are the Admin's), never an address a page supplied.
import { cloudHomeConnectUrl, cloudSetupOf, cloudUnreachableText, machineSetup, readyCloudOrigin } from "./cloud-home.mjs";
import { cloudMachine, cloudState, otherOwnClouds } from "./cloud-list.mjs";
import { asleepAnswer, BACKGROUND_HEADERS, openSleepingCloud, SIGNED_IN_MS } from "./cloud-power.mjs";
import { awayIn, parseJournal } from "./one-home.mjs";

export const HOME_SCREEN_PATH = "/home";
/** The look at an awake My Cloud before the window moves there: under 3 s, so the offline screen shows within 3 s. */
export const LOOK_MS = 2_500;
/** A place whose page hasn't loaded this long after the window went there (it answered the look, then nothing) is the
 * offline screen, with Try again: never an endless spinner. */
export const OPEN_MS = 30_000;
export const RETRY_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000]);
/** A brand-new Cloud's name can be missing for minutes after the Admin says it is ready: a resolver that was asked while
 * it was set up keeps that "no such name" (RFC 2308 negative caching; Chromium's own host cache does too). For a Cloud
 * ready within FRESH_MS, a name not found keeps the setup screen up and the window tries again on NAME_RETRY_MS, with
 * Chromium's host cache cleared each time, for NAME_WAIT_MS; after that it is the offline screen. */
export const FRESH_MS = 15 * 60_000;
export const NAME_WAIT_MS = 10 * 60_000;
export const NAME_RETRY_MS = Object.freeze([5_000, 10_000, 20_000, 40_000, 60_000]);
/** Chromium's net errors for a name it could not find (net/base/net_error_list.h): NAME_NOT_RESOLVED,
 * NAME_RESOLUTION_FAILED and the DNS range. */
export const nameNotFound = (code) => code === -105 || code === -137 || (code <= -800 && code > -900);
/** A new version of My Cloud's page waits for this long without typing before the window reloads it. */
export const QUIET_MS = 30_000;
export const VERSION_EVERY_MS = 60_000;
/** A home page that loads this soon after the window reloaded it for a newer version is that version. */
export const UPDATING_MS = 30_000;
/** While the startup screen is up, a wake that takes longer hands over to this computer's screen, which says the same. */
export const SPLASH_HANDOFF_MS = 6_000;
export const SPLASH_TEXT = Object.freeze({ opening: "Opening My Cloud…", waking: "Waking My Cloud…" });
/** A team's Cloud ends each session within an hour of its pairing (T2), so the window signs in again before that, without
 * moving the page: every TEAM_RENEW_MS after a pairing, or TEAM_RENEW_EARLY_MS before the end its session reports. The
 * Admin refusing that pairing (404) means the person is no longer in the team. */
export const TEAM_RENEW_MS = 45 * 60_000;
export const TEAM_RENEW_EARLY_MS = 10 * 60_000;
export const TEAM_RENEW_RETRY_MS = 5 * 60_000;
/** The startup screen's line: My Cloud's words, or the team's name. */
export function splashText(status, name = null) {
  return name ? `${status === "waking" ? "Waking" : "Opening"} ${name}…` : SPLASH_TEXT[status];
}
const PLAN_PROBLEMS = new Set(["stopped", "payment-problem", "failed"]);
/** The screens of a listed Cloud that isn't running (`cloudScreen`): nothing to look again for, the session's word moves them. */
const NOT_RUNNING = new Set(["ended", "checkout", "payment"]);
const MOVING = new Set(["freeze", "final", "check"]);
const DEFAULT_TIMERS = {
  set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; },
  clear: (timer) => clearTimeout(timer),
  every: (work, ms) => { const timer = setInterval(work, ms); timer.unref?.(); return timer; },
};

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/**
 * Who the window opens. `journal`: one-home.json read back; `frozenCloud`: this computer's freeze marker when there is no
 * journal (its Cloud's origin, or true when it names none); `state`: the MausBot Cloud sign-in's state.
 * @returns {{ kind: "computer" } | { kind: "cloud", origin: string } | { kind: "signin", other?: true }}
 */
export function homeOf({ journal = null, frozenCloud = null, state = null }) {
  const moved = journal ? (awayIn(journal) ? journal.cloud : null)
    : frozenCloud ? { origin: typeof frozenCloud === "string" ? frozenCloud : null, account: null } : null;
  if (!moved) return { kind: "computer" };
  const connected = state?.status === "connected";
  if (connected && state.machine?.hold) return { kind: "computer" };
  const signedIn = state?.account?.id ?? null;
  if (!signedIn || state.status === "signed-out" || state.status === "connecting") return { kind: "signin" };
  if (moved.account && moved.account !== signedIn) return { kind: "signin", other: true };
  const theirs = connected ? state.machine?.origin ?? null : null;
  const origin = moved.origin ?? theirs;
  if (!origin) return { kind: "signin" };
  if (!moved.account && theirs && theirs !== origin) return { kind: "signin", other: true };
  return { kind: "cloud", origin };
}

/** A place besides My Cloud: a team's Cloud, or another Cloud of the person's own (`own`), each the session's. */
export const otherPlace = (place) => place?.kind === "team" || place?.kind === "own";

/**
 * This computer's screen for a Cloud the session's list says isn't running, so its address is never looked up: it has ended
 * (stopped too; `deleteAt`, when its kept files are deleted), its checkout wasn't finished, or its payment has a problem, each
 * named and with Remove from list while its owner may (`removable`); or its setup's step. Null for one that opens.
 */
export function cloudScreen(cloud) {
  const state = cloudState(cloud);
  if (!state) return null;
  if (state === "setup") return { screen: "setup", ...(cloud.setup?.step ? { step: cloud.setup.step } : {}) };
  return { screen: state, name: cloud.name, ...(state === "ended" && cloud.deleteAfter ? { deleteAt: cloud.deleteAfter } : {}), ...(cloud.removable ? { removable: true } : {}) };
}

/** Another Cloud of the person's own, asked for (`{ cloud }`) or remembered: the session's word, as placeOf reads a team. One
 * the connected session no longer lists is simply My Cloud again; while the Admin can't be asked it opens as it was saved. */
function ownPlaceOf(asked, remembered, state) {
  const id = asked.cloud, cloud = otherOwnClouds(state?.clouds).find((entry) => entry.id === id) ?? null;
  if (cloud) return { kind: "own", id, name: cloud.name, role: cloud.role, origin: cloud.origin, machine: cloudMachine(cloud) };
  if (state?.status === "connected") return { kind: "cloud" };
  const kept = remembered?.cloud === id ? remembered : asked;
  return kept?.origin ? { kind: "own", id, name: kept.name ?? "the Cloud", role: null, origin: kept.origin, machine: null } : { kind: "cloud" };
}

/**
 * The place a window is asked for. `ask`: "cloud" for My Cloud, `{ team }` for a team's Cloud, `{ cloud }` for another
 * Cloud of the person's own, or nothing for the place remembered from last time (`remembered`). A team is read from the
 * verified session (`state.teams`); one the connected session no longer lists is gone, and the answer is My Cloud with
 * the team's name in `left`, so the window can say so once. While the Admin can't be asked, a remembered team opens as
 * it was saved, on the window's own session.
 * @returns {{ kind: "cloud", left?: string | null } | { kind: "team" | "own", id: string, name: string, role: string | null, origin: string | null, machine: any }}
 */
export function placeOf({ ask = null, remembered = null, state = null }) {
  const asked = ask ?? remembered;
  if (asked && asked !== "cloud" && typeof asked.cloud === "string") return ownPlaceOf(asked, remembered, state);
  const id = asked && asked !== "cloud" && typeof asked.team === "string" ? asked.team : null;
  if (!id) return { kind: "cloud" };
  const team = (Array.isArray(state?.teams) ? state.teams : []).find((entry) => entry?.id === id) ?? null;
  if (team) return { kind: "team", id, name: team.name, role: team.role, origin: team.machine?.origin ?? null, machine: team.machine ?? null };
  if (state?.status === "connected") return { kind: "cloud", left: asked.name ?? (remembered?.team === id ? remembered.name : null) ?? null };
  const kept = remembered?.team === id ? remembered : asked;
  return kept?.origin ? { kind: "team", id, name: kept.name ?? "the team", role: null, origin: kept.origin, machine: null } : { kind: "cloud" };
}

/** When this app saw My Cloud become ready after seeing it set up, kept in `store` so a launch soon after knows too. */
export function createReadyClock({ store = null, now = Date.now } = {}) {
  let settingUp = false, kept;
  const read = () => {
    if (kept !== undefined) return kept;
    try { const value = store?.read(); kept = typeof value?.origin === "string" && Number.isSafeInteger(value.readyAt) ? { origin: value.origin, readyAt: value.readyAt } : null; }
    catch { kept = null; }
    return kept;
  };
  return {
    seen(state) {
      if (cloudSetupOf(state)) { settingUp = true; return; }
      const origin = readyCloudOrigin(state);
      if (!origin || !settingUp) return;
      settingUp = false;
      kept = { origin, readyAt: now() };
      try { store?.write(kept); } catch {}
    },
    fresh(origin) {
      const at = read();
      return Boolean(origin) && at?.origin === origin && now() - at.readyAt < FRESH_MS;
    },
  };
}

/** Only a same-origin path survives a sign-in: never another site, never a code. */
export function routeOf(url, origin) {
  try {
    const at = new URL(url);
    if (at.origin !== origin || at.pathname === "/pair") return null;
    const route = `${at.pathname}${at.search}`;
    return route === "/" ? null : route;
  } catch { return null; }
}

/**
 * @param {{
 *   journal(): unknown,
 *   frozen(): Promise<{ frozen: boolean, cloud?: string } | null>,
 *   account(): { state(): any, power(): any, wakeHome(): Promise<unknown>, setWaking(on: boolean): void, pairHome(cloudId?: string | null): Promise<{ origin: string, code: string, expiresAt: number }>,
 *     pairTeam?(teamId: string): Promise<{ origin: string, code: string, expiresAt: number }>, signInAgain(): Promise<unknown>, begin(): Promise<unknown> } | null,
 *   restored?(): Promise<unknown>,
 *   window(): { isDestroyed(): boolean, webContents: { id: number, getURL(): string, reload(): void } } | null,
 *   ensureWindow(): void,
 *   localOrigin(): string,
 *   cookieFetch: typeof fetch,
 *   power: { asleep(): boolean, hold(): void, woke(): void },
 *   go(url: string, origin: string | null, place: { kind: "cloud", origin: string } | { kind: "team" | "own", id: string, name: string, role: string | null, origin: string } | null): Promise<unknown>,
 *   showLocal(leaving: boolean): unknown,
 *   remembered?(): ({ team: string } | { cloud: string }) & { name?: string, origin?: string } | null,
 *   remember?(place: { team: string } | { cloud: string } | null): void,
 *   left?(name: string): void,
 *   drop?(place: { kind: "team" | "own", id: string, name: string }): void,
 *   splash?(): { status(text: string): void } | null,
 *   lastInput?(): number,
 *   publish?(view: unknown): void,
 *   rehomed?(home: { kind: string, origin?: string }): void,
 *   versionEveryMs?: number,
 *   quietMs?: number,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void, every(work: () => void, ms: number): unknown },
 *   hosts?(): { clearHostResolverCache(): Promise<void>, resolveHost(host: string, options?: { cacheUsage?: "allowed" | "staleAllowed" | "disallowed" }): Promise<{ endpoints: unknown[] }> } | null,
 *   readyStore?: { read(): unknown, write(value: unknown): void },
 *   ownMove?(): { phase: string, name: string } | null,
 *   log?(line: string): void,
 * }} deps `ownMove()`: the move to a server of the person's own (own-home-main.mjs), whose freeze is never My Cloud's.
 * `hosts`: the window's Electron session, for its own resolver and host cache. `readyStore`: when My Cloud
 * became ready (createReadyClock). `go(url, origin, place)`: main's one way to move the window, to My Cloud or a team's Cloud (`origin`, with the
 * `place` it is) or this computer's screen (null). `showLocal(leaving)`: the window as it was before the move (this computer's page, or a saved server it
 * shows); `leaving`: it showed a place or this computer's screen until now, so it goes back to this computer's page.
 * `frozen()`: this computer's server's freeze marker. `splash()`: the startup screen while it is up. `remembered()`: the
 * team or other Cloud shown last time, with its name and origin as saved; `remember(place)`: what to open next time;
 * `left(name)`: the team shown is no longer this person's, so the window says so once; `drop(place)`: the Admin said so
 * (404 on its pairing), so the team (with that line) or the Cloud leaves the switcher now. `rehomed(home)`: home as worked
 * out changed.
 */
export function createHomeWindow(deps) {
  const { journal, frozen, account, restored = async () => {}, window, ensureWindow, localOrigin, cookieFetch, power, go, showLocal,
    remembered = () => null, remember = () => {}, left = () => {}, drop = (place) => { if (place.kind === "team") left(place.name); remember(null); },
    splash = () => null, lastInput = () => 0, publish = () => {}, rehomed = () => {}, versionEveryMs = VERSION_EVERY_MS, quietMs = QUIET_MS,
    now = Date.now, timers = DEFAULT_TIMERS, hosts = () => null, readyStore = null, ownMove = () => null, log = () => {} } = deps;
  let home = { kind: "computer" }, screen = null, status = null, opens = 0, retry = null, tries = 0, loaded = null, newer = false, repairing = null;
  /** My Cloud asked for before the move made it home (`{ open }`), until its page loads or the person goes elsewhere;
   * `naming`: since when, and how often, a brand-new My Cloud's name was not found. */
  let asked = null, naming = null;
  const clock = createReadyClock({ store: readyStore, now });
  /** The place the window was last sent to (My Cloud, or a team's Cloud), and the one being opened now. */
  let shown = null, opening = null, renewal = null, updatingAt = null;
  /** The window shows a place or this computer's screen, which this computer's page replaces once home is here again. */
  let away = false;
  const state = () => account()?.state() ?? null;
  const wanted = (token) => token === opens;
  const cloudOrigin = () => (home.kind === "cloud" ? home.origin : null);
  /** The Cloud at `origin` sleeps now: My Cloud by its gate (the Admin's word and its own answer), any other of the
   * person's Clouds by the Admin's word in the Clouds list. A request to a sleeping one would wake it. */
  const asleepAt = (origin) => (origin && origin === cloudOrigin() ? power.asleep() : account()?.powerOf?.(origin)?.state === "asleep");
  /** The origin of the place on screen, or on its way: a team's Cloud while one is shown, else My Cloud. */
  const placeOrigin = () => (otherPlace(shown) ? (signedOut() ? null : shown.origin) : cloudOrigin());
  const teamName = () => (otherPlace(opening) ? opening.name : null);
  const pair = (place) => (place.kind === "team" ? account()?.pairTeam?.(place.id) : place.kind === "own" ? account()?.pairHome(place.id) : account()?.pairHome());
  /** The same place still the one on screen (a newer show() replaces the object, not the place). */
  const still = (place) => shown?.kind === place.kind && shown.id === place.id && shown.origin === place.origin;
  const clearRenewal = () => { if (renewal) timers.clear(renewal); renewal = null; };

  async function refresh() {
    clock.seen(state());
    const kept = parseJournal(journal());
    let frozenCloud = null;
    if (!kept) {
      const marker = await frozen().catch(() => null);
      // A freeze for a server of the person's own names it (`place`): home is that server, shown as any saved server is.
      if (marker?.frozen && !marker.place) frozenCloud = typeof marker.cloud === "string" ? marker.cloud : true;
    }
    if (frozenCloud || awayIn(kept)) await restored();
    const before = home;
    home = homeOf({ journal: kept, frozenCloud, state: state() });
    if (home.kind !== before.kind || home.origin !== before.origin) {
      try { rehomed(home); } catch {}
    }
    return home;
  }

  /** What this computer's screen says: why the place isn't open, or that it is opening; `name` while it is a team's. */
  function view() {
    const name = teamName();
    const named = (value) => (name ? { ...value, name } : value);
    if (screen) return named(screen);
    if (status) return named({ screen: status });
    if (home.kind === "signin" && !name) return { screen: "signin" };
    const own = ownMove();
    if (own && MOVING.has(own.phase)) return { screen: "moving", name: own.name };
    return named({ screen: MOVING.has(parseJournal(journal())?.phase ?? "") ? "moving" : "opening" });
  }
  const tell = () => { try { publish(view()); } catch {} };
  let splashSaid = null;
  const onSplash = (text) => {
    if (text === splashSaid) return;
    splashSaid = text;
    try { splash()?.status(text); } catch {}
  };
  function say(next) {
    status = next;
    if (next) onSplash(splashText(next, teamName()));
    tell();
  }
  const shows = (origin) => {
    const win = window();
    return Boolean(win && !win.isDestroyed()) && originOf(win.webContents.getURL()) === origin;
  };
  const onScreen = () => {
    const win = window();
    if (!win || win.isDestroyed()) return false;
    try { const at = new URL(win.webContents.getURL()); return at.origin === localOrigin() && at.pathname === HOME_SCREEN_PATH; } catch { return false; }
  };
  const clearRetry = () => { if (retry) timers.clear(retry); retry = null; };

  function goScreen() {
    tell();
    away = true;
    if (!onScreen()) void Promise.resolve(go(`${localOrigin()}${HOME_SCREEN_PATH}`, null, null)).catch(() => {});
  }
  /** The place can't be shown now: this computer's screen says why, and the startup screen, while it is up, that the place
   * is opening. */
  function toScreen(next) {
    screen = next;
    status = null;
    onSplash(splashText("opening", teamName()));
    goScreen();
  }

  /** The place didn't answer: this computer's screen says so, with the Admin's reason for My Cloud, and looks again by itself. */
  function offline(token) {
    if (!wanted(token)) return;
    const reason = otherPlace(opening) ? null : cloudUnreachableText(state(), cloudOrigin());
    toScreen({ screen: "offline", ...(reason ? { reason } : {}) });
    later();
  }
  function later(delays = RETRY_MS, count = () => tries++) {
    clearRetry();
    const ms = delays[Math.min(count(), delays.length - 1)];
    retry = timers.set(() => { retry = null; if (screen) void show(); }, ms);
  }
  /** Whether the window's own resolver finds `origin`'s name now, its host cache bypassed. */
  async function found(origin) {
    const resolver = hosts();
    if (!resolver) return true;
    const slow = new Promise((done) => { const timer = setTimeout(() => done(null), 2 * LOOK_MS); timer.unref?.(); });
    try { return (await Promise.race([resolver.resolveHost(new URL(origin).hostname, { cacheUsage: "disallowed" }), slow]))?.endpoints?.length > 0; }
    catch { return false; }
  }
  const forgetNames = () => Promise.resolve().then(() => hosts()?.clearHostResolverCache()).catch(() => {});
  /** My Cloud didn't answer: a brand-new one whose name isn't found yet is still settling in (the setup screen, tried
   * again sooner, for NAME_WAIT_MS); anything else is the offline screen. */
  async function unreachable(place, token, missing = null) {
    if (place.kind !== "cloud" || !(naming || clock.fresh(place.origin)) || (missing ?? !(await found(place.origin))) === false) return offline(token);
    if (!wanted(token)) return;
    naming ??= { since: now(), tries: 0 };
    if (now() - naming.since >= NAME_WAIT_MS) return offline(token);
    log(`home: My Cloud's name isn't found yet; trying again (${naming.tries + 1})`);
    toScreen({ screen: "setup", step: "checking" });
    later(NAME_RETRY_MS, () => naming.tries++);
  }
  /** The person went somewhere else while My Cloud was asked for: nothing pulls the window back. */
  function letAskGo() {
    asked = null; naming = null; screen = null; status = null; away = false;
    clearRetry();
  }
  const signInNeeded = () => ["reauth-required", "signed-out"].includes(state()?.status);
  /** This device has no MausBot Cloud sign-in to pair a team with (homeOf's rule for My Cloud). */
  const signedOut = () => { const current = state(); return !current?.account?.id || ["signed-out", "connecting"].includes(current.status); };
  /** The session's list's word for My Cloud (the account's primary Cloud), else null: an older Admin, or one it doesn't list. */
  const myListed = () => { const current = state(); return current?.status === "connected" && Array.isArray(current.clouds) ? current.clouds.find((cloud) => cloud.primary) ?? null : null; };
  /** My Cloud's own screen while the session says it isn't running: its list's word (`cloudScreen`) when the Admin sends a list
   * (none for a My Cloud off it: its owner removed it from their list), else its machine's (an older Admin). Null while it
   * runs or is set up: those open as before. */
  function myCloudScreen() {
    const current = state();
    if (current?.status !== "connected") return null;
    if (Array.isArray(current.clouds)) { const listed = cloudScreen(myListed()); return listed && listed.screen !== "setup" ? listed : null; }
    return current.machine && PLAN_PROBLEMS.has(current.machine.status) ? { screen: "plan", machine: current.machine.status } : null;
  }
  /** The session says My Cloud isn't running (its screen says so, or it was removed from the list): never looked up then. */
  const notRunning = () => Boolean(myCloudScreen()) || (state()?.status === "connected" && PLAN_PROBLEMS.has(state().machine?.status));

  async function answers(origin) {
    try {
      const response = await cookieFetch(`${origin}/api/health`, { credentials: "include", cache: "no-store", redirect: "manual",
        signal: AbortSignal.timeout(LOOK_MS), headers: { accept: "application/json", ...BACKGROUND_HEADERS } });
      await response.body?.cancel?.().catch(() => {});
      if (asleepAnswer(response)) return "asleep";
      return response.type === "opaqueredirect" || response.status < 500 ? "yes" : "no";
    } catch { return "no"; }
  }
  /** The window's own session there: `{ expiresAt }` (null when the server names no end), or null when it has none. */
  async function sessionAt(origin, timeoutMs) {
    try {
      const response = await cookieFetch(`${origin}/api/auth/session`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      const body = response.ok ? await response.json() : null;
      return body?.kind === "session" ? { expiresAt: Number.isSafeInteger(body.expiresAt) ? body.expiresAt : null } : null;
    } catch { return null; }
  }
  const signedInAt = async (origin, timeoutMs) => Boolean(await sessionAt(origin, timeoutMs));
  /** A one-time code redeemed into the window's own cookie, as lending does for My Cloud: the page doesn't move. */
  async function redeem(origin, grant) {
    try {
      const response = await cookieFetch(`${origin}/api/auth/pair`, { method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", origin }, body: JSON.stringify({ code: grant.code, cookie: true, label: "OpenMausBot app" }) });
      await response.body?.cancel?.().catch(() => {});
      return response.ok;
    } catch { return false; }
  }
  /** The next silent sign-in to the team on screen: `ends`, the end its session reports, else TEAM_RENEW_MS from now. */
  function renewLater(place, ms) {
    clearRenewal();
    renewal = timers.set(() => { renewal = null; void renew(place); }, Math.max(0, Math.min(ms, TEAM_RENEW_MS)));
  }
  /** The team on screen signs in again before its session ends, without moving the page; the Admin refusing means the
   * person was removed. Nothing happens for a team that is no longer on screen. */
  async function renew(place = shown) {
    clearRenewal();
    if (place?.kind !== "team" || !still(place) || !shows(place.origin)) return;
    let grant = null;
    try { grant = await pair(place); } catch (error) {
      if (error?.gone) { if (still(place)) await gone(place); return; }
      log(`home: could not sign in to ${place.name} again (${error?.message ?? error})`);
    }
    if (!still(place)) return;
    renewLater(place, grant && await redeem(place.origin, grant) ? TEAM_RENEW_MS : TEAM_RENEW_RETRY_MS);
  }

  /** The Admin says the team is no longer this person's: it leaves the switcher now, and My Cloud opens with one line. */
  function gone(place) {
    drop(place);
    clearRenewal();
    if (shown?.kind === place.kind && shown.id === place.id) shown = null;
    return show({ place: "cloud" });
  }

  async function connect(place, token, open) {
    const origin = place.origin;
    // Only a window this opened as home is left as it is: one that shows My Cloud as a saved server (opened from the
    // switcher before the move) is opened again as home, and goes home with it if My Cloud ends.
    if (shows(origin) && away && !screen && !open) {
      shown = place;
      if (place.kind === "team" && !renewal) renewLater(place, TEAM_RENEW_MS);
      return;
    }
    clearRetry();
    opening = place;
    const client = account();
    const machine = otherPlace(place) ? place.machine : state()?.status === "connected" ? state().machine : null;
    // My Cloud the session's list says isn't running: its own screen, never its address, and nothing to look again for.
    const listed = place.kind === "cloud" ? cloudScreen(myListed()) : null;
    if (listed && NOT_RUNNING.has(listed.screen)) { clearRetry(); return toScreen(listed); }
    if (machine && (PLAN_PROBLEMS.has(machine.status) || (place.kind === "team" && machine.hold))) {
      toScreen({ screen: "plan", machine: PLAN_PROBLEMS.has(machine.status) ? machine.status : "stopped" }); later(); return;
    }
    // Its address is never looked up while it is set up: the session's next word (changed()) opens it.
    const setup = machineSetup(machine);
    if (setup) return toScreen({ screen: "setup", ...setup });
    const win = window();
    const blank = !win || win.isDestroyed() || !originOf(win.webContents.getURL());
    // A team's Cloud never sleeps, and the Admin wakes only My Cloud: a team that answers asleep is simply not reachable yet.
    let asleep = place.kind === "cloud" && power.asleep();
    say(asleep ? "waking" : "opening");
    const handoff = blank ? timers.set(() => { if (wanted(token) && status) goScreen(); }, SPLASH_HANDOFF_MS) : null;
    try {
      if (!asleep) {
        if (naming) await forgetNames();
        const look = await answers(origin);
        if (look === "no") return unreachable(place, token);
        if (look === "asleep" && otherPlace(place)) return offline(token);
        if (look === "asleep") { power.hold(); asleep = true; say("waking"); }
      }
      let session = null;
      const signedIn = asleep
        ? await openSleepingCloud({ power: client?.power() ?? { state: "asleep" }, wake: () => client?.wakeHome(), waking: (on) => client?.setWaking(on), signedIn: (ms) => signedInAt(origin, ms) })
        : Boolean(session = await sessionAt(origin, SIGNED_IN_MS));
      if (!wanted(token)) return;
      let grant = null;
      if (!signedIn) {
        try { grant = await pair(place); } catch (error) {
          if (error?.gone && wanted(token)) return gone(place);
          log(`home: no sign-in code for ${otherPlace(place) ? place.name : "My Cloud"} (${error?.message ?? error})`);
        }
        if (!wanted(token)) return;
        if (!grant) {
          if (signInNeeded()) return toScreen({ screen: "signin" });
          return offline(token);
        }
      }
      // My Cloud opened before the move made it home is a saved server the window shows, as the Server menu opens one.
      const asHome = otherPlace(place) || home.kind !== "computer";
      screen = null; status = null; tries = 0; away = asHome; shown = asHome ? place : null;
      // A page that never finishes loading is the offline screen after OPEN_MS, which looks again by itself and has Try again.
      let slow = null;
      const loaded = await Promise.race([Promise.resolve(go(cloudHomeConnectUrl({ origin, grant }, now(), open === "phone" ? "phone" : null), origin, place)).then(() => true, () => true),
        new Promise((done) => { slow = timers.set(() => done(false), OPEN_MS); })]);
      timers.clear(slow);
      if (!loaded) { log(`home: ${otherPlace(place) ? place.name : "My Cloud"} didn't load in ${OPEN_MS / 1000} s`); return offline(token); }
      if (place.kind === "cloud") { clearRenewal(); power.woke(); }
      else if (place.kind === "team") renewLater(place, grant || !session?.expiresAt ? TEAM_RENEW_MS : session.expiresAt - now() - TEAM_RENEW_EARLY_MS);
      else clearRenewal();
      tell();
    } finally {
      if (handoff) timers.clear(handoff);
    }
  }

  /** Shows the window onto the person's home. `open: "phone"` opens My Cloud's Settings on its phone pairing. `place`:
   * "cloud" for My Cloud, `{ team }` for a team's Cloud, `{ cloud }` for another of the person's own, else the place
   * remembered from last time. */
  async function show({ open = null, place = null } = {}) {
    const token = ++opens;
    const current = await refresh();
    if (!wanted(token)) return;
    const target = placeOf({ ask: place, remembered: remembered(), state: state() });
    if (target.kind === "cloud" && target.left) { left(target.left); remember(null); }
    if (otherPlace(target)) {
      ensureWindow();
      opening = target;
      // Chosen is remembered at once, so the screen's own retry (and the next launch) asks for the same place.
      remember(target.kind === "own" ? { cloud: target.id } : { team: target.id });
      if (signedOut()) { clearRetry(); return toScreen({ screen: "signin" }); }
      // Another Cloud of their own that the session's list says isn't running: its own screen, never its address.
      const listed = target.kind === "own" ? cloudScreen(otherOwnClouds(state()?.clouds).find((cloud) => cloud.id === target.id)) : null;
      if (listed && NOT_RUNNING.has(listed.screen)) { clearRetry(); return toScreen(listed); }
      const setup = machineSetup(target.machine);
      if (setup) { clearRetry(); return toScreen({ screen: "setup", ...setup }); }
      if (!target.origin) { toScreen({ screen: "plan", machine: target.machine?.status ?? "stopped" }); later(); return; }
      return connect(target, token, open);
    }
    if (place === "cloud" || target.left) remember(null);
    opening = null;
    clearRenewal();
    if (current.kind === "computer" && asked) {
      const setup = cloudSetupOf(state()), mine = readyCloudOrigin(state()), stopped = setup || mine ? null : myCloudScreen();
      if (setup || mine || stopped) ensureWindow();
      if (setup) { clearRetry(); return toScreen({ screen: "setup", ...setup }); }
      if (mine) return connect({ kind: "cloud", origin: mine }, token, open ?? asked.open);
      // Not running (it ended, its checkout wasn't finished, a payment problem): its own screen, never its address.
      if (stopped) { clearRetry(); return toScreen(stopped); }
      asked = null; naming = null;
    }
    if (current.kind === "computer") {
      clearRetry(); screen = null; status = null; shown = null;
      const win = window();
      const leaving = away || Boolean(win && !win.isDestroyed() && !originOf(win.webContents.getURL()));
      away = false;
      return showLocal(leaving);
    }
    ensureWindow();
    if (current.kind === "signin") { clearRetry(); return toScreen({ screen: "signin", ...(current.other ? { other: true } : {}) }); }
    return connect({ kind: "cloud", origin: current.origin }, token, open);
  }

  /** The place's session in this window ended: a new one by itself, back where the page was. */
  function repair() {
    const place = shown ?? (home.kind === "cloud" ? { kind: "cloud", origin: home.origin } : null);
    if (repairing || !place) return repairing ?? Promise.resolve();
    const origin = place.origin;
    repairing = (async () => {
      if (await signedInAt(origin, SIGNED_IN_MS)) return;
      const win = window();
      const route = win && !win.isDestroyed() ? routeOf(win.webContents.getURL(), origin) : null;
      let grant = null;
      try { grant = await pair(place); } catch (error) {
        if (error?.gone) return gone(place);
        log(`home: could not sign in to ${otherPlace(place) ? place.name : "My Cloud"} again (${error?.message ?? error})`);
      }
      if (placeOrigin() !== origin) return;
      if (!grant) return signInNeeded() ? toScreen({ screen: "signin" }) : offline(++opens);
      await go(cloudHomeConnectUrl({ origin, grant }, now(), null, route), origin, place);
    })().finally(() => { repairing = null; });
    return repairing;
  }

  async function version(origin) {
    try {
      const response = await cookieFetch(`${origin}/.well-known/openmausbot/environment`, { cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(LOOK_MS), headers: { accept: "application/json", ...BACKGROUND_HEADERS } });
      const body = response.ok ? await response.json() : null;
      return typeof body?.version === "string" ? body.version : null;
    } catch { return null; }
  }
  /** A newer page reloads at a quiet moment; a Cloud asleep is never asked (that would start it). */
  async function watchVersion() {
    const origin = placeOrigin();
    if (!origin || !shows(origin) || asleepAt(origin)) return;
    const current = await version(origin);
    if (!current) return;
    if (!loaded) { loaded = current; return; }
    if (current !== loaded) newer = true;
    if (!newer || now() - lastInput() < quietMs || !shows(origin)) return;
    newer = false; loaded = current; updatingAt = now();
    window()?.webContents.reload();
  }
  const watcher = timers.every(() => { void watchVersion(); }, versionEveryMs);
  function homePage(event) {
    const origin = placeOrigin(), win = window();
    if (!origin || !win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
    return originOf(event.senderFrame.url) === origin;
  }

  return {
    show,
    /** The person asked for My Cloud (the Server menu, the welcome, Settings, the ready notice). Before the move made it
     * home it opens as a saved server, and while the Admin sets it up the setup screen shows until it opens by itself. */
    async openCloud(open = null) {
      if ((await refresh()).kind !== "computer") return show({ place: "cloud", open });
      if (!cloudSetupOf(state()) && !readyCloudOrigin(state()) && !notRunning()) throw new Error("My Cloud is not ready to connect yet.");
      asked = { open };
      return show({ place: "cloud", open });
    },
    /** Remove from list, from this computer's screen (its own button, once the person said yes there): the Cloud the screen
     * shows leaves their list on the Admin (cloud-account.mjs hideCloud), and the window goes where it would without it.
     * Answers the outcome; nothing is asked of a Cloud the session doesn't say is `removable`. */
    async remove() {
      const own = opening?.kind === "own" ? opening : null, cloudId = own ? own.id : myListed()?.id ?? null;
      const cloud = cloudId ? (state()?.clouds ?? []).find((entry) => entry.id === cloudId) ?? null : null;
      if (!cloud?.removable || !screen?.removable) return "unsupported";
      const client = account();
      const outcome = client?.hideCloud ? (await client.hideCloud(cloudId).catch(() => ({ outcome: "failed" }))).outcome : "unsupported";
      if (outcome !== "removed" && outcome !== "gone") return outcome;
      if (own) { if (opening === own) opening = null; drop(own); } else { asked = null; naming = null; }
      screen = null; status = null; clearRetry();
      await show({ place: "cloud" });
      return outcome;
    },
    /** My Cloud is asked for and not open yet: the window shows this computer's screen for it. */
    asking: () => Boolean(asked),
    refresh,
    view,
    /** My Cloud's origin while it is home, else null. */
    cloudOrigin,
    /** Whether the Cloud at `origin` sleeps now (see `asleepAt`): nothing in the background asks it then. */
    asleepAt,
    /** The origin of the place the window shows (a team's Cloud, or My Cloud), else null. */
    placeOrigin,
    /** Home as last worked out. */
    current: () => home,
    /** The place the window was last sent to: My Cloud, or a team's or another own Cloud (`{ kind: "team" | "own", id, name, origin }`). */
    shown: () => shown,
    /** The person asked again (the screen's timer, back online, or the window focused). */
    retry: () => show(),
    /** The screen's one button: this device's MausBot Cloud sign-in, again. */
    async signIn() {
      const client = account();
      if (!client) return;
      await (client.state().status === "reauth-required" ? client.signInAgain() : client.begin());
    },
    repair,
    /** The MausBot Cloud sign-in changed: a window that waits on it, a home that changed, or a team shown that the
     * session no longer lists (or lists at another address), shows again. */
    async changed() {
      const before = home;
      const after = await refresh();
      const next = shown && shows(shown.origin) ? placeOf({ remembered: remembered(), state: state() }) : null;
      const moved = Boolean(next && (next.kind !== shown.kind || (next.origin ?? null) !== (shown.origin ?? null) || (next.id ?? null) !== (shown.id ?? null)));
      if (moved || after.kind !== before.kind || after.origin !== before.origin || screen || status) await show();
    },
    /** A response the window got (Electron's webRequest): a 401 from the place's API means its session ended. */
    responded({ url, statusCode, webContentsId }) {
      const origin = placeOrigin(), win = window();
      if (statusCode !== 401 || !origin || !win || win.isDestroyed() || webContentsId !== win.webContents.id) return;
      try { const at = new URL(url); if (at.origin !== origin || !at.pathname.startsWith("/api/")) return; } catch { return; }
      // The place's own sign-in page is the new session on its way: its 401s until it redeems the code start nothing.
      try { const page = new URL(win.webContents.getURL()); if (page.origin === origin && page.pathname === "/pair") return; } catch {}
      void repair();
    },
    /** The main frame went somewhere: the place's own sign-in page means its session ended; any other page of it is
     * the version the window now shows. */
    navigated(url) {
      // Only a page that loaded counts: an error page (chrome-error:) is the load that failed().
      if (asked && /^https?:/.test(url)) {
        const at = originOf(url);
        if (at === readyCloudOrigin(state())) { asked = null; naming = null; }
        else if (!(at === localOrigin() && new URL(url).pathname === HOME_SCREEN_PATH)) letAskGo();
      }
      // The window went to another server (the Server menu): the team it showed is no longer the place on screen.
      if (otherPlace(shown) && ![shown.origin, localOrigin()].includes(originOf(url))) { shown = null; clearRenewal(); }
      const origin = placeOrigin();
      if (!origin || originOf(url) !== origin) return;
      const at = new URL(url);
      if (at.pathname === "/pair" && !/[#&]code=/.test(at.hash)) { void repair(); return; }
      newer = false; loaded = null;
      void version(origin).then((current) => { if (current && placeOrigin() === origin) loaded = current; });
    },
    /** The main frame could not load the place, or My Cloud before it is home (Chromium's net error `code`): this
     * computer's screen says so and the window tries again by itself. False for any other server. */
    failed(url, code = 0) {
      const at = originOf(url), place = placeOrigin(), mine = readyCloudOrigin(state());
      if (!at || (at !== place && (home.kind !== "computer" || at !== mine))) return false;
      if (at !== place) asked ??= { open: null };
      const token = ++opens;
      void unreachable(otherPlace(shown) && at === place ? shown : { kind: "cloud", origin: at }, token, nameNotFound(code));
      return true;
    },
    /** `event` came from the shown place's own page in this window (My Cloud's while it is home, or a team's Cloud's). */
    homePage,
    updating(event) {
      if (!homePage(event)) return false;
      const reloaded = updatingAt !== null && now() - updatingAt < UPDATING_MS;
      updatingAt = null;
      return reloaded;
    },
    /** `event` came from this computer's screen in this window. */
    screenPage(event) {
      const win = window();
      if (!win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
      return originOf(event.senderFrame.url) === localOrigin();
    },
    /** Signs the team on screen in again now, without moving the page (the timer's own step; also for tests). */
    renew: () => renew(),
    close() { opens++; clearRetry(); clearRenewal(); timers.clear(watcher); },
  };
}

/** The window's IPC: this computer's screen reads why the place isn't open and asks again; the place's own page, while
 * it is shown, asks for a new session; either asks this device's sign-in again (from the person's click on My Cloud). */
export function installHomeWindowIpc({ ipcMain, homeWindow, cloudPage }) {
  const from = (channel, allowed, handler) => (event, ...args) => {
    if (!allowed(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(...args);
  };
  const screenPage = (event) => homeWindow.screenPage(event);
  ipcMain.handle("home:state", from("home:state", screenPage, () => homeWindow.view()));
  ipcMain.handle("home:retry", from("home:retry", screenPage, () => homeWindow.retry().then(() => homeWindow.view())));
  ipcMain.handle("home:remove", from("home:remove", screenPage, () => homeWindow.remove()));
  ipcMain.handle("home:sign-in", from("home:sign-in", (event) => screenPage(event) || cloudPage(event) === "cloud" || (homeWindow.homePage(event) && homeWindow.shown()?.kind === "own"), () => homeWindow.signIn()));
  ipcMain.handle("home:repair", from("home:repair", (event) => homeWindow.homePage(event), () => homeWindow.repair()));
  ipcMain.on("home:page", (event) => { try { event.returnValue = homeWindow.homePage(event); } catch { event.returnValue = false; } });
  ipcMain.on("home:updating", (event) => { try { event.returnValue = homeWindow.updating(event); } catch { event.returnValue = false; } });
}
