// Bots in two places can't work together: this computer has bots of its own while a server of the person's own, or My Cloud
// they keep this computer's bots away from, has bots too. One plain suggestion on this computer's page brings them
// together there, one tap away from the one-time move to that place; dismissed, it stays dismissed for that place. Each of
// the person's own places is also told the names of the bots their other places have, and nothing more, so a bot looking
// for one of those says where it lives (server/places-elsewhere.ts).
//
// Which bots count is what the move itself would carry (each place's own move summary): a place's untouched first bot,
// which every new place has, never makes it two places.

import nativeText from "./native-text.cjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** What PUT /api/places/elsewhere takes. */
const MAX_PLACES = 20;
/** A place is read again at most this often, unless something about the places changed. */
export const LOOK_EVERY_MS = 10 * 60_000;
const KEY = /^(?:cloud|server):[^\s]{1,300}$/u;
/** A place's bots, as last read, are told on while it can't be read (asleep, offline, signed out), and for this long once
 * it is no longer among the person's places at all. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
/** Each place is told again this often though nothing changed, so what it holds says how fresh it is. */
const RETELL_MS = 60 * 60_000;
const KINDS = new Set(["cloud", "server"]);

/** What a place on an older version is told instead: without when, places not read yet or no longer listed; then without
 * teams too. */
const OLDER = [
  (places) => places,
  (places) => places.filter((place) => place.bots.length && !place.away).map(({ name, kind, bots }) => ({ name, kind, bots })),
  (places) => OLDER[1](places).filter((place) => place.kind !== "team"),
];

/** A place's move summary, which is how bots are counted; anything else is no answer. */
const isSummary = (value) => record(value) && Array.isArray(value.items);

/** The bots a place's move summary names, by name: the ones a move would carry. */
export function usedBots(summary) {
  const items = record(summary) && Array.isArray(summary.items) ? summary.items : [];
  return [...new Set(items.filter((item) => record(item) && item.kind === "bot" && typeof item.label === "string" && item.label.trim()).map((item) => item.label.trim()))];
}

const ACCOUNT = /^[^\s]{0,200}$/u;
/** Each account's own places' bots as last read, read back: `{ [account]: { [key]: { name, kind, bots, at } } }`, "" for
 * the places of nobody signed in. A team keeps its own (team-places.mjs). */
export function parseLastRead(value) {
  const out = {};
  if (!record(value) || value.v !== 2 || !record(value.accounts)) return out;
  for (const [account, places] of Object.entries(value.accounts).slice(0, 20)) if (ACCOUNT.test(account)) out[account] = placesOf(places);
  return out;
}
function placesOf(value) {
  const out = {};
  if (!record(value)) return out;
  for (const [key, place] of Object.entries(value).slice(0, MAX_PLACES)) {
    if (!KEY.test(key) || !record(place) || typeof place.name !== "string" || !place.name.trim() || !KINDS.has(place.kind) || !Array.isArray(place.bots)
      || !Number.isSafeInteger(place.at) || place.at < 0) continue;
    out[key] = { name: place.name, kind: place.kind, bots: place.bots.filter((bot) => typeof bot === "string" && bot.trim()).slice(0, 500), at: place.at };
  }
  return out;
}

/** The places dismissed, read back. */
export function parseDismissed(value) {
  return new Set(record(value) && value.v === 1 && Array.isArray(value.keys) ? value.keys.filter((key) => typeof key === "string" && KEY.test(key)).slice(0, 200) : []);
}

/**
 * @param {{
 *   local(): Promise<unknown>,
 *   here?: { name(): Promise<string | null>, tell(payload: unknown): Promise<unknown> },
 *   places(): Array<{ key: string, name: string, kind: "cloud" | "server" | "team", read(): Promise<unknown>, tell?(payload: unknown): Promise<unknown>, bring?(): Promise<unknown> }>,
 *   settled(): boolean,
 *   quiet?(): boolean,
 *   dismissed: { read(): unknown, write(value: unknown): void },
 *   lastRead?: { read(): unknown, write(value: unknown): void },
 *   account?(): { id: string | null, signedOut: boolean } | undefined,
 *   onChange?(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `local()`: this computer's move summary, null once its bots moved. `here`: what the person's other places call
 * this computer, and telling it where their other bots live. `places()`: the person's own places besides this computer, My
 * Cloud first; each `read()` is that place's move summary (null while it can't be asked, a sleeping Cloud included),
 * `tell()` tells it where their other bots live, and `bring()` (only where this computer's bots could go now) is the
 * one-time move there; a team has neither, it is only read. `settled()`: no move is under way or done, so this computer's bots are its own. `quiet()`: a move is
 * under way, so nothing is read or told until it is done. `lastRead`: each own place's bots as last read, kept
 * across restarts, so a place that can't be read now is still told as it was, with when, never as having no bots.
 * `account()`: who is signed in (undefined while that is not known yet, when nothing is read or told): what is kept is
 * that account's alone, never told while another is signed in, and all of it is forgotten once nobody is.
 */
export function createTwoPlaces({ local, here: computer = null, places, settled, quiet = () => false, dismissed, lastRead = null, account = () => ({ id: null, signedOut: false }), onChange = () => {}, now = Date.now, log = () => {}, t = nativeText.englishText.t }) {
  /** What each place had when read in this run: its bots by name, and when. Only this drives the suggestion. */
  const known = new Map();
  /** What each place was last told, so it is told again only once that changes. */
  const told = new Map();
  /** This computer's bots: undefined until it first answers, null once they moved. */
  let here, hereAt = 0, lookedAt = -Infinity, looking = null, said = "", whose = null;
  /** Each place last told in a shape an older version refuses less of (1: without when or places not read, 2: nor teams). */
  const older = new Map();
  const everything = () => { try { return parseLastRead(lastRead?.read()); } catch { return {}; } };
  const save = (before, all) => {
    if (JSON.stringify(all) === JSON.stringify(before)) return;
    try { lastRead.write({ v: 2, accounts: all }); } catch {}
  };
  const remembered = () => everything()[whose ?? ""] ?? {};
  /** A good read of an own place is kept, one with no bots too: only a good read may say a place has none. Written only
   * when that changed, or about once an hour for when. */
  const keep = (place, bots) => {
    if (!lastRead || !KINDS.has(place.kind)) return;
    const all = everything(), before = structuredClone(all), mine = all[whose ?? ""] ??= {};
    // The person has one Cloud of their own: one at a new address replaces the one before.
    for (const key of Object.keys(mine)) if (key !== place.key && place.kind === "cloud" && mine[key].kind === "cloud") delete mine[key];
    const last = mine[place.key];
    if (!last || last.name !== place.name || JSON.stringify(last.bots) !== JSON.stringify(bots) || now() - last.at >= RETELL_MS) mine[place.key] = { name: place.name, kind: place.kind, bots, at: now() };
    all[whose ?? ""] = Object.fromEntries(Object.entries(mine).slice(-MAX_PLACES));
    save(before, all);
  };
  /** Who is signed in now: another account starts afresh, and once nobody is, what every account had is forgotten. */
  const signedIn = (who) => {
    const next = who.id ?? null;
    if (next !== whose) known.clear();
    whose = next;
    if (who.signedOut && lastRead) {
      const all = everything(), before = structuredClone(all);
      for (const key of Object.keys(all)) if (key !== "") delete all[key];
      save(before, all);
    }
  };
  const hidden = () => { try { return parseDismissed(dismissed.read()); } catch { return new Set(); } };

  function state() {
    if (!settled() || !here?.length) return { suggest: null };
    const away = hidden();
    for (const place of places()) {
      if (!place.bring || away.has(place.key) || !known.get(place.key)?.bots.length) continue;
      return { suggest: { key: place.key, name: place.name, kind: place.kind } };
    }
    return { suggest: null };
  }
  const changed = () => {
    const next = JSON.stringify(state());
    if (next === said) return;
    said = next;
    try { onChange(); } catch {}
  };

  /** Each place, this computer included, hears which bots the person's other places have: names only, and only when that
   * changed since it was last told. */
  async function tellEach(listed) {
    const name = computer && here?.length ? await computer.name().catch(() => null) : null;
    // This computer couldn't say what it is called: only it is told, so no other place hears it has no bots.
    const unnamed = Boolean(computer && here?.length && !name);
    // A place read in this run says what it has. One that can't be read now says what it had when last read, with when;
    // an own place never read yet is told with no bots, so its bots are not taken to be none (a team keeps its own).
    const kept = remembered(), listedKeys = new Set(listed.map((place) => place.key));
    const others = listed.flatMap((place) => {
      const last = known.get(place.key) ?? kept[place.key];
      if (!last) return KINDS.has(place.kind) ? [{ key: place.key, name: place.name, kind: place.kind, bots: [] }] : [];
      return last.bots.length ? [{ key: place.key, name: place.name, kind: place.kind, bots: last.bots, seen: last.at }] : [];
    });
    const same = (last) => listed.some((place) => place.kind === last.kind && (last.kind === "cloud" || place.name === last.name));
    // No longer listed (signed out of it, cancelled, its owner unconfirmed): named for a while, but nothing is offered there.
    const gone = Object.entries(kept).filter(([key, last]) => !listedKeys.has(key) && !same(last) && last.bots.length && now() - last.at < KEEP_MS)
      .map(([key, last]) => ({ key, name: last.name, kind: last.kind, bots: last.bots, seen: last.at, away: true }));
    const everyone = [...(name ? [{ key: "here", name, kind: "computer", bots: here, seen: hereAt }] : []), ...others, ...gone];
    const receivers = [...(computer && here !== null ? [{ key: "here", name: t("computer.badge.local"), kind: "computer", tell: computer.tell }] : []), ...(unnamed ? [] : listed.filter((place) => place.tell))];
    for (const receiver of receivers) {
      const payload = { v: 1, self: { name: receiver.name, kind: receiver.kind },
        places: everyone.filter((place) => place.key !== receiver.key).slice(0, MAX_PLACES).map(({ name: placeName, kind, bots, seen, away }) => ({ name: placeName, kind, bots: bots.slice(0, 500), ...(seen === undefined ? {} : { seen }), ...(away ? { away } : {}) })) };
      const signature = JSON.stringify({ ...payload, places: payload.places.map((place) => ({ ...place, seen: place.seen === undefined ? null : Math.floor(place.seen / RETELL_MS) })) });
      if (told.get(receiver.key) === signature) continue;
      try {
        // A place on an older version refuses a field it does not know (when, away), and an older one still a team: it
        // hears what it understands, in the shape it took before, so telling it again costs one request.
        for (let level = older.get(receiver.key) ?? 0, sent = null, refused = null; ; level++) {
          const places = OLDER[level](payload.places), shape = JSON.stringify(places), last = level === OLDER.length - 1;
          if (shape === sent) { if (last) throw refused; continue; }
          try { await receiver.tell({ ...payload, places }); older.set(receiver.key, level); break; }
          catch (error) { if (error?.status !== 400 || last) throw error; sent = shape; refused = error; }
        }
        told.set(receiver.key, signature);
      } catch (error) { log(`two places: ${receiver.name} was not told where the other bots live (${error?.message ?? error})`); }
    }
  }

  /** Reads this computer and each place again, then tells each where the person's other bots live, unless they were read
   * lately (`force`: something about them changed). */
  function refresh({ force = false } = {}) {
    if (looking || (!force && now() - lookedAt < LOOK_EVERY_MS) || quiet()) return looking ?? Promise.resolve();
    let who;
    try { who = account(); } catch { who = undefined; }
    if (!who) return Promise.resolve();
    lookedAt = now();
    signedIn(who);
    looking = (async () => {
      const summary = await local().catch((error) => { log(`two places: this computer did not say which bots it has (${error?.message ?? error})`); return undefined; });
      // No answer here keeps what it had: never taken as no bots, nor as moved.
      if (summary === null) here = null;
      else if (isSummary(summary)) { here = usedBots(summary); hereAt = now(); }
      const listed = places();
      for (const place of listed) {
        const read = await place.read().catch((error) => { log(`two places: ${place.name} did not say which bots it has (${error?.message ?? error})`); return null; });
        // No answer, or not a move summary (a sign-in page, an error): what it had when last read stands.
        if (!isSummary(read)) continue;
        const bots = usedBots(read);
        known.set(place.key, { bots, at: now() });
        keep(place, bots);
      }
      // Until this computer first answers, nobody is told: they would hear it has no bots.
      if (here !== undefined) await tellEach(listed);
    })().finally(() => { looking = null; changed(); });
    return looking;
  }

  return {
    state,
    refresh,
    /** The bots of this computer and of each place as last read, by name. */
    bots: () => ({ here: here ?? [], places: Object.fromEntries([...known].map(([key, entry]) => [key, entry.bots])) }),
    /** Not now, for good: this place is never suggested again. */
    dismiss(key) {
      if (typeof key !== "string" || !KEY.test(key)) throw new Error(t("native.home.placeNotSuggested"));
      const next = hidden();
      next.add(key);
      dismissed.write({ v: 1, keys: [...next].slice(-200) });
      changed();
      return state();
    },
    /** The one tap: the move to that place starts, and the suggestion goes. */
    async accept(key) {
      const suggested = state().suggest;
      const place = suggested?.key === key ? places().find((entry) => entry.key === key && entry.bring) : null;
      if (!place) throw new Error(t("native.home.bringUnavailable"));
      await place.bring();
      known.delete(key);
      changed();
      return state();
    },
  };
}

/** The suggestion's channels, for this computer's own page only (`guard`), and its changes told to that page (`send`). */
export function installTwoPlaces({ ipcMain, guard, twoPlaces }) {
  ipcMain.handle("two-places:state", guard("two-places:state", () => { void twoPlaces.refresh(); return twoPlaces.state(); }));
  ipcMain.handle("two-places:accept", guard("two-places:accept", (_event, key) => twoPlaces.accept(String(key))));
  ipcMain.handle("two-places:dismiss", guard("two-places:dismiss", (_event, key) => twoPlaces.dismiss(String(key))));
}
