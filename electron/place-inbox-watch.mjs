// How many inbox lines wait in each place the window isn't showing, for the rail's "{name}: needs you". Each place keeps its
// own inbox and nothing syncs: main only asks each place for its count, as the signed-in person, and keeps the number.
// A Cloud the Admin says is asleep is never asked, since any request would wake it; it keeps the last number it gave.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

export const INBOX_WATCH_MS = 120_000;
const TIMEOUT_MS = 10_000;

/**
 * @param {{
 *   places(): Array<{ id: string, origin?: string | null, local?: boolean }>,
 *   activeId(): string,
 *   local(route: string, init?: RequestInit): Promise<Response>,
 *   cloudFetch(url: string, init?: RequestInit): Promise<Response>,
 *   asleep(origin: string): boolean,
 *   shown(): boolean,
 *   changed(): void,
 *   setTimer?: typeof setInterval,
 * }} deps `places`: every saved place with its address, this computer `local`; `shown`: the window can be seen, so a rail is.
 */
export function createPlaceInboxWatch({ places, activeId, local, cloudFetch, asleep, shown, changed, setTimer = setInterval }) {
  const counts = new Map();
  let started = false, reading = null;

  async function countOf(place) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await (place.local
      ? local("/api/inbox/count", { signal })
      : cloudFetch(`${place.origin}/api/inbox/count`, { headers: BACKGROUND_HEADERS, credentials: "include", cache: "no-store", redirect: "error", signal }));
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    return Number.isSafeInteger(body?.count) && body.count >= 0 ? body.count : null;
  }

  async function read() {
    const listed = places().filter((place) => place.local || (place.origin && !asleep(place.origin)));
    const before = JSON.stringify([...counts]);
    await Promise.all(listed.map(async (place) => {
      const count = await countOf(place).catch(() => undefined);
      // A place that can't say keeps its last number; one that says it has no inbox has none.
      if (count === null) counts.delete(place.id);
      else if (count !== undefined) counts.set(place.id, count);
    }));
    if (JSON.stringify([...counts]) !== before) changed();
  }

  function look() {
    if (reading || !shown()) return reading ?? Promise.resolve();
    reading = read().finally(() => { reading = null; });
    return reading;
  }

  function start() {
    if (started) return;
    started = true;
    setTimer(() => void look(), INBOX_WATCH_MS)?.unref?.();
    void look();
  }

  return {
    look,
    /** Something waits in this place, and the window is showing another one. */
    waiting(id) {
      start();
      return id !== activeId() && (counts.get(id) ?? 0) > 0;
    },
  };
}
