// This computer and My Cloud as one workspace. Main reads the other side's bots and rooms for the page the window shows
// (My Cloud through the Cloud sign-in the window holds, this computer over loopback), and moves the window to the other
// side when one of them is opened there. A page never names a destination, never reads a secret and never changes the
// setting; the native menu does.
import { BACKGROUND_HEADERS, asleepAnswer } from "./cloud-power.mjs";
import { jsonFile } from "./desktop-prefs.mjs";

export const ROSTER_FRESH_MS = 5_000;
/** How long a read may hold a page before it gets the roster main already holds (and the answer follows as a change). */
export const READ_WAIT_MS = 2_500;
/** How long the chat a page asked to open waits for the other side's page to load. */
export const OPEN_FOR_MS = 120_000;
export const PICTURE_MAX_BYTES = 256 * 1024;
const PICTURES_KEPT = 300;
const MAX_ITEMS = 1_000;
const ROSTER_ROUTE = "/api/bots?messages=0";
/** Routines without their runs (runs start no earlier than this), and webhooks: what each bot does on its own. */
const AUTOMATION_ROUTES = [`/api/routines?from=${Number.MAX_SAFE_INTEGER}`, "/api/webhooks"];
export const AUTOMATIONS_FRESH_MS = 60_000;
const MAX_THREADS = 300;
/** How much of a conversation both copies have is compared: its newest messages. */
const THREAD_PAGE = 200;
/** At most this many conversations' messages are read per look at the other side; the rest wait for the next look. */
export const CHATS_PER_LOOK = 10;
const ACTIVITIES = new Set(["working", "waiting-on-you", "idle", "no-signal", "dead", "parked.computer"]);
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ID = /^[\w-]{1,128}$/;
const SIDES = ["computer", "cloud"];

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const optional = (key, value) => (value === undefined ? {} : { [key]: value });
export const otherSide = (side) => (side === "cloud" ? "computer" : "cloud");

/** The sidebar's own unread rule: routine runs and archived conversations never count. */
function shownUnread(bot) {
  if (!Array.isArray(bot.tasks) || bot.tasks.length === 0) return bot.unread === true;
  return bot.tasks.some((task) => record(task) && task.unread === true && !task.routineRunId && task.archivedAt === undefined);
}

/** A bot's open conversations, newest first, and those with something unread: ids only, never a title or a word. */
function conversations(bot) {
  const tasks = Array.isArray(bot.tasks) ? bot.tasks.filter((task) => record(task) && typeof task.threadId === "string" && ID.test(task.threadId) && task.archivedAt === undefined) : [];
  const threads = [...new Set([...(typeof bot.threadId === "string" && ID.test(bot.threadId) ? [bot.threadId] : []), ...tasks.map((task) => task.threadId)])].slice(0, MAX_THREADS);
  const unread = tasks.filter((task) => task.unread === true).map((task) => task.threadId).slice(0, MAX_THREADS);
  return { threads, ...optional("unreadThreads", unread.length ? unread : undefined) };
}

/** A read-only bot for another page: nothing a row does not show (no instructions, model, messages, tools or settings). */
export function rosterBot(bot) {
  if (!record(bot) || typeof bot.id !== "string" || !ID.test(bot.id) || bot.hidden === true) return null;
  const section = text(bot.section).trim();
  return {
    id: bot.id,
    threadId: typeof bot.threadId === "string" && ID.test(bot.threadId) ? bot.threadId : "",
    name: text(bot.name, 80) || "Bot",
    title: text(bot.title, 120),
    color: text(bot.color, 40) || "blue",
    ...optional("mascotExpression", typeof bot.mascotExpression === "string" ? text(bot.mascotExpression, 40) : undefined),
    ...optional("mascotBody", typeof bot.mascotBody === "string" ? text(bot.mascotBody, 40) : undefined),
    avatarUrl: typeof bot.avatarUrl === "string" && bot.avatarUrl ? bot.avatarUrl : null,
    ...optional("avatarCrop", record(bot.avatarCrop) ? bot.avatarCrop : undefined),
    ...optional("avatarZoom", number(bot.avatarZoom)),
    ...optional("avatarFocusX", number(bot.avatarFocusX)),
    ...optional("avatarFocusY", number(bot.avatarFocusY)),
    ...optional("section", section || undefined),
    ...optional("chiefOfStaff", bot.chiefOfStaff === true ? true : undefined),
    ...optional("pinned", bot.pinned === true ? true : undefined),
    unread: shownUnread(bot),
    ...optional("busy", bot.busy === true ? true : undefined),
    ...optional("activity", ACTIVITIES.has(bot.activity) ? bot.activity : undefined),
    ...optional("waitingForTeammates", bot.waitingForTeammates === true ? true : undefined),
    ...optional("computer", typeof bot.computer === "string" ? text(bot.computer, 20) : undefined),
    ...optional("cloudBackend", typeof bot.cloudBackend === "string" ? text(bot.cloudBackend, 20) : undefined),
    ...conversations(bot),
  };
}

/** Each bot's open conversations and the time of each one's newest message: what tells two copies of one apart. */
export function threadTimes(body) {
  const times = new Map();
  for (const bot of Array.isArray(body?.bots) ? body.bots : []) {
    if (!record(bot) || typeof bot.id !== "string" || !ID.test(bot.id) || bot.hidden === true) continue;
    const threads = new Map();
    for (const task of Array.isArray(bot.tasks) ? bot.tasks : []) {
      if (record(task) && typeof task.threadId === "string" && ID.test(task.threadId) && task.archivedAt === undefined) threads.set(task.threadId, number(task.updatedAt) ?? 0);
    }
    times.set(bot.id, threads);
  }
  return times;
}

/** Of two copies of one conversation (each its newest text messages, oldest first), how many messages each copy has
 * that the other lacks. Send keeps a message's id. One older than all that was read of the other copy may only be past
 * what was read, so it is not counted; two copies without a message in common are compared by time. */
export function unsharedCounts(cloudMessages, computerMessages) {
  const only = (mine, theirs) => {
    if (!theirs.length) return mine.length;
    const ids = new Set(theirs.map((message) => message.id));
    if (!mine.some((message) => ids.has(message.id))) return mine.filter((message) => message.at > theirs.at(-1).at).length;
    return mine.filter((message) => !ids.has(message.id) && message.at >= theirs[0].at).length;
  };
  return { cloud: only(cloudMessages, computerMessages), computer: only(computerMessages, cloudMessages) };
}

/** How many switched-on routines and webhooks each bot has, from GET /api/routines and GET /api/webhooks. */
export function automationCounts(...bodies) {
  const counts = new Map();
  for (const body of bodies) {
    for (const item of [...(Array.isArray(body?.routines) ? body.routines : []), ...(Array.isArray(body?.webhooks) ? body.webhooks : [])]) {
      if (record(item) && item.enabled === true && typeof item.botId === "string" && ID.test(item.botId)) counts.set(item.botId, (counts.get(item.botId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Rooms people open; a chat between two bots stays on its own side's page. */
export function rosterRoom(group) {
  if (!record(group) || typeof group.id !== "string" || !ID.test(group.id) || group.dm === true) return null;
  const section = text(group.section).trim();
  const working = group.working === true || typeof group.busyBotId === "string";
  return {
    id: group.id,
    name: text(group.name, 80) || "Room",
    memberIds: Array.isArray(group.memberIds) ? group.memberIds.filter((id) => typeof id === "string" && ID.test(id)).slice(0, 100) : [],
    unread: group.unread === true,
    ...optional("working", working ? true : undefined),
    ...optional("section", section || undefined),
  };
}

/** What GET /api/bots answers, as a roster's lists; anything malformed is left out, never partly trusted. */
export function parseRoster(body) {
  const bots = (Array.isArray(body?.bots) ? body.bots : []).slice(0, MAX_ITEMS).map(rosterBot).filter(Boolean);
  const rooms = (Array.isArray(body?.groups) ? body.groups : []).slice(0, MAX_ITEMS).map(rosterRoom).filter(Boolean);
  const sections = [...new Set((Array.isArray(body?.sections) ? body.sections : []).map((name) => text(name).trim()).filter(Boolean))].slice(0, MAX_ITEMS);
  return { bots, rooms, sections };
}

const emptyRoster = (side, state = "unreachable") => ({ side, state, at: null, bots: [], rooms: [], sections: [] });

function savedRoster(value, origin) {
  if (!record(value) || value.origin !== origin || !record(value.roster)) return null;
  const lists = parseRoster({ bots: value.roster.bots, groups: value.roster.rooms, sections: value.roster.sections });
  return { side: "cloud", state: "ready", at: number(value.roster.at) ?? null, ...lists };
}

/**
 * The one workspace's state, without Electron. `readCloud(route)` and `readLocal(route)` answer a GET on that side
 * (a Response); `cloud()` is My Cloud as main verified it ({ origin, name }) or null; `power` is My Cloud's power gate.
 * `localDefault()`: the server this computer runs is its default workspace, the one the merged view stands for.
 * `twinHome()`: which copy a bot on both sides shows as. `reason()`: the Admin's words for an unreachable Cloud.
 * `chatsArrive(botId)`: this computer's messages with that bot reach My Cloud by themselves, so they are never counted.
 */
export function createOneWorkspace({ store, cloud, readCloud, readLocal, power, localDefault = () => true, twinHome = () => "computer",
  reason = () => null, chatsArrive = () => false, now = Date.now, readWaitMs = READ_WAIT_MS, onChange = () => {} }) {
  let saved = null;
  const kept = () => {
    if (saved) return saved;
    try { const value = store.read(); saved = record(value) ? value : {}; } catch { saved = {}; }
    return saved;
  };
  const sides = Object.fromEntries(SIDES.map((side) => [side, { roster: null, refreshing: null, pictures: new Map(), automations: null, times: null, timesAt: null, reading: null }]));
  /** Per bot on both sides, its conversations where one copy has messages the other lacks. */
  let unshared = new Map(), comparing = null;
  /** Per conversation both copies have, once compared: its last counts. */
  const counted = new Map();
  /** Conversations whose copies were apart when last compared, kept across restarts: a send that gives both copies the
   * same newest message leaves them apart, and only this says to compare them again. */
  let apart = null;
  const apartKeys = () => (apart ??= new Set((Array.isArray(kept().apart) ? kept().apart : []).filter((key) => typeof key === "string").slice(0, MAX_THREADS)));
  /** Per side and conversation: the message ids read there, with that side's newest-message time when they were read. */
  const messageIds = new Map();
  let pending = null;

  const save = (patch) => { saved = { ...kept(), ...patch }; try { store.write(saved); } catch {} };
  const together = () => kept().together !== false;
  const possible = () => Boolean(cloud()?.origin) && localDefault();
  const available = () => together() && possible();
  const readerOf = (side) => (side === "cloud" ? readCloud : readLocal);

  /** A picture is kept once its side answered for it (an image, or a definite no); a failed read is tried again. */
  async function picture(side, url) {
    const kept = sides[side].pictures;
    if (kept.has(url)) return kept.get(url);
    let value = null, answered = false;
    try {
      const response = await readerOf(side)(url);
      const type = (response.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const length = Number(response.headers?.get?.("content-length") ?? 0);
      answered = response.ok || (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403);
      if (response.ok && PICTURE_TYPES.has(type) && length <= PICTURE_MAX_BYTES) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length <= PICTURE_MAX_BYTES) value = `data:${type};base64,${bytes.toString("base64")}`;
      } else await response.body?.cancel?.();
    } catch { answered = false; }
    if (!answered) return null;
    if (kept.size >= PICTURES_KEPT) kept.delete(kept.keys().next().value);
    kept.set(url, value);
    return value;
  }

  /** Each bot's picture from its own side, as a data: URL a page on the other origin can show. */
  async function withPictures(side, bots) {
    return Promise.all(bots.map(async (bot) => {
      const url = bot.avatarUrl;
      if (!url || url.startsWith("data:")) return bot;
      const local = url.startsWith("/") && !url.startsWith("//") ? await picture(side, url) : null;
      return { ...bot, avatarUrl: local };
    }));
  }

  async function read(side) {
    const last = sides[side].roster ?? (side === "cloud" ? savedRoster(kept().cloud, cloud()?.origin) : null) ?? emptyRoster(side);
    const keep = (state, extra = {}) => ({ ...last, side, state, ...extra });
    if (side === "cloud") {
      if (!cloud()?.origin) return emptyRoster(side);
      if (power?.asleep()) return keep("asleep");
    }
    let response;
    try { response = await readerOf(side)(ROSTER_ROUTE); } catch {
      const why = side === "cloud" ? reason() : null;
      return keep("unreachable", why ? { reason: why } : {});
    }
    if (side === "cloud" && asleepAnswer(response)) {
      await response.body?.cancel?.();
      power?.hold?.();
      return keep("asleep");
    }
    if (side === "cloud" && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel?.();
      return keep("signed-out");
    }
    let body = null;
    try { body = response.ok ? await response.json() : null; } catch { body = null; }
    if (!body) {
      const why = side === "cloud" ? reason() : null;
      return keep("unreachable", why ? { reason: why } : {});
    }
    const lists = parseRoster(body);
    sides[side].times = threadTimes(body);
    sides[side].timesAt = now();
    const counts = await automations(side);
    const bots = (await withPictures(side, lists.bots)).map((bot) => (counts.get(bot.id) ? { ...bot, automations: counts.get(bot.id) } : bot));
    const roster = { side, state: "ready", at: now(), ...lists, bots };
    if (side === "cloud") {
      const origin = cloud()?.origin;
      if (origin) save({ cloud: { origin, roster: { at: roster.at, bots: lists.bots.map((bot) => ({ ...bot, avatarUrl: null })), rooms: lists.rooms, sections: lists.sections } } });
    }
    return roster;
  }

  /** Read at most once a minute: they change rarely, and a failed read keeps the last counts. */
  async function automations(side) {
    const entry = sides[side];
    if (entry.automations && now() - entry.automations.at < AUTOMATIONS_FRESH_MS) return entry.automations.counts;
    try {
      const bodies = await Promise.all(AUTOMATION_ROUTES.map(async (route) => {
        const response = await readerOf(side)(route);
        if (!response.ok) { await response.body?.cancel?.(); throw new Error(`${response.status}`); }
        return response.json();
      }));
      entry.automations = { at: now(), counts: automationCounts(...bodies) };
    } catch {
      entry.automations ??= { at: 0, counts: new Map() };
    }
    return entry.automations.counts;
  }

  /** This page's own side's conversation times, for comparing them with the other side's. */
  function readTimes(side) {
    const entry = sides[side];
    if (entry.timesAt !== null && now() - entry.timesAt < ROSTER_FRESH_MS) return Promise.resolve();
    if (side === "cloud" && (!cloud()?.origin || power?.asleep())) return Promise.resolve();
    entry.reading ??= (async () => {
      try {
        const response = await readerOf(side)(ROSTER_ROUTE);
        if (!response.ok) { await response.body?.cancel?.(); return; }
        entry.times = threadTimes(await response.json());
        entry.timesAt = now();
      } catch {}
    })().finally(() => { entry.reading = null; });
    return entry.reading;
  }

  /** A conversation's newest text messages on `side`: ids and times, nothing else kept. */
  async function messagesOf(side, threadId) {
    const response = await readerOf(side)(`/api/threads/${threadId}/messages?limit=${THREAD_PAGE}`);
    if (side === "cloud" && asleepAnswer(response)) { await response.body?.cancel?.(); power?.hold?.(); throw new Error("asleep"); }
    if (!response.ok) { await response.body?.cancel?.(); throw new Error(`${response.status}`); }
    const body = await response.json();
    return (Array.isArray(body?.messages) ? body.messages : [])
      .filter((message) => record(message) && message.kind === "text" && typeof message.id === "string")
      .map((message) => ({ id: message.id, at: number(message.at) ?? 0 }));
  }

  /** My Cloud answered within this look and is not going to sleep: reading it then neither wakes it nor keeps it up. */
  const cloudAnswered = () => !power?.asleep() && sides.cloud.timesAt !== null && now() - sides.cloud.timesAt < ROSTER_FRESH_MS;

  /** The conversations both copies of a bot have. One whose newest-message times match and that was never compared nor
   * seen apart is not read. Otherwise a side's messages are read again only when its newest-message time there moved,
   * while My Cloud answered this look, for at most CHATS_PER_LOOK conversations per look, the most recent first; the
   * others keep their last counts until a later look. */
  async function compare() {
    const cloudTimes = sides.cloud.times, computerTimes = sides.computer.times;
    if (!cloudTimes || !computerTimes) return unshared;
    const both = [];
    for (const [botId, cloudThreads] of cloudTimes) {
      const computerThreads = computerTimes.get(botId);
      if (!computerThreads) continue;
      for (const [threadId, cloudAt] of cloudThreads) {
        const computerAt = computerThreads.get(threadId);
        if (computerAt !== undefined) both.push({ botId, threadId, at: { cloud: cloudAt, computer: computerAt } });
      }
    }
    both.sort((a, b) => Math.max(b.at.cloud, b.at.computer) - Math.max(a.at.cloud, a.at.computer));
    const next = new Map(), listed = new Set();
    let reads = 0;
    for (const { botId, threadId, at } of both) {
      const key = `${botId}:${threadId}`;
      listed.add(key);
      let counts = counted.get(key) ?? null;
      if (at.cloud === at.computer && !counts && !apartKeys().has(key)) continue;
      const moved = ["cloud", "computer"].filter((side) => messageIds.get(`${side}:${key}`)?.at !== at[side]);
      if (moved.length && reads < CHATS_PER_LOOK && cloudAnswered()) {
        reads++;
        try {
          for (const side of moved) messageIds.set(`${side}:${key}`, { at: at[side], messages: await messagesOf(side, threadId) });
          counts = unsharedCounts(messageIds.get(`cloud:${key}`).messages, messageIds.get(`computer:${key}`).messages);
        } catch {}
      }
      if (!counts) continue;
      counted.set(key, counts);
      if (counts.cloud || counts.computer) apartKeys().add(key);
      else apartKeys().delete(key);
      const shown = { cloud: counts.cloud, computer: chatsArrive(botId) === true ? 0 : counts.computer };
      if (shown.cloud || shown.computer) next.set(botId, [...(next.get(botId) ?? []), { threadId, ...shown }]);
    }
    for (const key of counted.keys()) if (!listed.has(key)) counted.delete(key);
    for (const key of apartKeys()) if (!listed.has(key)) apartKeys().delete(key);
    for (const key of messageIds.keys()) if (!counted.has(key.slice(key.indexOf(":") + 1))) messageIds.delete(key);
    const keep = [...apartKeys()].slice(0, MAX_THREADS);
    if (JSON.stringify(keep) !== JSON.stringify(kept().apart ?? [])) save({ apart: keep });
    return next;
  }

  function refreshUnshared() {
    comparing ??= compare().then((next) => {
      const changed = JSON.stringify([...next]) !== JSON.stringify([...unshared]);
      unshared = next;
      if (changed) onChange();
    }).catch(() => {}).finally(() => { comparing = null; });
    return comparing;
  }

  const comparable = (roster) => roster && JSON.stringify({ ...roster, at: null });
  const same = (a, b) => comparable(a) === comparable(b);
  function refresh(side) {
    const entry = sides[side];
    entry.refreshing ??= read(side).then((roster) => {
      const changed = !same(entry.roster, roster);
      entry.roster = roster;
      if (changed) onChange();
      return roster;
    }).finally(() => { entry.refreshing = null; });
    return entry.refreshing;
  }

  function snapshot(page, roster) {
    const target = cloud();
    return { page, twinHome: twinHome() === "cloud" ? "cloud" : "computer", cloudName: text(target?.name, 60) || "My Cloud", other: roster,
      ...(unshared.size ? { unshared: Object.fromEntries(unshared) } : {}) };
  }

  function rosterFor(side) {
    const entry = sides[side];
    if (entry.roster) return entry.roster;
    const last = side === "cloud" ? savedRoster(kept().cloud, cloud()?.origin) : null;
    return last ? { ...last, state: power?.asleep() ? "asleep" : "unreachable" } : emptyRoster(side, side === "cloud" && power?.asleep() ? "asleep" : "unreachable");
  }

  return {
    together,
    setTogether(on) { save({ together: on === true }); onChange(); },
    possible,
    available,
    /** What a page shows now, without reading anything. */
    peek(page) {
      if (!SIDES.includes(page) || !available()) return null;
      return snapshot(page, rosterFor(otherSide(page)));
    },
    /** The other side's roster for `page`: at once from what main holds, read again when older than ROSTER_FRESH_MS. */
    async view(page) {
      if (!SIDES.includes(page) || !available()) return null;
      const side = otherSide(page), entry = sides[side];
      const stale = !entry.roster || entry.roster.at === null || now() - entry.roster.at >= ROSTER_FRESH_MS || entry.roster.state !== "ready";
      if (stale) {
        let timer;
        const reading = Promise.all([refresh(side), readTimes(page)]).then(refreshUnshared);
        await Promise.race([reading, new Promise((resolve) => { timer = setTimeout(resolve, readWaitMs); timer.unref?.(); })]);
        clearTimeout(timer);
      }
      if (!available()) return null;
      return snapshot(page, rosterFor(side));
    },
    /** A bot or room of the other side, as that side's page opens it once the window shows it. */
    open(page, target) {
      if (!SIDES.includes(page) || !available()) throw new Error("This computer and My Cloud are shown apart. Switch to the other one from the menu at the top of the sidebar.");
      const side = record(target) && SIDES.includes(target.side) ? target.side : null;
      const id = record(target) && typeof target.id === "string" && ID.test(target.id) ? target.id : null;
      if (!side || side === page || !id) throw new Error("Choose a bot or room to open.");
      const roster = rosterFor(side);
      const bot = roster.bots.find((entry) => entry.id === id);
      if (!bot && !roster.rooms.some((room) => room.id === id)) {
        throw new Error(side === "cloud" ? "That bot is no longer on My Cloud." : "That bot is no longer on this computer.");
      }
      const thread = record(target) && typeof target.threadId === "string" && bot?.threads?.includes(target.threadId) ? target.threadId : null;
      pending = { side, link: thread ? `openmausbot://thread/${thread}?bot=${id}` : `openmausbot://bot/${id}`, at: now() };
      return { side };
    },
    cancelOpen() { pending = null; },
    /** The chat link the page on `page`'s side should open now that it loaded, once. */
    take(page) {
      if (!pending || pending.side !== page || now() - pending.at > OPEN_FOR_MS) return null;
      const { link } = pending;
      pending = null;
      return link;
    },
  };
}

/** The switcher's part: one entry for both, and the setting, while this computer has My Cloud. */
export function oneWorkspaceMenu(one, entry, onToggle) {
  if (!entry || !one.possible()) return {};
  return { together: { cloudId: entry.id, label: "All bots", detail: `This computer and ${entry.name}`, on: one.together(), onToggle } };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   page: (event: unknown) => "local" | "cloud" | null,
 *   window: () => { isDestroyed(): boolean, webContents: { send(channel: string, value: unknown): void, mainFrame: { url: string } } } | null,
 *   localOrigin: () => string,
 *   file: () => string,
 *   cloud: () => { origin: string, name: string } | null,
 *   cookieFetch: typeof fetch,
 *   reconnect: (origin: string) => Promise<boolean>,
 *   power: { asleep(): boolean, hold?(): void },
 *   local: (route: string) => Promise<Response>,
 *   localDefault: () => boolean,
 *   twinHome: () => "computer" | "cloud",
 *   reason?: () => string | null,
 *   chatsArrive?: (botId: string) => boolean,
 *   goCloud: () => Promise<unknown>,
 *   goLocal: () => Promise<unknown>,
 *   files?: typeof import("node:fs"),
 * }} deps `page(event)`: "local" for this computer's page, "cloud" for the verified My Cloud page. `goCloud`/`goLocal`:
 * main's own ways to show that side (waking and signing in to My Cloud included).
 */
export function installOneWorkspace({ ipcMain, page, window, localOrigin, file, cloud, cookieFetch, reconnect, power, local, localDefault, twinHome,
  reason = () => null, chatsArrive = () => false, goCloud, goLocal, files }) {
  const readCloud = async (route) => {
    const target = cloud();
    if (!target) throw new Error("no Cloud");
    const ask = () => cookieFetch(`${target.origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json, image/*", origin: target.origin, ...BACKGROUND_HEADERS } });
    const response = await ask();
    if (response.status !== 401 || !(await reconnect(target.origin))) return response;
    await response.body?.cancel?.();
    return ask();
  };
  const shown = () => {
    const win = window();
    if (!win || win.isDestroyed()) return null;
    try {
      const origin = new URL(win.webContents.mainFrame.url).origin;
      return origin === localOrigin() ? "computer" : origin === cloud()?.origin ? "cloud" : null;
    } catch { return null; }
  };
  const one = createOneWorkspace({
    store: { read: () => jsonFile(file(), files).read(), write: (value) => jsonFile(file(), files).write(value) }, cloud, readCloud, readLocal: local, power, localDefault, twinHome, reason,
    chatsArrive, onChange: () => { const side = shown(); if (side) window().webContents.send("one-workspace:view", one.peek(side)); },
  });
  const asking = (channel, event) => {
    const which = page(event);
    if (which === "local") return "computer";
    if (which === "cloud") return "cloud";
    throw new Error(`${channel} is only available in this app's window`);
  };
  ipcMain.handle("one-workspace:view", (event) => one.view(asking("one-workspace:view", event)));
  ipcMain.handle("one-workspace:take", (event) => one.take(asking("one-workspace:take", event)));
  ipcMain.handle("one-workspace:open", async (event, target) => {
    const { side } = one.open(asking("one-workspace:open", event), target);
    try { await (side === "cloud" ? goCloud() : goLocal()); } catch (error) { one.cancelOpen(); throw error; }
  });
  return {
    /** Spread into the switcher's template options: `entry` is My Cloud's saved Servers entry. */
    menu: (entry) => oneWorkspaceMenu(one, entry, () => one.setTogether(!one.together())),
    one,
  };
}
