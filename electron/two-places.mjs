// Bots in two places can't work together: this computer has bots of its own while a server of the person's own, or My Cloud
// they keep this computer's bots away from, has bots too. One plain suggestion on this computer's page brings them
// together there, one tap away from the one-time move to that place; dismissed, it stays dismissed for that place.
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
 *   places(): Array<{ key: string, name: string, kind: "cloud" | "server", read(): Promise<unknown>, bring(): Promise<unknown> }>,
 *   settled(): boolean,
 *   dismissed: { read(): unknown, write(value: unknown): void },
 *   onChange?(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `local()`: this computer's move summary. `places()`: the places its bots could go to now, My Cloud first; each
 * `read()` is that place's move summary (null while it can't be asked, a sleeping Cloud included), `bring()` the one-time
 * move there. `settled()`: no move is under way or done, so this computer's bots are its own.
 */
export function createTwoPlaces({ local, places, settled, dismissed, onChange = () => {}, now = Date.now, log = () => {} }) {
  /** What each place had when last read: its bots by name, and when. */
  const known = new Map();
  let here = null, lookedAt = -Infinity, looking = null, said = "";
  const hidden = () => { try { return parseDismissed(dismissed.read()); } catch { return new Set(); } };

  function state() {
    if (!settled() || !here?.length) return { suggest: null };
    const away = hidden();
    for (const place of places()) {
      if (away.has(place.key) || !known.get(place.key)?.bots.length) continue;
      return { suggest: { key: place.key, name: place.name, kind: place.kind } };
    }
    return { suggest: null };
  }
  const tell = () => {
    const next = JSON.stringify(state());
    if (next === said) return;
    said = next;
    try { onChange(); } catch {}
  };

  /** Reads this computer and each place again, unless they were read lately (`force`: something about them changed). */
  function refresh({ force = false } = {}) {
    if (looking || (!force && now() - lookedAt < LOOK_EVERY_MS) || !settled()) return looking ?? Promise.resolve();
    lookedAt = now();
    looking = (async () => {
      here = usedBots(await local().catch(() => null));
      if (!here.length) return;
      for (const place of places()) {
        const summary = await place.read().catch((error) => { log(`two places: ${place.name} did not say which bots it has (${error?.message ?? error})`); return null; });
        if (summary) known.set(place.key, { bots: usedBots(summary), at: now() });
      }
    })().finally(() => { looking = null; tell(); });
    return looking;
  }

  return {
    state,
    refresh,
    /** The bots of this computer and of each place as last read, by name: the person's bots elsewhere, for each place. */
    bots: () => ({ here: here ?? [], places: Object.fromEntries([...known].map(([key, entry]) => [key, entry.bots])) }),
    /** Not now, for good: this place is never suggested again. */
    dismiss(key) {
      if (typeof key !== "string" || !KEY.test(key)) throw new Error("That isn't a place this app suggested.");
      const next = hidden();
      next.add(key);
      dismissed.write({ v: 1, keys: [...next].slice(-200) });
      tell();
      return state();
    },
    /** The one tap: the move to that place starts, and the suggestion goes. */
    async accept(key) {
      const suggested = state().suggest;
      const place = suggested?.key === key ? places().find((entry) => entry.key === key) : null;
      if (!place) throw new Error("Your bots can't be brought together there now.");
      await place.bring();
      known.delete(key);
      tell();
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
