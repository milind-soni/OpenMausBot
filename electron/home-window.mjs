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
import { cloudHomeConnectUrl, cloudUnreachableCause, cloudUnreachableText } from "./cloud-home.mjs";
import { asleepAnswer, BACKGROUND_HEADERS, openSleepingCloud, SIGNED_IN_MS } from "./cloud-power.mjs";
import nativeText from "./native-text.cjs";
import { parseJournal } from "./one-home.mjs";

export const HOME_SCREEN_PATH = "/home";
/** The look at an awake My Cloud before the window moves there: under 3 s, so the offline screen shows within 3 s. */
export const LOOK_MS = 2_500;
export const RETRY_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000]);
/** A new version of My Cloud's page waits for this long without typing before the window reloads it. */
export const QUIET_MS = 30_000;
export const VERSION_EVERY_MS = 60_000;
/** While the startup screen is up, a wake that takes longer hands over to this computer's screen, which says the same. */
export const SPLASH_HANDOFF_MS = 6_000;
/** A team's Cloud ends each session within an hour of its pairing (T2), so the window signs in again before that, without
 * moving the page: every TEAM_RENEW_MS after a pairing, or TEAM_RENEW_EARLY_MS before the end its session reports. The
 * Admin refusing that pairing (404) means the person is no longer in the team. */
export const TEAM_RENEW_MS = 45 * 60_000;
export const TEAM_RENEW_EARLY_MS = 10 * 60_000;
export const TEAM_RENEW_RETRY_MS = 5 * 60_000;
const SPLASH_KEYS = Object.freeze({
  opening: ["native.splash.openingCloud", "native.splash.openingNamed"], waking: ["native.splash.wakingCloud", "native.splash.wakingNamed"],
});
/** The startup screen's line: My Cloud's words, or the team's name. */
export function splashText(status, name = null, t = nativeText.englishText.t) {
  const [cloud, named] = SPLASH_KEYS[status === "waking" ? "waking" : "opening"];
  return name ? t(named, { name }) : t(cloud);
}
export const SPLASH_TEXT = Object.freeze({ opening: splashText("opening"), waking: splashText("waking") });
const PLAN_PROBLEMS = new Set(["stopped", "payment-problem", "failed"]);
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
  const moved = journal ? (["switch", "done"].includes(journal.phase) ? journal.cloud : null)
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

/**
 * The place a window is asked for. `ask`: "cloud" for My Cloud, `{ team }` for a team's Cloud, or nothing for the place
 * remembered from last time (`remembered`). A team is read from the verified session (`state.teams`); one the connected
 * session no longer lists is gone, and the answer is My Cloud with the team's name in `left`, so the window can say so
 * once. While the Admin can't be asked, a remembered team opens as it was saved, on the window's own session.
 * @returns {{ kind: "cloud", left?: string | null } | { kind: "team", id: string, name: string, role: string | null, origin: string | null, machine: any }}
 */
export function placeOf({ ask = null, remembered = null, state = null }) {
  const asked = ask ?? remembered;
  const id = asked && asked !== "cloud" && typeof asked.team === "string" ? asked.team : null;
  if (!id) return { kind: "cloud" };
  const team = (Array.isArray(state?.teams) ? state.teams : []).find((entry) => entry?.id === id) ?? null;
  if (team) return { kind: "team", id, name: team.name, role: team.role, origin: team.machine?.origin ?? null, machine: team.machine ?? null };
  if (state?.status === "connected") return { kind: "cloud", left: asked.name ?? (remembered?.team === id ? remembered.name : null) ?? null };
  const kept = remembered?.team === id ? remembered : asked;
  return kept?.origin ? { kind: "team", id, name: kept.name ?? "the team", role: null, origin: kept.origin, machine: null } : { kind: "cloud" };
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
 *   account(): { state(): any, power(): any, wakeHome(): Promise<unknown>, setWaking(on: boolean): void, pairHome(): Promise<{ origin: string, code: string, expiresAt: number }>,
 *     pairTeam?(teamId: string): Promise<{ origin: string, code: string, expiresAt: number }>, signInAgain(): Promise<unknown>, begin(): Promise<unknown> } | null,
 *   restored?(): Promise<unknown>,
 *   window(): { isDestroyed(): boolean, webContents: { id: number, getURL(): string, reload(): void } } | null,
 *   ensureWindow(): void,
 *   localOrigin(): string,
 *   cookieFetch: typeof fetch,
 *   power: { asleep(): boolean, hold(): void, woke(): void },
 *   go(url: string, origin: string | null, place: { kind: "cloud", origin: string } | { kind: "team", id: string, name: string, role: string | null, origin: string } | null): Promise<unknown>,
 *   showLocal(leaving: boolean): unknown,
 *   remembered?(): { team: string, name?: string, origin?: string } | null,
 *   remember?(place: { team: string } | null): void,
 *   left?(name: string): void,
 *   drop?(place: { id: string, name: string }): void,
 *   splash?(): { status(text: string): void } | null,
 *   lastInput?(): number,
 *   publish?(view: unknown): void,
 *   versionEveryMs?: number,
 *   quietMs?: number,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void, every(work: () => void, ms: number): unknown },
 *   log?(line: string): void,
 *   t?(key: string, params?: Record<string, string | number>): string,
 * }} deps `go(url, origin, place)`: main's one way to move the window, to My Cloud or a team's Cloud (`origin`, with the
 * `place` it is) or this computer's screen (null). `showLocal(leaving)`: the window as it was before the move (this computer's page, or a saved server it
 * shows); `leaving`: it showed a place or this computer's screen until now, so it goes back to this computer's page.
 * `frozen()`: this computer's server's freeze marker. `splash()`: the startup screen while it is up. `remembered()`: the
 * team shown last time, with its name and origin as saved; `remember(place)`: what to open next time; `left(name)`: the
 * team shown is no longer this person's, so the window says so once; `drop(place)`: the Admin said so (404 on its team
 * pairing), so the team leaves the switcher now, with that line.
 */
export function createHomeWindow(deps) {
  const { journal, frozen, account, restored = async () => {}, window, ensureWindow, localOrigin, cookieFetch, power, go, showLocal,
    remembered = () => null, remember = () => {}, left = () => {}, drop = (place) => { left(place.name); remember(null); },
    splash = () => null, lastInput = () => 0, publish = () => {}, versionEveryMs = VERSION_EVERY_MS, quietMs = QUIET_MS,
    now = Date.now, timers = DEFAULT_TIMERS, log = () => {}, t = nativeText.englishText.t } = deps;
  let home = { kind: "computer" }, screen = null, status = null, opens = 0, retry = null, tries = 0, loaded = null, newer = false, repairing = null;
  /** The place the window was last sent to (My Cloud, or a team's Cloud), and the one being opened now. */
  let shown = null, opening = null, renewal = null;
  /** The window shows a place or this computer's screen, which this computer's page replaces once home is here again. */
  let away = false;
  const state = () => account()?.state() ?? null;
  const wanted = (token) => token === opens;
  const cloudOrigin = () => (home.kind === "cloud" ? home.origin : null);
  /** The origin of the place on screen, or on its way: a team's Cloud while one is shown, else My Cloud. */
  const placeOrigin = () => (shown?.kind === "team" ? (signedOut() ? null : shown.origin) : cloudOrigin());
  const teamName = () => (opening?.kind === "team" ? opening.name : null);
  const pair = (place) => (place.kind === "team" ? account()?.pairTeam?.(place.id) : account()?.pairHome());
  /** The same team still the place on screen (a newer show() replaces the object, not the team). */
  const still = (place) => shown?.kind === "team" && shown.id === place.id && shown.origin === place.origin;
  const clearRenewal = () => { if (renewal) timers.clear(renewal); renewal = null; };

  async function refresh() {
    const kept = parseJournal(journal());
    let frozenCloud = null;
    if (!kept) {
      const marker = await frozen().catch(() => null);
      if (marker?.frozen) frozenCloud = typeof marker.cloud === "string" ? marker.cloud : true;
    }
    if (frozenCloud || (kept && ["switch", "done"].includes(kept.phase))) await restored();
    home = homeOf({ journal: kept, frozenCloud, state: state() });
    return home;
  }

  /** What this computer's screen says: why the place isn't open, or that it is opening; `name` while it is a team's. */
  function view() {
    const name = teamName();
    const named = (value) => (name ? { ...value, name } : value);
    if (screen) return named(screen);
    if (status) return named({ screen: status });
    if (home.kind === "signin" && !name) return { screen: "signin" };
    return named({ screen: MOVING.has(parseJournal(journal())?.phase ?? "") ? "moving" : "opening" });
  }
  const tell = () => { try { publish(view()); } catch {} };
  function say(next) {
    status = next;
    if (next) { try { splash()?.status(splashText(next, teamName(), t)); } catch {} }
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
  function toScreen(next) {
    screen = next;
    status = null;
    goScreen();
  }

  /** The place didn't answer: this computer's screen says so, with the Admin's reason for My Cloud, and looks again by itself. */
  function offline(token) {
    if (!wanted(token)) return;
    const cause = opening?.kind === "team" ? null : cloudUnreachableCause(state(), cloudOrigin());
    toScreen({ screen: "offline", ...(cause ? { reason: cloudUnreachableText(state(), cloudOrigin()), cause } : {}) });
    later();
  }
  function later() {
    clearRetry();
    const ms = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)];
    tries += 1;
    retry = timers.set(() => { retry = null; if (screen) void show(); }, ms);
  }
  const signInNeeded = () => ["reauth-required", "signed-out"].includes(state()?.status);
  /** This device has no MausBot Cloud sign-in to pair a team with (homeOf's rule for My Cloud). */
  const signedOut = () => { const current = state(); return !current?.account?.id || ["signed-out", "connecting"].includes(current.status); };

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
    if (shown?.kind === "team" && shown.id === place.id) shown = null;
    return show({ place: "cloud" });
  }

  async function connect(place, token, open) {
    const origin = place.origin;
    if (shows(origin) && !screen && !open) {
      shown = place;
      if (place.kind === "team" && !renewal) renewLater(place, TEAM_RENEW_MS);
      return;
    }
    clearRetry();
    opening = place;
    const client = account();
    const machine = place.kind === "team" ? place.machine : state()?.status === "connected" ? state().machine : null;
    if (machine && (PLAN_PROBLEMS.has(machine.status) || (place.kind === "team" && machine.hold))) {
      toScreen({ screen: "plan", machine: PLAN_PROBLEMS.has(machine.status) ? machine.status : "stopped" }); later(); return;
    }
    const win = window();
    const blank = !win || win.isDestroyed() || !originOf(win.webContents.getURL());
    // A team's Cloud never sleeps, and the Admin wakes only My Cloud: a team that answers asleep is simply not reachable yet.
    let asleep = place.kind === "cloud" && power.asleep();
    say(asleep ? "waking" : "opening");
    const handoff = blank ? timers.set(() => { if (wanted(token) && status) goScreen(); }, SPLASH_HANDOFF_MS) : null;
    try {
      if (!asleep) {
        const look = await answers(origin);
        if (look === "no" || (look === "asleep" && place.kind === "team")) return offline(token);
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
          log(`home: no sign-in code for ${place.kind === "team" ? place.name : "My Cloud"} (${error?.message ?? error})`);
        }
        if (!wanted(token)) return;
        if (!grant) {
          if (signInNeeded()) return toScreen({ screen: "signin" });
          return offline(token);
        }
      }
      screen = null; status = null; tries = 0; away = true; shown = place;
      await go(cloudHomeConnectUrl({ origin, grant }, now(), open === "phone" ? "phone" : null), origin, place);
      if (place.kind === "cloud") { clearRenewal(); power.woke(); }
      else renewLater(place, grant || !session?.expiresAt ? TEAM_RENEW_MS : session.expiresAt - now() - TEAM_RENEW_EARLY_MS);
      tell();
    } finally {
      if (handoff) timers.clear(handoff);
    }
  }

  /** Shows the window onto the person's home. `open: "phone"` opens My Cloud's Settings on its phone pairing. `place`:
   * "cloud" for My Cloud, `{ team }` for a team's Cloud, else the place remembered from last time. */
  async function show({ open = null, place = null } = {}) {
    const token = ++opens;
    const current = await refresh();
    if (!wanted(token)) return;
    const target = placeOf({ ask: place, remembered: remembered(), state: state() });
    if (target.kind === "cloud" && target.left) { left(target.left); remember(null); }
    if (target.kind === "team") {
      ensureWindow();
      opening = target;
      // Chosen is remembered at once, so the screen's own retry (and the next launch) asks for the same team.
      remember({ team: target.id });
      if (signedOut()) { clearRetry(); return toScreen({ screen: "signin" }); }
      if (!target.origin) { toScreen({ screen: "plan", machine: target.machine?.status ?? "stopped" }); later(); return; }
      return connect(target, token, open);
    }
    if (place === "cloud" || target.left) remember(null);
    opening = null;
    clearRenewal();
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
        log(`home: could not sign in to ${place.kind === "team" ? place.name : "My Cloud"} again (${error?.message ?? error})`);
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
  /** A newer page reloads at a quiet moment; an asleep My Cloud is never asked (that would start it). */
  async function watchVersion() {
    const origin = placeOrigin();
    if (!origin || !shows(origin) || (shown?.kind !== "team" && power.asleep())) return;
    const current = await version(origin);
    if (!current) return;
    if (!loaded) { loaded = current; return; }
    if (current !== loaded) newer = true;
    if (!newer || now() - lastInput() < quietMs || !shows(origin)) return;
    newer = false; loaded = current;
    window()?.webContents.reload();
  }
  const watcher = timers.every(() => { void watchVersion(); }, versionEveryMs);

  return {
    show,
    refresh,
    view,
    /** My Cloud's origin while it is home, else null. */
    cloudOrigin,
    /** The origin of the place the window shows (a team's Cloud, or My Cloud), else null. */
    placeOrigin,
    /** Home as last worked out. */
    current: () => home,
    /** The place the window was last sent to: My Cloud, or a team's Cloud (`{ kind: "team", id, name, origin }`). */
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
      // The window went to another server (the Server menu): the team it showed is no longer the place on screen.
      if (shown?.kind === "team" && ![shown.origin, localOrigin()].includes(originOf(url))) { shown = null; clearRenewal(); }
      const origin = placeOrigin();
      if (!origin || originOf(url) !== origin) return;
      const at = new URL(url);
      if (at.pathname === "/pair" && !/[#&]code=/.test(at.hash)) { void repair(); return; }
      newer = false; loaded = null;
      void version(origin).then((current) => { if (current && placeOrigin() === origin) loaded = current; });
    },
    /** The main frame could not load the place. */
    failed(url) {
      const origin = placeOrigin();
      if (origin && originOf(url) === origin) offline(++opens);
    },
    /** `event` came from the shown place's own page in this window (My Cloud's while it is home, or a team's Cloud's). */
    homePage(event) {
      const origin = placeOrigin(), win = window();
      if (!origin || !win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
      return originOf(event.senderFrame.url) === origin;
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
  ipcMain.handle("home:sign-in", from("home:sign-in", (event) => screenPage(event) || cloudPage(event) === "cloud", () => homeWindow.signIn()));
  ipcMain.handle("home:repair", from("home:repair", (event) => homeWindow.homePage(event), () => homeWindow.repair()));
  ipcMain.on("home:page", (event) => { try { event.returnValue = homeWindow.homePage(event); } catch { event.returnValue = false; } });
}
