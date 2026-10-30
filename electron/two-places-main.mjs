// Main's side of the two-places suggestion (two-places.mjs): the person's own places besides this computer, each read and
// told over this window's own sign-in there, and the one tap that starts the move to one. My Cloud is a place while it is
// awake (one this computer's bots can go to while the person keeps them here: its one tap lets them move, as anyone's first
// move); a server is one while it says it is theirs alone (and one to go to while nothing moves yet). Never a team's
// Cloud, nor a server others sign in to.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";
import { awayIn, parseJournal } from "./one-home.mjs";
import { handSaved, serverRequests } from "./own-home-main.mjs";
import { createTwoPlaces, installTwoPlaces } from "./two-places.mjs";

/** How often main looks whether the places changed (a server said it is the person's own, My Cloud became ready). */
const WATCH_MS = 60_000;
const ROUTE = "/api/places/elsewhere";

async function json(response) {
  if (!response.ok) { await response.body?.cancel(); return null; }
  try { return await response.json(); } catch { return null; }
}
async function sent(response, what) {
  await response.body?.cancel();
  if (!response.ok) throw Object.assign(new Error(`${what} answered ${response.status}`), { status: response.status });
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   guard(channel: string, handler: (...args: any[]) => unknown): (...args: any[]) => unknown,
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   fetch: typeof fetch,
 *   environments(): any[],
 *   cloud(): { origin: string | null, asleep: boolean },
 *   oneHome: { journal(): unknown, keep: { state(): { shown: boolean, on: boolean, moved: boolean }, set(on: boolean): Promise<unknown> } },
 *   ownHome: { owns(place: any): boolean, offers(place: any): boolean, start(id: string): Promise<unknown>, active(): boolean, away(): boolean, refresh(): void },
 *   dismissed: { read(): unknown, write(value: unknown): void },
 *   tell(): void,
 *   log?(line: string): void,
 * }} deps `guard`: this computer's own page only. `cloud()`: My Cloud's address while it is ready, and whether it sleeps
 * now (a sleeping Cloud is never asked). `tell()`: the suggestion changed, so this computer's page asks again.
 */
export function installTwoPlacesMain({ ipcMain, guard, localRequest, fetch: fetchImpl, environments, cloud, oneHome, ownHome, dismissed, tell, log = () => {} }) {
  const put = (payload) => ({ method: "PUT", body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  const places = () => {
    const out = [];
    const mine = cloud(), keep = oneHome.keep.state();
    if (mine.origin && !mine.asleep) {
      const request = (route, init = {}) => fetchImpl(`${mine.origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000), ...init,
        headers: { accept: "application/json", origin: mine.origin, ...BACKGROUND_HEADERS, ...init.headers } });
      out.push({ key: `cloud:${mine.origin}`, name: "My Cloud", kind: "cloud",
        read: async () => (cloud().asleep ? null : json(await request("/api/cloud-send?move=1"))),
        tell: async (payload) => sent(await request(ROUTE, { ...put(payload), headers: { "content-type": "application/json" } }), "My Cloud"),
        ...(keep.on && !keep.moved ? { bring: () => oneHome.keep.set(false) } : {}) });
    }
    for (const place of environments().filter((entry) => handSaved(entry) && ownHome.owns(entry))) {
      const server = serverRequests(place, fetchImpl);
      out.push({ key: `server:${place.origin}`, name: place.name, kind: "server",
        read: async () => json(await server.request("GET", "/api/cloud-send?move=1", { signal: AbortSignal.timeout(10_000) })),
        tell: async (payload) => sent(await server.request("PUT", ROUTE, { ...put(payload), headers: { "content-type": "application/json" } }), place.name),
        ...(ownHome.offers(place) ? { bring: () => ownHome.start(place.id) } : {}) });
    }
    return out;
  };
  const journal = () => parseJournal(oneHome.journal());
  /** This computer's bots moved: to My Cloud, or to a server of the person's own. */
  const moved = () => awayIn(journal()) || ownHome.away();
  const settled = () => !ownHome.active() && (!journal() || journal().phase === "back");
  let label = null;
  const twoPlaces = createTwoPlaces({
    local: async () => (moved() ? null : json(await localRequest("/api/cloud-send?move=1", { signal: AbortSignal.timeout(10_000) }))),
    here: {
      name: async () => (label ??= (await json(await localRequest("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(10_000) })))?.label ?? null),
      tell: async (payload) => sent(await localRequest(ROUTE, { ...put(payload), headers: { "content-type": "application/json" } }), "This computer"),
    },
    places, settled, quiet: () => !settled() && !moved(), dismissed, onChange: tell, log });
  installTwoPlaces({ ipcMain, guard, twoPlaces });
  let watched = "";
  const watch = setInterval(() => {
    ownHome.refresh();
    const now = JSON.stringify([settled(), moved(), places().map((place) => [place.key, Boolean(place.bring)])]);
    if (now !== watched) { watched = now; void twoPlaces.refresh({ force: true }); } else void twoPlaces.refresh();
  }, WATCH_MS);
  watch.unref?.();
  return { ...twoPlaces, close: () => clearInterval(watch) };
}
