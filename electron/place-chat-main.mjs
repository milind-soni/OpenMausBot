// Main's side of a My Cloud bot opened in place on this computer's page (src/lib/place-chat.ts): the one owner session at
// My Cloud that this computer's server forwards that bot's conversation with (server/places/place-proxy.ts).
//
// The session is opened on the person's first click on a My Cloud row, never at start, and kept for the app's run: the
// Admin's one-time code for the person's own My Cloud, redeemed there alone, as every send to My Cloud is
// (cloud-send-main.mjs). Its token goes to this computer's server over the server's private port and is kept in memory
// only, here and there: never on disk, never to a page. It is signed out at My Cloud when the joined list goes off, the
// account or My Cloud changes, and the app quits.
//
// A sleeping My Cloud is woken through the Admin first, as opening its page does; the row shows "waking" meanwhile.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

/** How a session this opens is named in My Cloud's list of signed-in devices. */
export const PLACE_CHAT_LABEL = "This computer's window";
/** A click waits this long for My Cloud to wake and sign this in, and no longer: then it opens My Cloud's page instead. */
export const OPEN_WAIT_MS = 60_000;
const PAIR_MS = 30_000;
const SESSION_TOKEN = /^omb_sess_[\w-]{8,256}$/;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {{
 *   cloud(): { origin: string | null, account: string | null, asleep: boolean },
 *   grant(): Promise<{ origin: string, code: string }>,
 *   wake(): Promise<unknown>,
 *   server(): { postMessage(message: unknown): void } | null | undefined,
 *   fetch: typeof fetch,
 *   log?(line: string): void,
 *   now?(): number,
 *   delay?(ms: number): Promise<void>,
 * }} deps `grant()`: the Admin's one-time code for the person's My Cloud (`pairHome`). `wake()`: starts a sleeping My Cloud
 * through the Admin (`wakeHome`). `server()`: this computer's server process, null while it is not running.
 */
export function createPlaceChatMain({ cloud, grant, wake, server, fetch: fetchImpl, log = () => {}, now = Date.now, delay = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  /** The open session: the Cloud and account it belongs to, and its token. */
  let session = null;
  let opening = null;
  let epoch = 0;

  const scope = () => { const { origin, account } = cloud(); return origin ? `${origin}\n${account ?? ""}` : null; };
  const tell = (value) => {
    try { server()?.postMessage({ type: "openmausbot:place-session", place: "cloud", ...value }); } catch (error) { log(`place chat: server not told (${error?.message ?? error})`); }
  };

  async function pair(origin) {
    const given = await grant();
    if (!record(given) || given.origin !== origin || typeof given.code !== "string") throw new Error("no grant for this Cloud");
    const response = await fetchImpl(`${origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(PAIR_MS),
      headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ code: given.code, label: PLACE_CHAT_LABEL }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.token !== "string" || !SESSION_TOKEN.test(body.token)) throw Object.assign(new Error(`pair refused (${response.status})`), { status: response.status });
    return body.token;
  }

  async function open(mine) {
    const { origin, asleep } = cloud();
    const key = scope();
    if (!origin || !key) return { ok: false };
    if (asleep) await Promise.resolve().then(wake).catch(() => null);
    const deadline = now() + OPEN_WAIT_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const token = await pair(origin);
        if (mine !== epoch || scope() !== key) { void signOut({ origin, token }); return { ok: false }; }
        session = { key, origin, token };
        tell({ origin, token });
        return { ok: true };
      } catch (error) {
        // A Cloud that is starting answers nothing for a while; one that refuses the code says so at once.
        const refused = typeof error?.status === "number" && error.status >= 400 && error.status < 500;
        if (refused || now() >= deadline || mine !== epoch) { log(`place chat: no session (${error?.message ?? error})`); return { ok: false }; }
        await delay(Math.min(2_000 * (attempt + 1), 5_000));
      }
    }
  }

  async function signOut(old) {
    try {
      const response = await fetchImpl(`${old.origin}/api/auth/logout`, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${old.token}`, ...BACKGROUND_HEADERS }, body: "{}" });
      await response.body?.cancel?.();
    } catch {}
  }

  return {
    /** Gets the session ready for a click on a My Cloud row: the one already open (told to the server again, which may
     * have restarted since), or a new one. `{ ok: false }` when there is no My Cloud or it can't sign this in. */
    ensure({ fresh = false } = {}) {
      const key = scope();
      // `fresh`: My Cloud refused the one held (it was signed out there): a new one replaces it.
      if (session && (session.key !== key || fresh)) this.close();
      if (session) { tell({ origin: session.origin, token: session.token }); return Promise.resolve({ ok: true }); }
      if (!opening) {
        const mine = epoch;
        opening = open(mine).finally(() => { if (epoch === mine) opening = null; });
      }
      return opening;
    },
    /** The session is let go: at My Cloud, and in this computer's server. */
    close() {
      epoch += 1;
      opening = null;
      const old = session;
      session = null;
      if (!old) return Promise.resolve();
      tell({ token: null });
      return signOut(old);
    },
    /** Whether a session is open now (tests and the log). */
    open: () => session !== null,
  };
}
