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

/** The relay is needed while the companion runs, the person has Anywhere, through MausBot on, and a phone could use it:
 * one not restricted to Wi-Fi and Tailscale, or a pairing window. Null when that can't be told. */
export function relayNeed(state) {
  if (!state || typeof state !== "object") return null;
  if (state.enabled !== true || state.routes?.relay?.on !== true) return false;
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
  onState = () => {},
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
    wakeAfterSignInFailure: true,
  });

  async function reconcile() {
    lastState = await companionState().catch(() => null);
    onState(lastState);
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
    /** The relay token's state and last failure code, for the renderer's diagnosis: never the token. */
    get relayToken() {
      return tokens.status;
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
    /** A person is about to pair, or this computer just got a new installation credential: with Anywhere on, ask for
     * the relay token now instead of once a code is open, so the encrypted connection (and its key, the first time)
     * is on before the code shows. The 30 s recheck stops the token again while nothing needs the relay. */
    async prime() {
      lastState = await companionState().catch(() => null);
      onState(lastState);
      if (lastState?.enabled !== true || lastState.error || lastState.routes?.relay?.on !== true) return;
      if (tokens.running) return tokens.refreshNow();
      tokens.start();
    },
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
