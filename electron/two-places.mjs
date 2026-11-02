// Bots in two places can't work together: this computer has bots of its own while a server of the person's own, or My Cloud
// they keep this computer's bots away from, has bots too. One plain suggestion on this computer's page brings them
// together there, one tap away from the one-time move to that place; dismissed, it stays dismissed for that place. Each of
// the person's own places is also told the names of the bots their other places have, and nothing more, so a bot looking
// for one of those says where it lives (server/places-elsewhere.ts).
//
// Which bots count is what the move itself would carry (each place's own move summary): a place's untouched first bot,
// which every new place has, never makes it two places.

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** A place is read again at most this often, unless something about the places changed. */
export const LOOK_EVERY_MS = 10 * 60_000;
const KEY = /^(?:cloud|server):[^\s]{1,300}$/u;

/** The bots a place's move summary names, by name: the ones a move would carry. */
export function usedBots(summary) {
  const items = record(summary) && Array.isArray(summary.items) ? summary.items : [];
  return [...new Set(items.filter((item) => record(item) && item.kind === "bot" && typeof item.label === "string" && item.label.trim()).map((item) => item.label.trim()))];
}

/** The places dismissed, read back. */
export function parseDismissed(value) {
  return new Set(record(value) && value.v === 1 && Array.isArray(value.keys) ? value.keys.filter((key) => typeof key === "string" && KEY.test(key)).slice(0, 200) : []);
}

/**
 * @param {{
 *   local(): Promise<unknown>,
 *   here?: { name(): Promise<string | null>, tell(payload: unknown): Promise<unknown> },
 *   places(): Array<{ key: string, name: string, kind: "cloud" | "server", read(): Promise<unknown>, tell?(payload: unknown): Promise<unknown>, bring?(): Promise<unknown> }>,
 *   settled(): boolean,
 *   quiet?(): boolean,
 *   dismissed: { read(): unknown, write(value: unknown): void },
 *   onChange?(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `local()`: this computer's move summary, null once its bots moved. `here`: what the person's other places call
 * this computer, and telling it where their other bots live. `places()`: the person's own places besides this computer, My
 * Cloud first; each `read()` is that place's move summary (null while it can't be asked, a sleeping Cloud included),
 * `tell()` tells it where their other bots live, and `bring()` (only where this computer's bots could go now) is the
 * one-time move there. `settled()`: no move is under way or done, so this computer's bots are its own. `quiet()`: a move is
 * under way, so nothing is read or told until it is done.
 */
export function createTwoPlaces({ local, here: computer = null, places, settled, quiet = () => false, dismissed, onChange = () => {}, now = Date.now, log = () => {} }) {
  /** What each place had when last read: its bots by name, and when. */
  const known = new Map();
  /** What each place was last told, so it is told again only once that changes. */
  const told = new Map();
  let here = null, lookedAt = -Infinity, looking = null, said = "";
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
    const everyone = [...(name ? [{ key: "here", name, kind: "computer", bots: here }] : []),
      ...listed.filter((place) => known.get(place.key)?.bots.length).map((place) => ({ key: place.key, name: place.name, kind: place.kind, bots: known.get(place.key).bots }))];
    const receivers = [...(computer && here !== null ? [{ key: "here", name: "this computer", kind: "computer", tell: computer.tell }] : []), ...listed.filter((place) => place.tell)];
    for (const receiver of receivers) {
      const payload = { v: 1, self: { name: receiver.name, kind: receiver.kind },
        places: everyone.filter((place) => place.key !== receiver.key).map(({ name: placeName, kind, bots }) => ({ name: placeName, kind, bots: bots.slice(0, 500) })) };
      const signature = JSON.stringify(payload);
      if (told.get(receiver.key) === signature) continue;
      try { await receiver.tell(payload); told.set(receiver.key, signature); }
      catch (error) { log(`two places: ${receiver.name} was not told where the other bots live (${error?.message ?? error})`); }
    }
  }

  /** Reads this computer and each place again, then tells each where the person's other bots live, unless they were read
   * lately (`force`: something about them changed). */
  function refresh({ force = false } = {}) {
    if (looking || (!force && now() - lookedAt < LOOK_EVERY_MS) || quiet()) return looking ?? Promise.resolve();
    lookedAt = now();
    looking = (async () => {
      const summary = await local().catch(() => undefined);
      here = summary === null ? null : usedBots(summary);
      const listed = places();
      for (const place of listed) {
        const read = await place.read().catch((error) => { log(`two places: ${place.name} did not say which bots it has (${error?.message ?? error})`); return null; });
        if (read) known.set(place.key, { bots: usedBots(read), at: now() });
      }
      await tellEach(listed);
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
      if (typeof key !== "string" || !KEY.test(key)) throw new Error("That isn't a place this app suggested.");
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
      if (!place) throw new Error("Your bots can't be brought together there now.");
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
