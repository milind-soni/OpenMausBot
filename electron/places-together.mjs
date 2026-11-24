// "This computer and My Cloud together" (Settings → MausBot Cloud, an early feature that starts off): the sidebar of this
// computer's page and of My Cloud's page lists the other one's bots too. A page can only talk to its own place, so main
// reads the other place's bots as the signed-in person, keeps the list, and opens that place at a bot when its row is
// clicked. With the switch off nothing here reads, keeps or sends anything.
//
// Security: the list goes only to this computer's own page and to My Cloud's own page (`asking`, which main works out from
// the sender), never to a team's Cloud or a server saved by hand. A row is a name, a look and a state: no message, address
// or token. A page names a bot by an id main listed itself; main opens only such an id, in a place of its own choosing.
// A sleeping Cloud is never asked, since any request would wake it; it keeps the list it gave last.
import { asleepAnswer, BACKGROUND_HEADERS } from "./cloud-power.mjs";

/** The switch, kept in `places-together.json` as `{ v: 1, on }`. Everything that joins the two places reads this one key. */
export const PLACES_TOGETHER_FILE = "places-together.json";
/** How often the list on screen is looked at again. This computer answers each time; My Cloud at most every CLOUD_EVERY_MS. */
export const LOOK_EVERY_MS = 20_000;
/** This computer's bots are read again for a page that asks once they are older than this. */
export const FRESH_MS = 4_000;
/** My Cloud is asked at most this often, and only while the window is the one the person is using. */
export const CLOUD_EVERY_MS = 60_000;
/** A row's click waits this long for its place to open (a Cloud may have to wake), and no longer. */
export const OPEN_WAIT_MS = 2 * 60_000;
/** A new bot asked for in the other place waits only as long as a wake takes (a stopped Cloud answers in about 20 s). */
export const NEW_BOT_WAIT_MS = 45_000;
/** The page that was told to make a new bot says it heard within this long, or is told to forget it. */
export const NEW_BOT_ACK_MS = 10_000;
const TIMEOUT_MS = 10_000;
const MAX_BOTS = 500;
const ID = /^[\w-]{1,128}$/;
const COLOR = /^[\w#(),.% -]{1,64}$/;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const look = (value) => (typeof value === "string" && COLOR.test(value) ? value : null);

/** The other side of a page: This computer's page lists My Cloud's bots, My Cloud's page this computer's. */
export const otherHome = (asking) => (asking === "cloud" ? "computer" : "cloud");

/** Whether the switch is on, read back from its file. */
export function parseTogether(value) {
  return record(value) && value.v === 1 && value.on === true;
}

function rowState(bot) {
  const tasks = Array.isArray(bot.tasks) ? bot.tasks.filter((task) => record(task) && !task.routineRunId && task.archivedAt === undefined) : [];
  const waiting = bot.activity === "waiting-on-you" || tasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || tasks.some((task) => task.busy || task.activity === "working"));
  const unread = tasks.length ? tasks.some((task) => task.unread === true) : bot.unread === true;
  return { ...(waiting ? { waiting: true } : {}), ...(working ? { working: true } : {}), ...(unread ? { unread: true } : {}) };
}

/** One bot of the other place as its row: who it is, how it looks and how it is doing. A bot that is archived, hidden
 * from the sidebar, or only the pointer a move left behind, has no row. */
export function botRow(bot, home) {
  if (!record(bot) || !ID.test(String(bot.id)) || !ID.test(String(bot.threadId)) || bot.hidden || bot.sidebarHidden || bot.movedTo) return null;
  const name = text(bot.name, 80);
  if (!name) return null;
  const title = text(bot.title, 80), color = look(bot.color), body = look(bot.mascotBody), face = look(bot.mascotFaceColor), tint = look(bot.mascotBodyColor), fur = look(bot.mascotMaterial);
  return { home, id: bot.id, threadId: bot.threadId, name, ...(title ? { title } : {}), ...(color ? { color } : {}),
    ...(body ? { mascotBody: body } : {}), ...(face ? { mascotFaceColor: face } : {}), ...(tint ? { mascotBodyColor: tint } : {}), ...(fur ? { mascotMaterial: fur } : {}), ...(bot.chiefOfStaff === true ? { chief: true } : {}), ...rowState(bot) };
}

/** The AIs a place's `GET /api/instances` answer says are ready to use: installed and signed in, never one that only
 * works through free no-login models. Each as its name and its kind; the page words them. */
export function readyAis(body) {
  const instances = record(body) && Array.isArray(body.instances) ? body.instances : [];
  const ready = (instance) => record(instance) && record(instance.snapshot) && instance.snapshot.state === "available" && instance.snapshot.freeFallback !== true
    && (instance.driverKind === "clineAgent" ? instance.snapshot.authenticated === true : instance.access === "custom" || instance.snapshot.authenticated !== false);
  const seen = new Set();
  return instances.filter(ready).map((instance) => ({ name: text(instance.displayName, 60), kind: text(instance.driverKind, 40) }))
    .filter((ai) => ai.name && !seen.has(ai.name) && seen.add(ai.name)).slice(0, 20);
}

/** Whether a place's `GET /api/bots` answer says its page makes a new bot when the person's other place asks. */
export const makesNewBots = (body) => record(body) && record(body.together) && body.together.newBot === true;

/** A place's `GET /api/bots` answer as rows, in that place's own order. */
export function botRows(body, home) {
  const bots = record(body) && Array.isArray(body.bots) ? body.bots : [];
  return bots.map((bot) => botRow(bot, home)).filter(Boolean).slice(0, MAX_BOTS);
}

/** My Cloud answered that this session may not read it: nobody signed this window in there yet, or the sign-in ended. */
const needsSignIn = (response) => response?.status === 401 || response?.status === 403;

/**
 * @param {{
 *   pref: { read(): unknown, write(value: unknown): void },
 *   cloud(): { origin: string | null, account: string | null, asleep: boolean },
 *   powerChecked(): Promise<boolean>,
 *   computer(): boolean,
 *   local(route: string, init?: RequestInit): Promise<Response>,
 *   cloudFetch(url: string, init?: RequestInit): Promise<Response>,
 *   napped?(): void,
 *   address?(home: "computer" | "cloud", botId: string): string | null,
 *   shown(): "computer" | "cloud" | "waking" | "other" | null,
 *   focused(): boolean,
 *   openPlace(home: "computer" | "cloud"): unknown,
 *   send(channel: string, value: unknown): void,
 *   changed(): void,
 *   now?(): number,
 *   setTimer?: typeof setInterval,
 *   clearTimer?: typeof clearInterval,
 *   later?: typeof setTimeout,
 *   cancelLater?: typeof clearTimeout,
 * }} deps `cloud()`: My Cloud's address and the signed-in account while the person has one, and whether the Admin last
 * said it sleeps. `powerChecked()`: asks the Admin again whether My Cloud sleeps, true once it answered just now.
 * `computer()`: this computer is a place of its own (its bots did not move away). `napped()`: My Cloud answered that it
 * is going to sleep. `shown()`: the place whose page the window shows; "waking" for this app's own screen while My Cloud
 * wakes, "other" for any other place or screen, null while a page loads.
 * `focused()`: the window is the one the person is using: in front, and the screen not locked. `openPlace(home)`: main's
 * own switch to that place, waking My Cloud as opening it always does. `send`: to the page on screen. `changed()`: the
 * list or the switch changed, so a page that draws it asks again. `address(home, botId)`: the address the link between
 * the two places gives that bot (electron/bot-link-main.mjs), or null while no link of this Cloud and account is on.
 *
 * Security: My Cloud is never asked while it sleeps, since any request would wake it and run up its hours. It is asked
 * only right after the Admin said it is awake, at most once a minute, and only while the person is using the window. What
 * remains is a Cloud that fell asleep in the seconds since the Admin answered; one that only agreed to sleep answers so
 * itself and is left alone. Rows are kept for the Cloud and account they came from, and dropped the moment either changes.
 */
export function createPlacesTogether({ pref, cloud, powerChecked, computer, local, cloudFetch, napped = () => {}, address = () => null, shown, focused, openPlace, send, changed, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval, later = setTimeout, cancelLater = clearTimeout }) {
  /** What each place gave last: its rows, when, and how the last read went. */
  const kept = new Map();
  const reading = new Map();
  /** The places whose ready AIs the ＋ asked about: read with that place's next list, and not otherwise. */
  const aisWanted = new Set();
  /** Moves whenever the lists are dropped; a read that started before it moved is thrown away. */
  let epoch = 0;
  let on = null, timer = null, pending = null, scope = null, cloudAskedAt = -Infinity, signIn = false, unheard = null;
  const placeShown = () => { const place = shown(); return place === "computer" || place === "cloud" ? place : null; };

  const isOn = () => { if (on === null) { try { on = parseTogether(pref.read()); } catch { on = false; } } return on; };
  const available = () => Boolean(cloud().origin) && computer();
  const active = () => isOn() && available();
  const tell = () => { try { changed(); } catch {} };

  function forget() {
    epoch += 1;
    kept.clear();
    reading.clear();
    aisWanted.clear();
    cloudAskedAt = -Infinity;
    signIn = false;
    drop();
  }
  function drop() {
    cancelLater(unheard);
    unheard = null;
    if (!pending) return false;
    cancelLater(pending.timer);
    pending = null;
    return true;
  }

  /** The Cloud and account the lists belong to. Another one, or none, and they are gone at once. */
  function sameScope() {
    const { origin, account } = cloud();
    const next = origin && isOn() && computer() ? `${origin}\n${account ?? ""}` : null;
    if (next === scope) return;
    const had = kept.size > 0 || pending !== null;
    scope = next;
    forget();
    if (next === null) stopWatch();
    if (had) tell();
  }

  async function ask(home, route = "/api/bots?messages=0") {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    if (home === "computer") return local(route, { signal, headers: { accept: "application/json" } });
    const { origin } = cloud();
    return cloudFetch(`${origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", signal, headers: { accept: "application/json", ...BACKGROUND_HEADERS } });
  }

  /** Whether My Cloud may be asked now, and what its list says when it may not. */
  async function cloudMayBeAsked(mine) {
    if (cloud().asleep) return "asleep";
    const answered = await powerChecked().catch(() => false);
    if (mine !== epoch) return null;
    if (!answered) return "offline";
    return cloud().asleep ? "asleep" : "ask";
  }

  const aisFresh = (entry) => entry?.aisAt !== undefined && now() - entry.aisAt < CLOUD_EVERY_MS;

  /** The AIs ready in `home`, read with its bots once the ＋ asked, at most once a minute; what it said last otherwise. */
  async function aisOf(home, last) {
    if (!aisWanted.has(home) || aisFresh(last)) return last?.aisAt === undefined ? {} : { ais: last.ais, aisAt: last.aisAt };
    aisWanted.delete(home);
    try {
      const response = await ask(home, "/api/instances");
      if (home === "cloud" && needsSignIn(response)) { await response.body?.cancel?.(); return "signin"; }
      if (!response?.ok) { await response?.body?.cancel?.(); return { ais: last?.ais ?? null, aisAt: now() }; }
      return { ais: readyAis(await response.json()), aisAt: now() };
    } catch { return { ais: last?.ais ?? null, aisAt: now() }; }
  }

  async function read(home) {
    const mine = epoch, last = kept.get(home), said = (entry) => JSON.stringify([entry?.state, entry?.bots, entry?.newBot, entry?.ais]);
    const held = (state) => ({ ...last, bots: last?.bots ?? [], state });
    const signedOut = () => { signIn = true; return { bots: [], state: "signin" }; };
    let next;
    try {
      const may = home === "cloud" ? await cloudMayBeAsked(mine) : "ask";
      if (may === null) return;
      if (may !== "ask") next = held(may);
      else {
        const response = await ask(home);
        if (home === "cloud" && asleepAnswer(response)) { napped(); next = held("asleep"); }
        else if (home === "cloud" && needsSignIn(response)) { await response.body?.cancel?.(); next = signedOut(); }
        else if (!response?.ok) { await response?.body?.cancel?.(); next = held("offline"); }
        else {
          const body = await response.json(), ais = await aisOf(home, last);
          next = ais === "signin" ? signedOut() : { bots: botRows(body, home), state: "ready", newBot: makesNewBots(body), ...ais };
        }
      }
    } catch { next = held("offline"); }
    if (mine !== epoch || !active()) return;
    kept.set(home, { ...next, at: now() });
    if (said(next) !== said(last)) tell();
  }

  /** Reads `home`'s bots again when it is due. My Cloud is due at most once a minute, never while the person is not
   * using the window, and not again once it asked for a sign-in until the person has opened it. */
  function refresh(home) {
    sameScope();
    if (!active()) return Promise.resolve();
    if (reading.has(home)) return reading.get(home);
    if (home === "cloud") {
      if (signIn || !focused() || now() - cloudAskedAt < CLOUD_EVERY_MS) return Promise.resolve();
      cloudAskedAt = now();
    } else if (kept.has(home) && now() - kept.get(home).at < FRESH_MS && !(aisWanted.has(home) && !aisFresh(kept.get(home)))) return Promise.resolve();
    const mine = epoch;
    const work = read(home).finally(() => { if (mine === epoch && reading.get(home) === work) reading.delete(home); });
    reading.set(home, work);
    return work;
  }

  function watch() {
    if (timer !== null || !active()) return;
    timer = setTimer(() => {
      sameScope();
      const place = placeShown();
      if (active() && place && focused()) void refresh(otherHome(place));
    }, LOOK_EVERY_MS);
    timer?.unref?.();
  }
  function stopWatch() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  /** `home` opens, and its page is sent `channel` once it has loaded, as the direct result of the click and nothing
   * else: the wait is over when it runs out, when main's switch fails or ends with the window on another page, and
   * when the window goes anywhere but `home` or the screen shown while My Cloud wakes. */
  function go(home, channel, value, waitMs) {
    drop();
    const mine = { home, channel, value, timer: null };
    const over = () => { if (pending === mine && drop()) tell(); };
    mine.timer = later(over, waitMs);
    mine.timer?.unref?.();
    pending = mine;
    tell();
    void Promise.resolve().then(() => openPlace(home)).then(() => {
      const place = shown();
      if (place !== null && place !== home && place !== "waking") over();
    }, over);
  }

  /** The row with the address the link gives its bot, worked out as the row is handed over: the list is the sidebar's
   * own read and stays whole with the link down; the address is there only while the link is this Cloud's and account's. */
  function addressed(row) {
    let linked = null;
    try { linked = address(row.home, row.id); } catch {}
    return typeof linked === "string" && linked ? { ...row, address: linked } : row;
  }

  function otherOf(asking) {
    const home = otherHome(asking), known = kept.get(home);
    const state = home === "cloud" && pending?.home === home && (cloud().asleep || known?.state !== "ready") ? "waking"
      : home === "cloud" && cloud().asleep ? "asleep" : known?.state ?? "loading";
    return { home, state, bots: (known?.bots ?? []).map((row) => addressed(row)), ...(typeof known?.newBot === "boolean" ? { newBot: known.newBot } : {}) };
  }

  return {
    /** Whether the switch is on and both places exist: what anything else that joins the two places asks. */
    on: active,
    /** What `asking`'s page draws: the switch, and the other place's bots while it is on. */
    state(asking) {
      sameScope();
      const here = asking === "cloud" ? "cloud" : "computer";
      if (!active()) return { v: 1, available: available(), on: isOn(), here, other: null };
      watch();
      void refresh(otherHome(here));
      return { v: 1, available: true, on: true, here, other: otherOf(here) };
    },
    /** The switch. Off forgets every list. */
    set(asking, value) {
      on = value === true;
      pref.write({ v: 1, on });
      sameScope();
      tell();
      return this.state(asking);
    },
    refresh,
    /** The signed-in account or My Cloud's address may have changed: lists that belong to another are dropped now. */
    scopeChanged: sameScope,
    /** The link between the two places came, went or changed hands: rows on screen get their addresses again. */
    linkChanged() { if (active() && kept.size > 0) tell(); },
    /** A row's click: the other place opens at that bot. Only a bot main listed itself, for this Cloud and account, opens. */
    open(asking, botId) {
      sameScope();
      if (!active()) return false;
      const home = otherHome(asking), row = kept.get(home)?.bots.find((bot) => bot.id === botId);
      if (!row) return false;
      go(home, "desktop-notifications:open", { botId: row.id, threadId: row.threadId }, OPEN_WAIT_MS);
      return true;
    },
    /** What the ＋ shows about the other place before a bot is made there: how it is doing, and the AIs ready there
     * (null while it has not said). The AIs are read with the list's own next read, under the list's rules and its
     * once-a-minute limit for My Cloud, so opening the ＋ again and again asks nothing more. */
    async newBotChoice(asking) {
      sameScope();
      if (!active()) return null;
      const home = otherHome(asking);
      if (!aisFresh(kept.get(home))) { aisWanted.add(home); await refresh(home); }
      if (!active()) return null;
      return { home, state: otherOf(asking).state, ais: kept.get(home)?.ais ?? null };
    },
    /** The ＋'s choice of the other place: that place opens and makes the bot itself, by its own rules and limits.
     * Refused for a place whose page said it would not hear the request. */
    newBot(asking) {
      sameScope();
      const home = otherHome(asking);
      if (!active() || kept.get(home)?.newBot === false) return false;
      go(home, "places-together:new-bot", null, NEW_BOT_WAIT_MS);
      return true;
    },
    /** The page that was told to make a new bot heard it. */
    newBotHeard() {
      cancelLater(unheard);
      unheard = null;
    },
    /** The window finished loading a page: a click that was waiting for this place lands now. My Cloud on screen is
     * signed in, so it may be asked again. A page told to make a new bot that does not say it heard is told to forget it. */
    arrived() {
      sameScope();
      const place = placeShown();
      if (place === "cloud" && signIn) { signIn = false; cloudAskedAt = -Infinity; }
      if (!pending || place !== pending.home) return;
      const { channel, value } = pending;
      drop();
      if (active()) {
        send(channel, value);
        if (channel === "places-together:new-bot") {
          unheard = later(() => { unheard = null; send("places-together:new-bot-cancel", null); }, NEW_BOT_ACK_MS);
          unheard?.unref?.();
        }
      }
      tell();
    },
    /** The window's page moved to `place`. Anywhere but the place the click asked for, or the screen shown while My
     * Cloud wakes, and the click is over: that place opened later, by any route, opens as it is. */
    navigated(place) {
      if (pending && place !== null && place !== pending.home && place !== "waking" && drop()) tell();
    },
    close() { stopWatch(); forget(); },
  };
}

/** The bridge's channels. `asking(event)`: "local" for this computer's own page, "cloud" for My Cloud's own page, null for
 * anything else, which gets nothing.
 *
 * Security: only this computer's own page turns the switch on. My Cloud's page is served by the Cloud, so it may turn the
 * joining off but never start it. */
export function installPlacesTogether({ ipcMain, asking, together }) {
  const side = (event) => {
    const page = asking(event);
    if (!page) throw new Error("Only this computer's page and My Cloud's page list each other's bots.");
    return page === "cloud" ? "cloud" : "computer";
  };
  ipcMain.handle("places-together:state", (event) => together.state(side(event)));
  ipcMain.handle("places-together:set", (event, value) => {
    const page = side(event);
    if (value === true && page !== "computer") throw new Error("Turn this on from this computer's page.");
    return together.set(page, value === true);
  });
  ipcMain.handle("places-together:open", (event, botId) => together.open(side(event), String(botId)));
  ipcMain.handle("places-together:new-bot-choice", (event) => together.newBotChoice(side(event)));
  ipcMain.handle("places-together:new-bot", (event) => together.newBot(side(event)));
  ipcMain.handle("places-together:new-bot-heard", (event) => { side(event); together.newBotHeard(); });
  return together;
}
