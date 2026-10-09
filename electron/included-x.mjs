// X research's relay access on the desktop: while this computer's
// OpenMausBot Cloud sign-in is on an active paid plan, fetch that sign-in's
// own relay token from the Admin once and hand it to the local server over
// the private parent port (server/included-services.ts). Kept in memory only.
//
// A fetch replaces the sign-in's previous token at the Admin, so it happens
// once per sign-in, never on each 15-minute refresh: a new token mid-request
// would refuse the one a bot is using. When the Admin says no (the plan is not
// active there, or X research is off), that answer stands for the sign-in and
// its plan version, and the server is told it is not offered, so the app says
// so instead of connecting forever. A server restart gets the held token
// again; a plan that stopped, a sign-out or a sign-in to redo clears it.

const paidDevice = (state) =>
  state?.status === "connected" && state.entitlement?.plan === "pro" && state.entitlement.status === "active" && typeof state.deviceId === "string"
    ? state.deviceId : null;
/** The sign-in and the plan's version: a changed plan asks again after a no. */
const planKey = (state) => `${paidDevice(state)}@${state?.entitlement?.version ?? ""}`;

/**
 * @param {{ fetchAccess: () => Promise<{ url: string; token: string } | null>,
 *   send: (access: { url: string; token: string } | null, note?: { offered: false }) => void }} options
 *   `fetchAccess` asks the Admin (null: the plan is not active there, or X research is not offered); `send` posts to the server.
 */
export function createIncludedXSync({ fetchAccess, send }) {
  /** @type {{ deviceId: string; access: { url: string; token: string } } | null} */
  let held = null;
  /** The plan key the Admin last said no to. */
  let refused = null;
  /** The newest state, so an answer that arrives after it changed is never sent. */
  let latest = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  const onState = async (state) => {
    latest = state;
    const deviceId = paidDevice(state);
    if (!deviceId) {
      // Clears a held token, or the server's note that the Admin said no.
      if (held || refused) { held = null; refused = null; send(null); }
      return;
    }
    if (held?.deviceId === deviceId || refused === planKey(state)) return;
    if (inflight) return inflight;
    const key = planKey(state);
    inflight = (async () => {
      try {
        const access = await fetchAccess();
        // The sign-in or plan changed while asking: this answer is for a state that is gone.
        if (planKey(latest) !== key) return;
        if (access) { held = { deviceId, access }; refused = null; send(access); }
        else { held = null; refused = key; send(null, { offered: false }); }
      } catch {
        // Offline or the Admin is down: the next state change tries again.
      } finally {
        inflight = null;
      }
    })();
    await inflight;
    // A newer paid sign-in arrived while this one was asked about: ask for it now.
    if (paidDevice(latest) && latest !== state && planKey(latest) !== key) await onState(latest);
  };
  return {
    /** Every Cloud account state the desktop publishes. */
    onState,
    /** The local server (re)started and holds nothing yet. */
    serverStarted() {
      if (held) send(held.access);
    },
  };
}
