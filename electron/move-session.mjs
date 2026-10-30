// The one-time move's owner session at My Cloud (one-home.mjs, cloud-send.mjs): one for every pass, check and switch of
// the move while this app runs, signed out once the move no longer needs it. Each new session costs one of the Admin's
// one-time codes, which it gives 10 an account in 10 minutes, so a session for each pass ran out when a move was
// interrupted or two computers moved together.

/**
 * @typedef {{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>,
 *   upload(route: string, bytes: Uint8Array, type: string): Promise<{ ok: boolean, status: number, body: any }>,
 *   fetch(route: string, init?: RequestInit): Promise<Response>, close(): Promise<void> }} OwnerSession
 * @typedef {{ origin: string }} Target
 */

/**
 * @param {{ open(target: Target): Promise<OwnerSession> }} deps `open`: a new owner session at `target.origin`.
 */
export function createMoveSession({ open }) {
  /** @type {null | { origin: string, session: Promise<OwnerSession>, renewed: boolean }} */
  let held = null;

  function current(target, renewed = false) {
    if (held && held.origin !== target.origin) void end();
    if (!held) {
      const entry = { origin: target.origin, renewed, session: open(target) };
      entry.session.catch(() => { if (held === entry) held = null; });
      held = entry;
    }
    return held;
  }

  /** A request over the held session. A 401 means My Cloud no longer knows it (expired, revoked, or set up again): one new
   * session, and the request again; a replacement refused too is not replaced again, so a route that always refuses costs
   * one code at most. */
  async function using(target, request) {
    const entry = current(target);
    const answer = await request(await entry.session);
    if (answer?.status !== 401) return answer;
    if (held === entry) {
      if (entry.renewed) return answer;
      held = null;
      current(target, true);
    }
    return request(await current(target).session);
  }

  async function end() {
    const entry = held;
    held = null;
    if (!entry) return;
    try { await (await entry.session).close(); } catch {}
  }

  return {
    /** The move's session at `target`, opened now if none is held: its `close()` keeps it for the next pass. */
    async open(target) {
      await current(target).session;
      return {
        call: (method, route, body) => using(target, (session) => session.call(method, route, body)),
        upload: (route, bytes, type) => using(target, (session) => session.upload(route, bytes, type)),
        fetch: (route, init) => using(target, async (session) => {
          const response = await session.fetch(route, init);
          if (response.status === 401) await response.body?.cancel();
          return response;
        }),
        close: async () => {},
      };
    },
    /** Signs the held session out: the move is done, paused or over. */
    end,
    held: () => held !== null,
  };
}
