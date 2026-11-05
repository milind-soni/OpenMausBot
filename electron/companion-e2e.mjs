import { companionE2EMessage, createE2EIdentity, readE2EIdentity, withE2EIdentity } from "./e2e-identity.mjs";
import { createRelayTokenService } from "./relay-token.mjs";

const RECHECK_MS = 30_000;
/** A legacy phone (paired before the encrypted connection) still needs the tunnel while it was seen this recently. */
export const LEGACY_DEVICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** What the control plane counts for its adoption gates: no identifiers. */
export function deviceCounts(state) {
  const devices = Array.isArray(state?.devices) ? state.devices : [];
  const e2e = devices.filter((device) => Number.isSafeInteger(device?.e2eAt)).length;
  return { e2e: Math.min(e2e, 100), legacy: Math.min(devices.length - e2e, 100) };
}

/** The relay is needed while the companion runs and a phone could use it: one not restricted to Wi-Fi and Tailscale,
 * or a pairing window. Null when that can't be told. */
export function relayNeed(state) {
  if (!state || typeof state !== "object") return null;
  if (state.enabled !== true) return false;
  if (state.error) return null;
  if (state.devicesUnreadable === true || !Array.isArray(state.devices)) return null;
  return Boolean(state.pairing) || state.devices.some((device) => device?.routes !== "local");
}

/** The end-to-end connection for the desktop app: the transport key, the relay token, and what the sidecar is told.
 * The key is made the first time the control plane admits this computer to the relay, and from then on the encrypted
 * connection stays on, signed in or not, so phones that pinned it never lose Wi-Fi and Tailscale. */
export function createCompanionE2E({
  readCredentials,
  updateCredentials,
  fetchGrant,
  companionState,
  post,
  setTimer = setInterval,
  clearTimer = clearInterval,
  log = () => {},
}) {
  let identity = readE2EIdentity(readCredentials());
  let lastState = null;
  let interval = null;

  const sync = () => {
    if (!identity && !tokens.grant) return;
    post(companionE2EMessage(identity, tokens.grant));
  };

  async function ensureIdentity() {
    if (identity) return identity;
    const existing = readE2EIdentity(readCredentials());
    if (existing) return (identity = existing);
    const created = createE2EIdentity();
    await updateCredentials((credentials) => withE2EIdentity(credentials, created));
    identity = created;
    log("e2e: connection key created");
    return identity;
  }

  const tokens = createRelayTokenService({
    fetchGrant: () => fetchGrant(deviceCounts(lastState)),
    onGrant: (grant) => {
      if (!grant) return sync();
      void ensureIdentity().then(sync, (error) => log(`e2e: connection key unavailable: ${error?.message ?? error}`));
    },
    log,
  });

  async function reconcile() {
    lastState = await companionState().catch(() => null);
    const need = relayNeed(lastState);
    if (need === true) tokens.start();
    else if (need === false) tokens.stop();
  }

  return {
    get enabled() {
      return identity !== null;
    },
    get publicKey() {
      return identity?.publicKey ?? null;
    },
    /** For a new sidecar: null while the encrypted connection is off. */
    message: () => (identity ? companionE2EMessage(identity, tokens.grant) : null),
    start() {
      interval ??= setTimer(() => void reconcile(), RECHECK_MS);
      interval.unref?.();
      return reconcile();
    },
    stop() {
      if (interval) clearTimer(interval);
      interval = null;
      tokens.stop();
    },
    /** A pairing window opened or a device changed: the relay may be needed now. */
    reconcile,
    /** A fresh sidecar knows nothing yet. */
    spawned: sync,
    /** The sidecar's relay refused the token (4401). */
    tokenRejected: () => void tokens.refreshNow(),
    /** The computer woke: the sidecar redials now, and the token may have lapsed while asleep. */
    resumed() {
      post({ type: "openmausbot:companion-e2e-redial" });
      void tokens.refreshNow();
    },
  };
}
