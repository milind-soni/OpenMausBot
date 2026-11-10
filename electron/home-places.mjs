// The places one window can show besides My Cloud: each team the verified session lists, and each other Cloud of the
// person's own it lists. Main keeps them as saved places (environments.cjs `team` and `cloud` entries, so the window's
// navigation rules know their addresses) and here what else the switcher needs: the place to open next time, and the one
// line waiting for the next page (a team this person is no longer in). Nothing here comes from a page: the lists are the
// Admin's session's, read by main. Who can see a team's private chats is said by the team's own page, in the chat (T2's
// TeamPrivateChatsLine), not here.
import environments from "./environments.cjs";
import { listedColors, ownCloudPlaces } from "./cloud-list.mjs";

const idOf = (value) => (typeof value === "string" && value ? value : null);
/** What home-place.json may name: a team's Cloud, another Cloud of the person's own, a workspace of this computer's own
 * (by its profile id) or a server saved by hand (by its saved place's id). */
const KINDS = Object.freeze(["team", "cloud", "profile", "server"]);

/**
 * @param {{
 *   store: { read(): unknown, write(value: unknown): void },
 *   environments(): { environments: any[], activeId: string },
 *   persist(state: unknown): void,
 *   makeId(): string,
 *   homeOrigin(): string | null,
 *   synced?(state: any): void,
 *   log?(line: string): void,
 * }} deps `store`: this app's home-place.json (`{ team }` or `{ cloud }`); `environments()` / `persist()`: the saved
 * places and their file; `homeOrigin()`: My Cloud's verified origin, the place the window falls back to. `synced(state)`: each sign-in state as it
 * comes, after the places follow it (a team the person just joined opens from there: team-join-main.mjs).
 */
export function createHomePlaces({ store, environments: read, persist, makeId, homeOrigin, synced = () => {}, log = () => {} }) {
  let cached = null;
  const pending = [];
  /** One kind of place at most: the first of KINDS the record names. */
  function only(record) {
    const kind = KINDS.find((key) => idOf(record?.[key]));
    return Object.fromEntries(KINDS.map((key) => [key, key === kind ? record[key] : null]));
  }
  function load() {
    try { return only(store.read()); } catch { return only(null); }
  }
  const current = () => (cached ??= load());
  function save(next) {
    cached = next;
    const kind = KINDS.find((key) => next[key]) ?? "team";
    try { store.write({ [kind]: next[kind] }); } catch (error) { log(`home places: could not save (${error?.message ?? error})`); }
  }
  const entryOf = (key, id) => read().environments.find((entry) => entry[key]?.id === id) ?? null;
  const places = {
    /** The place shown last time, as saved: its id, and for a team or Cloud its name and address while it is still a
     * saved place. */
    remembered() {
      const saved = current(), key = KINDS.find((kind) => saved[kind]);
      if (!key) return null;
      const id = saved[key];
      if (key === "profile") return { profile: id };
      if (key === "server") return { server: id };
      const entry = entryOf(key, id);
      return entry ? { [key]: id, name: entry.name, origin: entry.origin } : { [key]: id };
    },
    /** What the window opens next time: a team (`{ team }`), another Cloud (`{ cloud }`), a workspace of this computer's
     * own (`{ profile }`), a server saved by hand (`{ server }`), or My Cloud (null). */
    remember(place) {
      const next = only(place);
      if (KINDS.some((key) => next[key] !== current()[key])) save(next);
    },
    /** The team shown is no longer this person's: said once, on the next page that asks. */
    left(name) {
      if (typeof name === "string" && name && !pending.includes(name)) pending.push(name);
    },
    /** The Admin refused the person's pairing with a team (404: they were removed) or one of their Clouds (404: it is
     * gone): it leaves the switcher now, not at the next session check, and the window falls back to My Cloud; a team
     * leaves the one line for its page. */
    drop(place) {
      const key = place?.kind === "own" ? "cloud" : "team";
      const state = read(), entry = state.environments.find((candidate) => candidate[key]?.id === place?.id) ?? null;
      if (entry) {
        const kept = state.environments.filter((candidate) => candidate !== entry);
        const activeId = state.activeId !== entry.id ? state.activeId : kept.find((candidate) => candidate.origin === homeOrigin())?.id ?? environments.LOCAL_ID;
        persist({ ...state, environments: kept, activeId });
      }
      if (key === "team") places.left(entry?.name ?? place?.name);
      if (current()[key] === place?.id) places.remember(null);
    },
    /** The MausBot Cloud sign-in changed: a connected session's teams and other Clouds are the saved places of theirs
     * (one it no longer lists is gone; a team with its name for the line), in the colours the Admin keeps for them;
     * anything else changes nothing. An Admin that lists no Clouds leaves the Cloud places as they were. */
    sync(state) {
      try { places.follow(state); } finally { synced(state); }
    },
    follow(state) {
      if (state?.status !== "connected") return;
      const teams = Array.isArray(state.teams) ? state.teams : [];
      const { state: withTeams, left } = environments.reconcileTeams(read(), teams, makeId, homeOrigin());
      const clouds = Array.isArray(state.clouds) ? ownCloudPlaces(state.clouds) : null;
      const owned = environments.reconcileOwnClouds(withTeams, clouds, makeId, homeOrigin());
      const next = clouds ? environments.withListedColors(owned, listedColors(state.clouds), homeOrigin()) : owned;
      if (next !== read()) persist(next);
      for (const name of left) places.left(name);
      if (current().team && !teams.some((team) => team?.id === current().team)) places.remember(null);
      if (current().cloud && clouds && !clouds.some((cloud) => cloud.id === current().cloud)) places.remember(null);
    },
    /** The one line for the next page, served once: a team this person is no longer in. */
    line() {
      return pending.length ? { kind: "left", name: pending.shift() } : null;
    },
  };
  return places;
}
