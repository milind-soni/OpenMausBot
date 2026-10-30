// The places one window can show besides My Cloud: each team the verified session lists, and each other Cloud of the
// person's own it lists. Main keeps them as saved places (environments.cjs `team` and `cloud` entries, so the window's
// navigation rules know their addresses) and here what else the switcher needs: the place to open next time, and the one
// line waiting for the next page (a team this person is no longer in). Nothing here comes from a page: the lists are the
// Admin's session's, read by main. Who can see a team's private chats is said by the team's own page, in the chat (T2's
// TeamPrivateChatsLine), not here.
import environments from "./environments.cjs";
import { listedColors, ownCloudPlaces } from "./cloud-list.mjs";

const idOf = (value) => (typeof value === "string" && value ? value : null);

/**
 * @param {{
 *   store: { read(): unknown, write(value: unknown): void },
 *   environments(): { environments: any[], activeId: string },
 *   persist(state: unknown): void,
 *   makeId(): string,
 *   homeOrigin(): string | null,
 *   log?(line: string): void,
 * }} deps `store`: this app's home-place.json (`{ team }` or `{ cloud }`); `environments()` / `persist()`: the saved
 * places and their file; `homeOrigin()`: My Cloud's verified origin, the place the window falls back to.
 */
export function createHomePlaces({ store, environments: read, persist, makeId, homeOrigin, log = () => {} }) {
  let cached = null;
  const pending = [];
  function load() {
    try {
      const record = store.read();
      const team = idOf(record?.team);
      return { team, cloud: team ? null : idOf(record?.cloud) };
    } catch { return { team: null, cloud: null }; }
  }
  const current = () => (cached ??= load());
  function save(next) {
    cached = next;
    try { store.write(next.cloud ? { cloud: next.cloud } : { team: next.team }); } catch (error) { log(`home places: could not save (${error?.message ?? error})`); }
  }
  const entryOf = (key, id) => read().environments.find((entry) => entry[key]?.id === id) ?? null;
  const places = {
    /** The team or Cloud shown last time, as saved: its id, and its name and address while it is still a saved place. */
    remembered() {
      const { team, cloud } = current(), key = team ? "team" : cloud ? "cloud" : null;
      if (!key) return null;
      const id = team ?? cloud, entry = entryOf(key, id);
      return entry ? { [key]: id, name: entry.name, origin: entry.origin } : { [key]: id };
    },
    /** What the window opens next time: a team (`{ team }`), another Cloud (`{ cloud }`), or My Cloud (null). */
    remember(place) {
      const team = idOf(place?.team), cloud = team ? null : idOf(place?.cloud);
      if (team !== current().team || cloud !== current().cloud) save({ team, cloud });
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
