// The saved places that belong to the signed-in account: My Cloud, its other Clouds and its teams' Clouds. Servers
// connected by hand and This computer belong to nobody's account and stay.
//
// Security: a team's Cloud can be shared by two accounts on this device, at one address, so nothing the window kept for it
// under one account may be there for the other: every kind of storage goes for a team's Cloud. A Cloud of one account's own
// has no other account's person in it, so only its session goes and its page keeps what it remembers.
import environments from "./environments.cjs";

const SHARED_STORAGE = Object.freeze(["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"]);
const OWN_STORAGE = Object.freeze(["cookies"]);

/** `mine`: My Cloud's verified address, for a My Cloud that was saved by hand before it was known to be one. */
export const accountPlace = (entry, mine = null) => entry?.kind !== "local" && Boolean(entry?.home === true || entry?.team || entry?.cloud || (mine && entry?.origin === mine));

/** The saved places that are the account's. */
export const accountPlaces = (saved, mine = null) => saved.environments.filter((entry) => accountPlace(entry, mine));

/** The saved places without `left`, by id. The window goes to This computer if it showed one of them. */
export function withoutPlaces(saved, left) {
  const ids = new Set(left.map((entry) => entry.id));
  if (!saved.environments.some((entry) => ids.has(entry.id))) return saved;
  const active = ids.has(saved.activeId) ? environments.LOCAL_ID : saved.activeId;
  return { ...saved, environments: saved.environments.filter((entry) => !ids.has(entry.id)), activeId: active };
}

/** The saved places without the account's, and which those were. */
export function withoutAccountPlaces(saved, mine = null) {
  const left = accountPlaces(saved, mine);
  return { saved: withoutPlaces(saved, left), left };
}

/** What the window holds for each of these places goes: the next opening signs in with the Admin's one-time code. */
export async function clearPlaceStorage(session, places, log = () => {}) {
  await Promise.all(places.filter((entry) => entry.origin).map((entry) => session.clearStorageData({ origin: entry.origin, storages: [...(entry.team ? SHARED_STORAGE : OWN_STORAGE)] })
    .catch((error) => log(`accounts: could not clear what the window kept for a place (${error?.message ?? error})`))));
}

/** Each account's places while it waits: as they were saved (`places`, the same ids, so what was lent to them and their colours
 * come back with them), and as the rail showed them (`rows`). `store`: a JSON file of names and addresses, no secret. */
export function createPlaceStash(store) {
  const all = () => { try { const value = store.read(); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } };
  const one = (kept) => ({ places: Array.isArray(kept?.places) ? kept.places : [], rows: Array.isArray(kept?.rows) ? kept.rows : [] });
  return {
    put(accountId, places, rows = []) { if (accountId) store.write({ ...all(), [accountId]: { places, rows } }); },
    take(accountId) {
      const kept = all();
      if (accountId in kept) { const { [accountId]: _, ...rest } = kept; store.write(rest); }
      return one(kept[accountId]);
    },
    peek: (accountId) => one(all()[accountId]),
  };
}

/** The saved places with an account's kept ones back; one saved here meanwhile under the same address stays as it is. */
export function withPlacesBack(saved, places) {
  const origins = new Set(saved.environments.map((entry) => entry.origin).filter(Boolean)), ids = new Set(saved.environments.map((entry) => entry.id));
  const back = places.filter((entry) => !origins.has(entry.origin) && !ids.has(entry.id));
  return back.length ? { ...saved, environments: [...saved.environments, ...back] } : saved;
}
