/** Keeps this computer's MausBot Relay token fresh while the relay is needed: fetched at once, again after the control
 * plane's `refreshAfter` (an hour), and sooner when the relay refuses it. A token that is still valid survives a
 * failed refresh; the relay keeps spliced sessions through an expired control socket anyway. */
const MINUTE_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 30 * MINUTE_MS;
/** After a sign-in failure the wake-ups (a new credential, pairing, resume) do the work; this bounds a 401 that came from
 * a control-plane fault, not the credential. An hour is the healthy refresh cadence, so a computer with a dead
 * credential asks no more often than a working one does. */
const SIGN_IN_FALLBACK_MS = 60 * MINUTE_MS;
const BACKOFF_MS = [MINUTE_MS, 2 * MINUTE_MS, 4 * MINUTE_MS, 8 * MINUTE_MS, 16 * MINUTE_MS, 32 * MINUTE_MS, 60 * MINUTE_MS];
const MIN_REFRESH_MS = MINUTE_MS;
const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
const HOST_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A failure as one of a few fixed words for the desktop's diagnosis: never a message, a server's text or its code. */
function failureWord(error) {
  const code = error?.code;
  if (code === "relay_unavailable") return "unavailable";
  if (code === "signed_out" || error?.status === 401) return "sign_in";
  if (code === "rate_limited" || error?.status === 429) return "busy";
  if (code === "network_unavailable" || code === "control_plane_unavailable") return "unreachable";
  return "failed";
}

const defaultSetTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

/** The control plane's 200 body, or null when any field is off. */
export function validRelayGrant(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { token, hostId, nodes, expiresAt, refreshAfter } = payload;
  if (typeof token !== "string" || token.length > 2_048 || !TOKEN.test(token)) return null;
  if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return null;
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 4 || !nodes.every((node) => typeof node === "string" && RELAY_HOST.test(node))) return null;
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(refreshAfter) || refreshAfter > expiresAt) return null;
  return { token, hostId, nodes: [...nodes], expiresAt, refreshAfter };
}

export function createRelayTokenService({
  fetchGrant,
  onGrant,
  setTimer = defaultSetTimer,
  clearTimer = clearTimeout,
  now = Date.now,
  random = Math.random,
  log = () => {},
  wakeAfterSignInFailure = false,
}) {
  let running = false;
  let grant = null;
  let timer = null;
  let failures = 0;
  let inFlight = null;
  let followUp = null;
  let lastCode = null;
  let waiting = false;

  const jitter = (milliseconds) => Math.round(milliseconds * (0.8 + 0.4 * random()));
  const schedule = (milliseconds) => {
    if (timer) clearTimer(timer);
    timer = running ? setTimer(() => void refresh(), Math.max(0, milliseconds)) : null;
  };
  const publish = (next) => {
    if (next === grant) return;
    grant = next;
    onGrant(grant);
  };

  async function attempt() {
    try {
      const next = validRelayGrant(await fetchGrant());
      if (!next) throw Object.assign(new Error("invalid relay grant"), { code: "invalid_response" });
      failures = 0;
      lastCode = null;
      waiting = false;
      if (!running) return;
      publish(next);
      schedule(Math.max(MIN_REFRESH_MS, next.refreshAfter - now()));
    } catch (error) {
      if (!running) return;
      const code = error?.code ?? "";
      lastCode = failureWord(error);
      const signIn = code === "signed_out" || error?.status === 401;
      if (code === "relay_unavailable" || signIn) {
        log(`relay token ${code || "refused"}`);
        publish(null);
        waiting = signIn && wakeAfterSignInFailure;
        return schedule(jitter(waiting ? SIGN_IN_FALLBACK_MS : UNAVAILABLE_RETRY_MS));
      }
      if (grant && grant.expiresAt <= now()) publish(null);
      const retryAfter = Number.isSafeInteger(error?.retryAfterMs) ? error.retryAfterMs : 0;
      schedule(Math.max(retryAfter, jitter(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)])));
      failures += 1;
      log(`relay token failed: ${code || "unknown"}`);
    }
  }

  function refresh() {
    inFlight ??= attempt().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    get grant() {
      return grant;
    },
    get running() {
      return running;
    },
    /** For the desktop's diagnosis: "waiting" means a sign-in failure that waits for a sign-in, a new credential or a
     * wake from sleep (`refreshNow`), or at most about an hour. `code` is one fixed word, never the token or a server's message. */
    get status() {
      const state = !running ? "off" : grant ? "ready" : waiting ? "waiting" : lastCode ? "failed" : "fetching";
      return { state, code: running ? lastCode : null };
    },
    start() {
      if (running) return;
      running = true;
      void refresh();
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
      lastCode = null;
      waiting = false;
      publish(null);
    },
    /** The relay said 4401, the computer woke up, or a sign-in or credential changed. A request already on its way may
     * carry the old credential, so a wake-up during it asks again once it settles. */
    refreshNow() {
      if (!running) return Promise.resolve();
      if (timer) clearTimer(timer);
      timer = null;
      if (!inFlight) return refresh();
      followUp ??= inFlight.then(() => {
        followUp = null;
        return running ? refresh() : undefined;
      });
      return followUp;
    },
  };
}
