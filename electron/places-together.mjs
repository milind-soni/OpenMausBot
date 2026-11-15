// "This computer and My Cloud together" (Settings → MausBot Cloud, an early feature that starts off): the sidebar of this
// computer's page and of My Cloud's page lists the other one's bots too. A page can only talk to its own place, so main
// reads the other place's bots as the signed-in person, keeps the list, and opens that place at a bot when its row is
// clicked. With the switch off nothing here reads, keeps or sends anything.
//
// Security: the list goes only to this computer's own page and to My Cloud's own page (`asking`, which main works out from
// the sender), never to a team's Cloud or a server saved by hand. A row is a name, a look and a state: no message, address
// or token. A page names a bot by an id main listed itself; main opens only such an id, in a place of its own choosing.
// A Cloud the Admin says is asleep is never asked, since any request would wake it; it keeps the list it gave last.
import { asleepAnswer, BACKGROUND_HEADERS } from "./cloud-power.mjs";

/** The switch, kept in `places-together.json` as `{ v: 1, on }`. Everything that joins the two places reads this one key. */
export const PLACES_TOGETHER_FILE = "places-together.json";
export const LOOK_EVERY_MS = 20_000;
/** A page that asks gets a fresh read when the list is older than this. */
export const FRESH_MS = 4_000;
/** A row's click waits this long for its place to open (a Cloud may have to wake), and no longer. */
export const OPEN_WAIT_MS = 2 * 60_000;
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

/** One bot of the other place as its row: who it is, how it looks and how it is doing. A bot that is archived, or only
 * the pointer a move left behind, has no row. */
export function botRow(bot, home) {
  if (!record(bot) || !ID.test(String(bot.id)) || !ID.test(String(bot.threadId)) || bot.hidden || bot.movedTo) return null;
  const name = text(bot.name, 80);
  if (!name) return null;
  const title = text(bot.title, 80), color = look(bot.color), body = look(bot.mascotBody), face = look(bot.mascotFaceColor);
  return { home, id: bot.id, threadId: bot.threadId, name, ...(title ? { title } : {}), ...(color ? { color } : {}),
    ...(body ? { mascotBody: body } : {}), ...(face ? { mascotFaceColor: face } : {}), ...(bot.chiefOfStaff === true ? { chief: true } : {}), ...rowState(bot) };
}

/** A place's `GET /api/bots` answer as rows, in that place's own order. */
export function botRows(body, home) {
  const bots = record(body) && Array.isArray(body.bots) ? body.bots : [];
  return bots.map((bot) => botRow(bot, home)).filter(Boolean).slice(0, MAX_BOTS);
}

/**
 * @param {{
 *   pref: { read(): unknown, write(value: unknown): void },
 *   cloud(): { origin: string | null, asleep: boolean },
 *   computer(): boolean,
 *   local(route: string, init?: RequestInit): Promise<Response>,
 *   cloudFetch(url: string, init?: RequestInit): Promise<Response>,
 *   napped?(): void,
 *   shown(): "computer" | "cloud" | null,
 *   visible?(): boolean,
 *   openPlace(home: "computer" | "cloud"): unknown,
 *   send(channel: string, value: unknown): void,
 *   changed(): void,
 *   now?(): number,
 *   setTimer?: typeof setInterval,
 *   clearTimer?: typeof clearInterval,
 * }} deps `cloud()`: My Cloud's address while the person has one, and whether it sleeps now. `computer()`: this computer
 * is a place of its own (its bots did not move away). `napped()`: My Cloud answered that it is going to sleep.
 * `shown()`: the place whose page the window shows, null while one loads. `visible()`: the window can be seen.
 * `openPlace(home)`: main's own switch to that place, waking My Cloud as opening it always does. `send`: to the page on
 * screen. `changed()`: the list or the switch changed, so a page that draws it asks again.
 */
export function createPlacesTogether({ pref, cloud, computer, local, cloudFetch, napped = () => {}, shown, visible = () => true, openPlace, send, changed, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  /** What each place gave last: its rows, when, and how the last read went. */
  const kept = new Map();
  const reading = new Map();
  let on = null, timer = null, pending = null;

  const isOn = () => { if (on === null) { try { on = parseTogether(pref.read()); } catch { on = false; } } return on; };
  const available = () => Boolean(cloud().origin) && computer();
  const active = () => isOn() && available();
  const tell = () => { try { changed(); } catch {} };

  async function ask(home) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    if (home === "computer") return local("/api/bots?messages=0", { signal, headers: { accept: "application/json" } });
    const { origin } = cloud();
    return cloudFetch(`${origin}/api/bots?messages=0`, { credentials: "include", cache: "no-store", redirect: "error", signal, headers: { accept: "application/json", ...BACKGROUND_HEADERS } });
  }

  async function read(home) {
    const before = JSON.stringify(kept.get(home) ?? null);
    let next;
    if (home === "cloud" && cloud().asleep) next = { ...(kept.get(home) ?? { bots: [] }), state: "asleep" };
    else {
      try {
        const response = await ask(home);
        if (home === "cloud" && asleepAnswer(response)) { napped(); next = { ...(kept.get(home) ?? { bots: [] }), state: "asleep" }; }
        else if (!response?.ok) { await response?.body?.cancel?.(); next = { ...(kept.get(home) ?? { bots: [] }), state: "offline" }; }
        else next = { bots: botRows(await response.json(), home), state: "ready" };
      } catch { next = { ...(kept.get(home) ?? { bots: [] }), state: "offline" }; }
    }
    if (!active()) return;
    kept.set(home, { ...next, at: now() });
    if (JSON.stringify({ ...next, at: null }) !== JSON.stringify({ ...JSON.parse(before), at: null })) tell();
  }

  /** Reads `home`'s bots again unless a read is under way. */
  function refresh(home) {
    if (!active()) return Promise.resolve();
    if (!reading.has(home)) reading.set(home, read(home).finally(() => reading.delete(home)));
    return reading.get(home);
  }

  function watch() {
    if (timer !== null || !active()) return;
    timer = setTimer(() => {
      if (!active()) { stop(); return; }
      const place = shown();
      if (place && visible()) void refresh(otherHome(place));
    }, LOOK_EVERY_MS);
    timer?.unref?.();
  }
  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    kept.clear();
    pending = null;
  }

  function otherOf(asking) {
    const home = otherHome(asking), known = kept.get(home);
    const waking = pending?.home === home && now() - pending.at <= OPEN_WAIT_MS;
    const state = home === "cloud" && waking && (cloud().asleep || known?.state !== "ready") ? "waking"
      : home === "cloud" && cloud().asleep ? "asleep" : known?.state ?? "loading";
    return { home, state, bots: known?.bots ?? [] };
  }

  return {
    /** Whether the switch is on and both places exist: what anything else that joins the two places asks. */
    on: active,
    /** What `asking`'s page draws: the switch, and the other place's bots while it is on. */
    state(asking) {
      const here = asking === "cloud" ? "cloud" : "computer";
      if (!active()) return { v: 1, available: available(), on: isOn(), here, other: null };
      watch();
      const known = kept.get(otherHome(here));
      if (!known || now() - known.at > FRESH_MS) void refresh(otherHome(here));
      return { v: 1, available: true, on: true, here, other: otherOf(here) };
    },
    /** The switch. Off forgets every list. */
    set(asking, value) {
      on = value === true;
      pref.write({ v: 1, on });
      if (!active()) stop();
      tell();
      return this.state(asking);
    },
    refresh,
    /** A row's click: the other place opens at that bot. Only a bot main listed itself opens. */
    open(asking, botId) {
      if (!active()) return false;
      const home = otherHome(asking), row = kept.get(home)?.bots.find((bot) => bot.id === botId);
      if (!row) return false;
      pending = { home, target: { botId: row.id, threadId: row.threadId }, at: now() };
      tell();
      void Promise.resolve().then(() => openPlace(home)).catch(() => {});
      return true;
    },
    /** The window finished loading a page: a click that was waiting for this place lands now. */
    arrived() {
      if (!pending) return;
      if (now() - pending.at > OPEN_WAIT_MS || !active()) { pending = null; tell(); return; }
      if (shown() !== pending.home) return;
      const { target } = pending;
      pending = null;
      send("desktop-notifications:open", target);
      tell();
    },
    close: stop,
  };
}

/** The bridge's channels. `asking(event)`: "local" for this computer's own page, "cloud" for My Cloud's own page, null for
 * anything else, which gets nothing. */
export function installPlacesTogether({ ipcMain, asking, together }) {
  const side = (event) => {
    const page = asking(event);
    if (!page) throw new Error("Only this computer's page and My Cloud's page list each other's bots.");
    return page === "cloud" ? "cloud" : "computer";
  };
  ipcMain.handle("places-together:state", (event) => together.state(side(event)));
  ipcMain.handle("places-together:set", (event, value) => together.set(side(event), value === true));
  ipcMain.handle("places-together:open", (event, botId) => together.open(side(event), String(botId)));
  return together;
}
