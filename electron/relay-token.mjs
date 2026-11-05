/** Keeps this computer's MausBot Relay token fresh while the relay is needed: fetched at once, again after the control
 * plane's `refreshAfter` (an hour), and sooner when the relay refuses it. A token that is still valid survives a
 * failed refresh; the relay keeps spliced sessions through an expired control socket anyway. */
const MINUTE_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 30 * MINUTE_MS;
const BACKOFF_MS = [MINUTE_MS, 2 * MINUTE_MS, 4 * MINUTE_MS, 8 * MINUTE_MS, 16 * MINUTE_MS, 32 * MINUTE_MS, 60 * MINUTE_MS];
const MIN_REFRESH_MS = MINUTE_MS;
const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
const HOST_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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
}) {
  let running = false;
  let grant = null;
  let timer = null;
  let failures = 0;
  let inFlight = null;

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
      if (!running) return;
      publish(next);
      schedule(Math.max(MIN_REFRESH_MS, next.refreshAfter - now()));
    } catch (error) {
      if (!running) return;
      const code = error?.code ?? "";
      if (code === "relay_unavailable" || code === "signed_out" || error?.status === 401) {
        log(`relay token ${code || "refused"}`);
        publish(null);
        return schedule(jitter(UNAVAILABLE_RETRY_MS));
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
    start() {
      if (running) return;
      running = true;
      void refresh();
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
      publish(null);
    },
    /** The relay said 4401, or the computer woke up. */
    refreshNow() {
      if (!running) return Promise.resolve();
      if (timer) clearTimer(timer);
      timer = null;
      return refresh();
    },
  };
}
