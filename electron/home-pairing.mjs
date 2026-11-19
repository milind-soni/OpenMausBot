// When the desktop window asks the Admin for the next sign-in code for My Cloud (home-window.mjs), and when its screen names the
// address this computer couldn't connect to.
//
// Every look once asked for a code at once (the screen mounting, the window coming to the front, each session read), so a page
// that didn't load from here, or an Admin refusing, ran hundreds of requests. A short first wait already stops that loop, so
// one passing failure costs a few seconds, and the waits grow from there.

/** The waits before the next code, after a code whose page didn't load or one the Admin refused. */
export const PAIR_RETRY_MS = Object.freeze([3_000, 10_000, 30_000, 60_000, 120_000, 300_000]);
/** The most an Admin's 429 holds the next code, whatever its Retry-After says. */
export const PAIR_LIMIT_MS = 5 * 60_000;
/** How long My Cloud's page must have failed to connect from here before the screen names its address. */
export const NETWORK_HINT_MS = 60_000;

/** Chromium's net errors for a name it could not find (net/base/net_error_list.h): NAME_NOT_RESOLVED,
 * NAME_RESOLUTION_FAILED and the DNS range. */
export const nameNotFound = (code) => code === -105 || code === -137 || (code <= -800 && code > -900);
/** TIMED_OUT, CONNECTION_CLOSED, _RESET, _REFUSED, _FAILED, SSL_PROTOCOL_ERROR, ADDRESS_UNREACHABLE,
 * SSL_VERSION_OR_CIPHER_MISMATCH, CONNECTION_TIMED_OUT, PROXY_CONNECTION_FAILED, NETWORK_ACCESS_DENIED. */
const CONNECT_FAILED = new Set([-7, -100, -101, -102, -104, -107, -109, -113, -118, -130, -138]);
/** A page load this computer couldn't connect for (a name, a refused or timed-out connection, TLS or a certificate): what a
 * VPN, firewall or DNS filter does. Not INTERNET_DISCONNECTED or NETWORK_CHANGED: no network here at all is something else. */
export const connectionError = (code) => nameNotFound(code) || CONNECT_FAILED.has(code) || (code <= -200 && code > -300);

const hostOf = (origin) => { try { return new URL(origin).host || null; } catch { return null; } };

/**
 * The window's waits for one Cloud at a time. `hold`: the next code for `origin` waits until `until` (`page`: its page didn't
 * load; `limited`: the Admin answered 429; `down`: a look found it not answering since). `unreached`: since when its page has
 * failed to connect from here, until it answers again.
 */
export function createPairWait({ now = Date.now } = {}) {
  let hold = null, unreached = null;
  const held = (origin) => hold?.origin === origin && now() < hold.until;
  return {
    held,
    /** When the code for `origin` may be asked for again, while it waits. */
    until: (origin) => (held(origin) ? hold.until : null),
    /** The Admin's own 429 holds `origin`: the screen says when the app tries again. */
    limited: (origin) => held(origin) && hold.limited,
    /** A code for `origin` whose page didn't load (`page`), or one the Admin refused (`error`). */
    hold(origin, { error = null, page = false } = {}) {
      const tries = hold?.origin === origin ? hold.tries + 1 : 1;
      const limited = error?.status === 429;
      const asked = limited && Number.isFinite(error.retryAfter) ? Math.min(Math.max(error.retryAfter, 0) * 1000, PAIR_LIMIT_MS) : 0;
      hold = { origin, tries, page, limited, down: false, until: now() + Math.max(PAIR_RETRY_MS[Math.min(tries, PAIR_RETRY_MS.length) - 1], asked) };
    },
    /** What the window's look at `origin` answered: "yes", "asleep", "failing" (an error, so it connected) or "no" (nothing in
     * time). Any answer means this computer reaches it. A page's wait ends once it answers after not answering: it came back. */
    looked(origin, answer) {
      if (answer !== "no" && unreached?.origin === origin) unreached = null;
      if (hold?.origin !== origin || !hold.page || hold.limited) return;
      if (answer !== "yes") hold.down = true;
      else if (hold.down) hold.until = 0;
    },
    /** The person pressed Try again: no wait holds them, except the Admin's own 429. */
    pressed() { if (hold && !hold.limited) hold.until = 0; },
    /** A page of `origin` loaded: the waits start again. */
    loaded(origin) {
      if (hold?.origin === origin) hold = null;
      if (unreached?.origin === origin) unreached = null;
    },
    /** `origin`'s page failed to load with Chromium's net error `code`. */
    failedLoad(origin, code) {
      if (connectionError(code)) { if (unreached?.origin !== origin) unreached = { origin, since: now() }; }
    },
    /** `origin`'s host once its page has failed to connect from here for NETWORK_HINT_MS, else null. */
    unreachedHost: (origin) => (unreached?.origin === origin && now() - unreached.since >= NETWORK_HINT_MS ? hostOf(origin) : null),
    /** How long until `origin`'s host would be named, while it fails to connect and isn't yet. */
    hintIn: (origin) => (unreached?.origin === origin && now() - unreached.since < NETWORK_HINT_MS ? unreached.since + NETWORK_HINT_MS - now() : null),
    clear() { hold = null; unreached = null; },
  };
}
