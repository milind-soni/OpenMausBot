// X research's relay access on the desktop: while this computer's
// OpenMausBot Cloud sign-in is on an active paid plan, fetch that sign-in's
// own relay token from the Admin once and hand it to the local server over
// the private parent port (server/included-services.ts). Kept in memory only.
//
// A fetch replaces the sign-in's previous token at the Admin, so it happens
// once per sign-in, never on each 15-minute refresh: a new token mid-request
// would refuse the one a bot is using. A server restart gets the held token
// again; a plan that stopped, a sign-out or a sign-in to redo clears it.

const paidDevice = (state) =>
  state?.status === "connected" && state.entitlement?.plan === "pro" && state.entitlement.status === "active" && typeof state.deviceId === "string"
    ? state.deviceId : null;

/**
 * @param {{ fetchAccess: () => Promise<{ url: string; token: string } | null>, send: (access: { url: string; token: string } | null) => void }} options
 *   `fetchAccess` asks the Admin (null: the plan is not active there, or X research is not offered); `send` posts to the server.
 */
export function createIncludedXSync({ fetchAccess, send }) {
  /** @type {{ deviceId: string; access: { url: string; token: string } } | null} */
  let held = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  return {
    /** Every Cloud account state the desktop publishes. */
    async onState(state) {
      const deviceId = paidDevice(state);
      if (!deviceId) {
        if (held) { held = null; send(null); }
        return;
      }
      if (held?.deviceId === deviceId) return;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const access = await fetchAccess();
          held = access ? { deviceId, access } : null;
          send(access);
        } catch {
          // Offline or the Admin is down: the next state change tries again.
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    /** The local server (re)started and holds nothing yet. */
    serverStarted() {
      if (held) send(held.access);
    },
  };
}
