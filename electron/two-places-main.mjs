// Main's side of the two-places suggestion (two-places.mjs): which places this computer's bots could go to now, each read
// over this window's own sign-in there, and the one tap that starts the move to it. My Cloud is a place only while the
// person keeps this computer's bots here (its one tap lets them move, as anyone's first move); a server is one when it
// says it is theirs alone and nothing moves yet (own-home-main.mjs `offers`). Never a team's Cloud, nor a server others
// sign in to.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";
import { parseJournal } from "./one-home.mjs";
import { handSaved, serverRequests } from "./own-home-main.mjs";
import { createTwoPlaces, installTwoPlaces } from "./two-places.mjs";

/** How often main looks whether the places changed (a server said it is the person's own, My Cloud became ready). */
const WATCH_MS = 60_000;

async function json(response) {
  if (!response.ok) { await response.body?.cancel(); return null; }
  try { return await response.json(); } catch { return null; }
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
 *   ownHome: { offers(place: any): boolean, start(id: string): Promise<unknown>, active(): boolean },
 *   dismissed: { read(): unknown, write(value: unknown): void },
 *   tell(): void,
 *   log?(line: string): void,
 * }} deps `guard`: this computer's own page only. `cloud()`: My Cloud's address while it is ready, and whether it sleeps
 * now (a sleeping Cloud is never asked). `tell()`: the suggestion changed, so this computer's page asks again.
 */
export function installTwoPlacesMain({ ipcMain, guard, localRequest, fetch: fetchImpl, environments, cloud, oneHome, ownHome, dismissed, tell, log = () => {} }) {
  const places = () => {
    const out = [];
    const mine = cloud(), keep = oneHome.keep.state();
    if (mine.origin && keep.on && !keep.moved) {
      out.push({ key: `cloud:${mine.origin}`, name: "My Cloud", kind: "cloud",
        read: async () => (cloud().asleep ? null : json(await fetchImpl(`${mine.origin}/api/cloud-send?move=1`, { credentials: "include", cache: "no-store", redirect: "error",
          signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", origin: mine.origin, ...BACKGROUND_HEADERS } }))),
        bring: () => oneHome.keep.set(false) });
    }
    for (const place of environments().filter((entry) => handSaved(entry) && ownHome.offers(entry))) {
      out.push({ key: `server:${place.origin}`, name: place.name, kind: "server",
        read: async () => json(await serverRequests(place, fetchImpl).request("GET", "/api/cloud-send?move=1", { signal: AbortSignal.timeout(10_000) })),
        bring: () => ownHome.start(place.id) });
    }
    return out;
  };
  const settled = () => {
    const journal = parseJournal(oneHome.journal());
    return !ownHome.active() && (!journal || journal.phase === "back");
  };
  const twoPlaces = createTwoPlaces({ local: async () => json(await localRequest("/api/cloud-send?move=1", { signal: AbortSignal.timeout(10_000) })), places, settled, dismissed,
    onChange: tell, log });
  installTwoPlaces({ ipcMain, guard, twoPlaces });
  let watched = "";
  const watch = setInterval(() => {
    const now = JSON.stringify([settled(), places().map((place) => place.key)]);
    if (now !== watched) { watched = now; void twoPlaces.refresh({ force: true }); }
  }, WATCH_MS);
  watch.unref?.();
  return { ...twoPlaces, close: () => clearInterval(watch) };
}
