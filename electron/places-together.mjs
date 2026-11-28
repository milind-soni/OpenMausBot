// "This computer and My Cloud together" (Settings → Plan & billing): the sidebar of this computer's page lists My Cloud's
// bots too. A page can only talk to its own place, so main reads the other place's bots as the signed-in person, keeps the
// list, and opens that place at a bot when its row is clicked. With the switch off nothing here reads, keeps or sends anything.
//
// On by default: a person who never turned the switch either way has it on, but only from the moment this computer's page
// has shown them the one-time notice that says so, with the switch right there. Until then it is off as before: nothing is
// read or linked. The default never lets My Cloud run commands here: the notice has its own switch for that, as the person
// has it now. A choice the person made either way is kept for good, and the notice never shows again once they closed it,
// used one of its switches, or touched the switch in Settings or on the rail.
//
// Security: the list goes only to this computer's own page and to My Cloud's own page (`asking`, which main works out from
// the sender), never to a team's Cloud or a server saved by hand. A row is a name, a look, a state and, as the person's
// own two pages show each other, a short preview of the bot's newest line (PREVIEW_MAX characters of plain words; never a
// step, a card, a file or another bot's note): no whole message, address or token. A page names a bot by an id main listed itself; main opens only such an id, in a place of its own choosing.
// A sleeping Cloud is never asked, since any request would wake it; it keeps the list it gave last.
import nodeFs from "node:fs";

import { asleepAnswer, BACKGROUND_HEADERS } from "./cloud-power.mjs";

/** The switch, kept in `places-together.json` as `{ v: 1, on }`. Everything that joins the two places reads this one key.
 * Beside it, by signed-in account: `noticed` (when the notice of the default was first shown) and `done` (when the person
 * closed it or used it). `on` is absent while the person never chose: an older app reads that as off. */
export const PLACES_TOGETHER_FILE = "places-together.json";
/** No read of My Cloud for this long after the app starts: the default adds nothing to a start. */
export const START_QUIET_MS = 15_000;
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
/** The most of a bot's newest line a row carries: the sidebar shows one truncated line of it. */
export const PREVIEW_MAX = 300;
/** A line another bot sent is stored with this note in front (src/lib/peer-message.ts): never shown as the person's. */
const PEER_NOTE = /^\[(?:From @|Message from @|Delegated by @|Thread opened by @)/;
const MAX_BOTS = 500;
const MAX_SECTIONS = 200;
const SECTION_MAX = 60;
/** The most bots whose place in the one list is kept for one account. */
const MAX_LAID = 2_000;
const ID = /^[\w-]{1,128}$/;
const COLOR = /^[\w#(),.% -]{1,64}$/;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const look = (value) => (typeof value === "string" && COLOR.test(value) ? value : null);

/** The other side of a page: This computer's page lists My Cloud's bots, My Cloud's page this computer's. */
export const otherHome = (asking) => (asking === "cloud" ? "computer" : "cloud");

/** Whether the switch is on, read back from its file: the person's own choice only. */
export function parseTogether(value) {
  return record(value) && value.v === 1 && value.on === true;
}

/** The switch's file as read for `account`: `choice` is that person's (true, false, or null when they never chose), `kept`
 * what a rewrite keeps. Choices are kept by account (`choices`); a file from before them has one `on` for everyone here,
 * which stands until the first choice made since. `on` stays written too, the last choice made here, for an older app.
 * A file that can't be read (`unreadable`, which may pass), whose words are not JSON at all (`corrupt`), or that this app
 * does not understand (`foreign`: another shape or a newer version) is left alone: off, no default, no notice, and never
 * written over. Only the person's own turn of the switch in Settings repairs a corrupt one, kept beside it first. */
export function readTogether(read, account = null) {
  let value;
  try { value = read(); } catch (error) {
    if (error?.code === "ENOENT") return { choice: null, kept: { v: 1 } };
    return error instanceof SyntaxError ? { choice: false, kept: { v: 1 }, corrupt: true } : { choice: false, kept: { v: 1 }, unreadable: true };
  }
  if (value === null || value === undefined) return { choice: null, kept: { v: 1 } };
  if (!record(value) || value.v !== 1) return { choice: false, kept: { v: 1 }, foreign: true };
  return { choice: choiceIn(value, account), kept: value };
}

/** One person's choice in a readable switch file (readTogether). */
function choiceIn(kept, account) {
  if (record(kept.choices)) return typeof account === "string" && typeof kept.choices[account] === "boolean" ? kept.choices[account] : null;
  return typeof kept.on === "boolean" ? kept.on : kept.on === undefined ? null : false;
}

const stamped = (map, account) => record(map) && typeof account === "string" && Number.isFinite(map[account]) && map[account] > 0;

/** Which of this computer's own workspaces would join My Cloud, as a key that changes whenever another one runs; null when
 * none can. `cloudHome`: My Cloud is the person's home (their bots moved there). `ownHome`: a server of their own is.
 * `frozen`: this computer's data folder holds the move's freeze marker (clean-workspace.mjs `marker()`), known before the
 * home window knows My Cloud is home. `profile`: the workspace of this computer's own that runs now (This Mac is
 * `default`), null for the frozen copy a move left or the clean workspace. `running`: the folder this computer's server
 * runs on.
 *
 * Home = this computer: its own server, as ever. Bots moved away (home = My Cloud, or the marker says so): only while a
 * workspace of this computer's own runs: the frozen copy admits no turns and still lists the bots that moved, and the clean
 * workspace has nothing of the person's, so neither joins. A server of their own as home: none (not offered yet). */
export function togetherComputer({ cloudHome, ownHome, frozen = false, profile, running }) {
  if (ownHome) return null;
  if (cloudHome || frozen) return typeof profile === "string" && profile ? `profile:${profile}` : null;
  return `computer:${typeof running === "string" ? running : ""}`;
}

function rowState(bot) {
  const tasks = Array.isArray(bot.tasks) ? bot.tasks.filter((task) => record(task) && !task.routineRunId && task.archivedAt === undefined) : [];
  const waiting = bot.activity === "waiting-on-you" || tasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || tasks.some((task) => task.busy || task.activity === "working"));
  const unread = tasks.length ? tasks.some((task) => task.unread === true) : bot.unread === true;
  // When its conversations last moved (each thread's own server-derived time, never a word of them): what Unread lists
  // the row by, newest first, beside this place's own rows.
  const times = tasks.map((task) => task.updatedAt).filter((at) => Number.isFinite(at) && at > 0);
  const lastAt = times.length ? Math.max(...times) : null;
  return { ...(waiting ? { waiting: true } : {}), ...(working ? { working: true } : {}), ...(unread ? { unread: true } : {}), ...(lastAt !== null ? { lastAt } : {}) };
}

/** Kinds a row looks past for the newest words said: a turn's work summary, a condensed-history marker and its steps, as
 * the sidebar's own preview does in Simple. */
const LOOKED_PAST = new Set(["digest", "compaction", "activity"]);
/** How many of a bot's newest messages a read carries to find them. */
export const PREVIEW_LOOK = 3;

/** The start of the newest words the person or the bot said, looking past a turn's steps and summary: what the row's
 * second line shows, as this page's own rows do in Simple. Nothing when the newest thing is a card, a screen, a file, a
 * voice note, a setup line or another bot's note, which stay on their own page. */
export function previewOf(bot) {
  const messages = Array.isArray(bot.messages) ? bot.messages : [];
  const last = messages.findLast((message) => !(record(message) && LOOKED_PAST.has(message.kind))) ?? null;
  if (!record(last) || last.kind !== "text" || (last.role !== "bot" && last.role !== "user") || typeof last.text !== "string") return null;
  if (last.attachments?.length || last.setupSuggestion || last.helperIntro || last.peerAsk || last.relay || last.comm || last.threadRef || last.roomRequest) return null;
  if (last.role === "user" && PEER_NOTE.test(last.text)) return null;
  const line = last.text.trim().slice(0, PREVIEW_MAX);
  return line || null;
}

/** One bot of the other place as its row: who it is, how it looks and how it is doing. A bot that is archived, hidden
 * from the sidebar, or only the pointer a move left behind, has no row. */
export function botRow(bot, home) {
  if (!record(bot) || !ID.test(String(bot.id)) || !ID.test(String(bot.threadId)) || bot.hidden || bot.sidebarHidden || bot.movedTo) return null;
  const name = text(bot.name, 80);
  if (!name) return null;
  const open = Array.isArray(bot.tasks) ? bot.tasks.find((task) => record(task) && task.threadId === bot.threadId) : null;
  const title = text(bot.title, 80), chat = text(open?.title, 80), section = sectionName(bot.section), preview = previewOf(bot), color = look(bot.color), body = look(bot.mascotBody), face = look(bot.mascotFaceColor), tint = look(bot.mascotBodyColor), fur = look(bot.mascotMaterial);
  return { home, id: bot.id, threadId: bot.threadId, name, ...(title ? { title } : {}), ...(chat ? { chat } : {}), ...(section ? { section } : {}), ...(color ? { color } : {}),
    ...(body ? { mascotBody: body } : {}), ...(face ? { mascotFaceColor: face } : {}), ...(tint ? { mascotBodyColor: tint } : {}), ...(fur ? { mascotMaterial: fur } : {}), ...(bot.chiefOfStaff === true ? { chief: true } : {}), ...(preview ? { preview } : {}), ...rowState(bot) };
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

/** A department's name as a place's server keeps it (1 to 60 characters, no control character), or "" for none. */
export function sectionName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= SECTION_MAX && ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? name : "";
}

/** A place's departments in its own order, from its `GET /api/bots` answer: what the one list draws them by on the
 * other page too. */
export function placeSections(body) {
  const names = record(body) && Array.isArray(body.sections) ? body.sections.map(sectionName).filter(Boolean) : [];
  return [...new Set(names)].slice(0, MAX_SECTIONS);
}

/** "The place's own department" as a page sends it (src/lib/one-list.ts LANDING_SECTION): no department name can be it. */
const LANDING_SECTION = "\u0000landing";
/** A bot's key in the one list: its place and its own id there. */
const LAID_KEY = /^(computer|cloud):[\w-]{1,128}$/;

/** Where the person put bots in the one list, as a page sends it: each bot's key, its department ("" for none), and
 * the key of the bot drawn just above it in that list (null at its top). Anything else is dropped. */
export function parseArrangement(entries) {
  if (!Array.isArray(entries)) return [];
  const parsed = entries.slice(0, MAX_LAID).flatMap((entry) => {
    if (!record(entry) || typeof entry.key !== "string" || !LAID_KEY.test(entry.key)) return [];
    const section = entry.section === "" || entry.section === LANDING_SECTION ? entry.section : sectionName(entry.section);
    if (section === "" && entry.section !== "") return [];
    const after = entry.after === null ? null : typeof entry.after === "string" && LAID_KEY.test(entry.after) && entry.after !== entry.key ? entry.after : undefined;
    return after === undefined ? [] : [{ key: entry.key, section, after }];
  });
  // One entry per bot, the last one given: a page repeating a key cannot crowd out every other bot's entry.
  const last = new Map(parsed.map((entry) => [entry.key, entry]));
  return parsed.filter((entry) => last.get(entry.key) === entry);
}

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
 *   computer(): string | boolean | null,
 *   commands?: { on(): boolean, set(on: boolean): unknown },
 *   local(route: string, init?: RequestInit): Promise<Response>,
 *   cloudFetch(url: string, init?: RequestInit): Promise<Response>,
 *   napped?(): void,
 *   address?(home: "computer" | "cloud", botId: string): string | null,
 *   shown(): "computer" | "cloud" | "waking" | "other" | null,
 *   focused(): boolean,
 *   openPlace(home: "computer" | "cloud"): unknown,
 *   send(channel: string, value: unknown): void,
 *   changed(): void,
 *   inPlace?: { ensure(): Promise<{ ok: boolean }>, close(): unknown } | null,
 *   now?(): number,
 *   setTimer?: typeof setInterval,
 *   clearTimer?: typeof clearInterval,
 *   later?: typeof setTimeout,
 *   cancelLater?: typeof clearTimeout,
 * }} deps `cloud()`: My Cloud's address and the signed-in account while the person has one, and whether the Admin last
 * said it sleeps. `powerChecked()`: asks the Admin again whether My Cloud sleeps, true once it answered just now.
 * `computer()`: the workspace of this computer's own that joins My Cloud (togetherComputer), falsy when none does: a new
 * value is another workspace, whose lists are its own. `commands`: "Let your Clouds run commands on this computer"
 * (computer-sharing.mjs): whether it is on now, read from lending itself, and the notice's own switch for it, which turns it
 * on only through the same question the icon's menu asks (lending-dialogs.mjs). `napped()`: My Cloud answered that it
 * is going to sleep. `shown()`: the place whose page the window shows; "waking" for this app's own screen while My Cloud
 * wakes, "other" for any other place or screen, null while a page loads.
 * `focused()`: the window is the one the person is using: in front, and the screen not locked. `openPlace(home)`: main's
 * own switch to that place, waking My Cloud as opening it always does. `send`: to the page on screen. `changed()`: the
 * list or the switch changed, so a page that draws it asks again. `address(home, botId)`: the address the link between
 * the two places gives that bot (electron/bot-link-main.mjs), or null while no link of this Cloud and account is on.
 * `inPlace`: the session this computer's server opens a My Cloud bot in place with (place-chat-main.mjs): readied on a
 * click from this computer's page, and let go whenever the lists are dropped.
 *
 * Security: My Cloud is never asked while it sleeps, since any request would wake it and run up its hours. It is asked
 * only right after the Admin said it is awake, at most once a minute, and only while the person is using the window. What
 * remains is a Cloud that fell asleep in the seconds since the Admin answered; one that only agreed to sleep answers so
 * itself and is left alone. Rows are kept for the Cloud and account they came from, and dropped the moment either changes.
 */
export function createPlacesTogether({ pref, cloud, powerChecked, computer, local, cloudFetch, napped = () => {}, address = () => null, shown, focused, openPlace, send, changed, turnedOn = () => {}, commands = null, inPlace = null, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval, later = setTimeout, cancelLater = clearTimeout, startQuietMs = START_QUIET_MS }) {
  /** What each place gave last: its rows, when, and how the last read went. */
  const kept = new Map();
  const reading = new Map();
  /** The places whose ready AIs the ＋ asked about: read with that place's next list, and not otherwise. */
  const aisWanted = new Set();
  /** Moves whenever the lists are dropped; a read that started before it moved is thrown away. */
  let epoch = 0;
  // The first read of My Cloud waits until the app has been up START_QUIET_MS: as if it had been asked just before.
  const neverAsked = now() - CLOUD_EVERY_MS + startQuietMs;
  let commandsSeen = null, saved = null, timer = null, pending = null, scope = null, cloudAskedAt = neverAsked, signIn = false, unheard = null, readying = 0;
  const placeShown = () => { const place = shown(); return place === "computer" || place === "cloud" ? place : null; };

  /** The file as last read or written: read once, then kept here. */
  const file = () => {
    if (saved) return saved;
    const read = readTogether(() => pref.read());
    if (!read.unreadable) saved = read;
    return read;
  };
  /** A file this app cannot read or does not understand is left as it is. */
  const untouchable = () => { const read = file(); return Boolean(read.unreadable || read.foreign || read.corrupt); };
  const write = (value) => { if (untouchable()) throw new Error("The switch's file is not one this app can change."); pref.write(value); saved = { kept: value }; };
  const chosen = () => (untouchable() ? false : choiceIn(file().kept, account()));
  const account = () => cloud().account ?? null;
  /** The default's notes for the signed-in account: the notice was shown, and closed or used. */
  const noted = (key) => stamped(file().kept[key], account());
  const note = (key, value) => {
    const { kept } = file(), who = account();
    if (!who || untouchable()) return;
    const map = { ...(record(kept[key]) ? kept[key] : {}) };
    if (value === null) delete map[who]; else map[who] = value;
    write({ ...kept, v: 1, [key]: map });
  };
  /** On: the person's own choice, else the default once the notice has been shown to this account. */
  const isOn = () => { const own = chosen(); return own === null ? noted("noticed") : own; };
  const available = () => Boolean(cloud().origin) && Boolean(computer());
  const active = () => isOn() && available();
  /** The notice of the default is due on this computer's page: offered, never chosen, and not closed by this account. */
  const noticeDue = () => available() && !untouchable() && chosen() === null && !noted("done");
  const tell = () => { try { changed(); } catch {} };

  function forget() {
    epoch += 1;
    kept.clear();
    reading.clear();
    aisWanted.clear();
    cloudAskedAt = neverAsked;
    signIn = false;
    readying = 0;
    try { void inPlace?.close(); } catch {}
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
    const here = computer();
    const next = origin && isOn() && here ? `${origin}\n${account ?? ""}\n${String(here)}` : null;
    if (next === scope) return;
    const had = kept.size > 0 || pending !== null;
    scope = next;
    forget();
    if (next === null) stopWatch();
    if (had) tell();
  }

  // A bot's newest few messages, for its preview (previewOf); nothing more of them is kept.
  async function ask(home, route = `/api/bots?messages=${PREVIEW_LOOK}`) {
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
    const mine = epoch, last = kept.get(home), said = (entry) => JSON.stringify([entry?.state, entry?.bots, entry?.sections, entry?.newBot, entry?.ais]);
    const held = (state) => ({ ...last, bots: last?.bots ?? [], sections: last?.sections ?? [], state });
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
          next = ais === "signin" ? signedOut() : { bots: botRows(body, home), sections: placeSections(body), state: "ready", newBot: makesNewBots(body), ...ais };
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

  /** Where this account put bots in the one list, kept beside its switch: a bot's key, its department and the bot above it.
   * Kept through the switch going off, a place asleep or out of reach, and a restart; a bot that is gone keeps its entry
   * too, which costs nothing and brings it back where it was if it returns. */
  function arrangedFor(who) {
    const all = file().kept.arranged;
    return parseArrangement(record(all) && typeof who === "string" && Array.isArray(all[who]) ? all[who] : []);
  }

  function otherOf(asking) {
    const home = otherHome(asking), known = kept.get(home);
    const state = home === "cloud" && (pending?.home === home || readying > 0) && (cloud().asleep || known?.state !== "ready") ? "waking"
      : home === "cloud" && cloud().asleep ? "asleep" : known?.state ?? "loading";
    return { home, state, bots: (known?.bots ?? []).map((row) => addressed(row)), ...(known?.sections?.length ? { sections: known.sections } : {}), ...(typeof known?.newBot === "boolean" ? { newBot: known.newBot } : {}) };
  }

  return {
    /** Whether the switch is on and both places exist: what anything else that joins the two places asks. */
    on: active,
    /** Whether the switch is on for the signed-in account with My Cloud, whatever runs on this computer now: whether this
     * computer's own workspace should be started to join it (together-background.mjs). */
    switchOn: () => Boolean(cloud().origin) && isOn(),
    /** The switch is offered (the person has My Cloud and a workspace of this computer's own runs), and whether it is on:
     * what the rail's circles show in their menu. Null when it is not offered. */
    offered: () => (available() ? { on: isOn() } : null),
    /** What `asking`'s page draws: the switch, and the other place's bots while it is on. */
    state(asking) {
      sameScope();
      const here = asking === "cloud" ? "cloud" : "computer";
      let notice = {};
      if (here === "computer" && available()) {
        let lent = false;
        try { lent = commands?.on() === true; } catch {}
        // My Cloud as home: this computer's own workspace starts with the app (together-background.mjs), which the notice says.
        notice = { ...(noticeDue() ? { notice: true, ...(String(computer()).startsWith("profile:") ? { profileHome: true } : {}) } : {}), commands: lent };
      }
      if (!active()) return { v: 1, available: available(), on: isOn(), here, other: null, ...notice };
      watch();
      void refresh(otherHome(here));
      // The person's home place, the same on both pages: the one list puts its bots first wherever the window is.
      const home = String(computer()).startsWith("profile:") ? "cloud" : "computer";
      return { v: 1, available: true, on: true, here, home, other: otherOf(here), arranged: arrangedFor(account()), ...notice };
    },
    /** The switch. Off forgets every list. Turned on from Settings on this computer's page, whose words say so, it also
     * lets My Cloud run commands here (`turnedOn`), so the two places work as one with one switch; the person turns that
     * alone off from the icon's menu. The rail's row and the notice (`listOnly`) switch the list alone, and the default
     * never lends anything. */
    set(asking, value, { listOnly = false } = {}) {
      const was = isOn(), next = value === true;
      // The person's own turn in Settings repairs a file that is not JSON at all: the bad one is kept beside it first.
      if (!listOnly && file().corrupt && typeof pref.backup === "function") { pref.backup(); saved = { choice: null, kept: { v: 1 } }; }
      const { kept } = file(), who = account();
      write({ ...kept, v: 1, on: next, choices: { ...(record(kept.choices) ? kept.choices : {}), ...(who ? { [who]: next } : {}) } });
      if (next && !was && asking === "computer" && !listOnly) { try { turnedOn(); } catch {} }
      sameScope();
      tell();
      return this.state(asking);
    },
    /** This computer's page shows the notice of the default: from now on it is on for this account. Nothing before this: an
     * app closed before the notice was seen has joined and linked nothing. Running commands here is left as it is. True
     * when it is on now. */
    noticeShown(asking) {
      sameScope();
      if (asking !== "computer" || !noticeDue() || !account()) return false;
      if (!noted("noticed")) note("noticed", now());
      sameScope();
      tell();
      return active();
    },
    /** The notice's own switch for "Let My Cloud's bots run commands on this computer", from this computer's page while the
     * joining is offered: the person's own choice, kept as the icon's menu keeps it. What it is now. */
    async setCommands(asking, value) {
      if (asking !== "computer" || !available() || !commands) throw new Error("Turn this from this computer's page.");
      await commands.set(value === true);
      tell();
      return commands.on();
    },
    /** Lending says whether My Cloud may run commands here (it changed, or it says it again): a page showing it asks again. */
    commandsChanged(on) {
      if (on === commandsSeen) return;
      commandsSeen = on;
      if (available()) tell();
    },
    /** The person closed the notice (Got it, its close button or Escape): it never shows again for this account. */
    noticeDone(asking) {
      if (asking !== "computer" || !account()) return;
      try { note("done", now()); } catch {}
      tell();
    },
    /** Off for the link (bot-link-main.mjs): the person turned it off, or never chose and has not seen the notice yet. A
     * file that cannot be read just now leaves the link alone. */
    switchedOff: () => !untouchable() && !isOn(),
    /** The person's own choice: true, false, or null while they never chose. */
    chosen,
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
    /** A row's click on this computer's page, where a My Cloud bot opens in this window: the session this computer's server
     * forwards it with is readied (waking My Cloud first), with the row "waking" meanwhile; `fresh`, a new one in place of
     * one My Cloud refused. `ok` false: the page opens it
     * with `open` instead, on My Cloud's own page. Only a bot main listed itself, for this Cloud and account. */
    async openInPlace(asking, botId, { fresh = false } = {}) {
      sameScope();
      if (asking !== "computer" || !active() || !inPlace) return { ok: false };
      const row = kept.get("cloud")?.bots.find((bot) => bot.id === botId);
      if (!row) return { ok: false };
      const mine = epoch;
      readying += 1;
      tell();
      try {
        const ready = await inPlace.ensure({ fresh });
        return { ok: mine === epoch && active() && ready?.ok === true };
      } catch { return { ok: false }; }
      finally { if (mine === epoch) { readying = Math.max(0, readying - 1); tell(); } }
    },
    /** Whether My Cloud is awake now, as the Admin says it (asked again when its word is old), for a bot open in place
     * whose stream went quiet: never a request to My Cloud itself, which would wake it. This computer's page only. */
    async cloudAwake(asking) {
      sameScope();
      if (asking !== "computer" || !active() || cloud().asleep) return false;
      const answered = await powerChecked().catch(() => false);
      return answered === true && active() && !cloud().asleep;
    },
    /** The person moved bots in the one list (a drag or Alt+Up/Down, on either page): their entries replace the ones they
     * had. Nothing of either place's own server changes here. What this account has kept now. */
    arrange(asking, entries) {
      sameScope();
      const who = account();
      if (!active() || !who || untouchable()) return arrangedFor(who);
      const next = parseArrangement(entries), keys = new Set(next.map((entry) => entry.key));
      if (!next.length) return arrangedFor(who);
      const { kept } = file();
      const had = arrangedFor(who), before = new Map(had.map((entry) => [entry.key, entry]));
      // The same arrangement again (a drop where the bot already was) writes nothing and tells no page.
      if (next.every((entry) => before.get(entry.key)?.section === entry.section && before.get(entry.key)?.after === entry.after)) return had;
      const merged = [...had.filter((entry) => !keys.has(entry.key)), ...next].slice(-MAX_LAID);
      write({ ...kept, v: 1, arranged: { ...(record(kept.arranged) ? kept.arranged : {}), [who]: merged } });
      tell();
      return merged;
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
      if (place === "cloud" && signIn) { signIn = false; cloudAskedAt = neverAsked; }
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
export function installPlacesTogether({ ipcMain, asking, together, rail = () => false }) {
  const side = (event) => {
    const page = asking(event);
    if (!page) throw new Error("Only this computer's page and My Cloud's page list each other's bots.");
    return page === "cloud" ? "cloud" : "computer";
  };
  ipcMain.handle("places-together:state", (event) => together.state(side(event)));
  ipcMain.handle("places-together:set", (event, value, from) => {
    const page = side(event);
    if (value === true && page !== "computer") throw new Error("Turn this on from this computer's page.");
    return together.set(page, value === true, { listOnly: from === "notice" });
  });
  ipcMain.handle("places-together:open", (event, botId) => together.open(side(event), String(botId)));
  ipcMain.handle("places-together:cloud-awake", (event) => together.cloudAwake(side(event)));
  ipcMain.handle("places-together:open-in-place", (event, botId, fresh) => together.openInPlace(side(event), String(botId), { fresh: fresh === true }));
  ipcMain.handle("places-together:arrange", (event, entries) => together.arrange(side(event), entries));
  ipcMain.handle("places-together:new-bot-choice", (event) => together.newBotChoice(side(event)));
  ipcMain.handle("places-together:new-bot", (event) => together.newBot(side(event)));
  ipcMain.handle("places-together:new-bot-heard", (event) => { side(event); together.newBotHeard(); });
  ipcMain.handle("places-together:notice-shown", (event) => together.noticeShown(side(event)));
  ipcMain.handle("places-together:notice-done", (event) => { together.noticeDone(side(event)); });
  ipcMain.handle("places-together:commands", (event, value) => together.setCommands(side(event), value === true));
  // The rail's own page (this app's, beside whichever place is open): Show bots together in a circle's menu.
  ipcMain.handle("places-together:rail-set", (event, value) => {
    if (!rail(event)) throw new Error("Only the window's rail turns this from a circle's menu.");
    return together.set("computer", value === true, { listOnly: true }).on;
  });
  return together;
}

/** The switch's file in the desktop app's own folder: read, written whole, and, before a corrupt one is repaired, kept beside
 * it as `<name>.unreadable-<time>`. */
export function togetherPrefFile(file, fs = nodeFs, now = Date.now) {
  return {
    read: () => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")),
    write: (value) => { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); },
    backup: () => fs.copyFileSync(file, `${file}.unreadable-${now()}`),
  };
}
