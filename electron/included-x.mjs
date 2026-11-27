// X research's relay access on the desktop: while this computer's
// MausBot Cloud sign-in is on an active paid plan, fetch that sign-in's
// own relay token from the Admin once and hand it to the local server over
// the private parent port (server/included-services.ts). Kept in memory only.
//
// A fetch replaces the sign-in's previous token at the Admin, so it happens
// once per sign-in, never on each 15-minute refresh: a new token mid-request
// would refuse the one a bot is using. When the Admin says no (the plan is not
// active there, or X research is off), that answer stands for the sign-in and
// its plan version, and the server is told it is not offered, so the app says
// so instead of connecting forever. A server restart gets the held token
// again; a plan that stopped, a sign-out or a sign-in to redo clears it. While
// the sign-in's answer is only unverified for a while (the Admin unreachable),
// the server holds nothing, and the same sign-in verified again gets the same
// token back without asking. An ask that fails is asked again later, longer
// each time up to 5 minutes (cloud-cadence.mjs), never on each state the
// sign-in publishes; at once when the window comes to the front (`retryNow`) or
// the sign-in is verified again after its reads failed.
import { createBackoff, TOKEN_RETRY_MS } from "./cloud-cadence.mjs";

const paidDevice = (state) =>
  state?.status === "connected" && state.entitlement?.plan === "pro" && state.entitlement.status === "active" && typeof state.deviceId === "string"
    ? state.deviceId : null;

/**
 * @param {{ fetchAccess: () => Promise<{ url: string; token: string } | null>,
 *   send: (access: { url: string; token: string } | null, note?: { offered: false }) => void,
 *   device?: (state: any) => string | null, now?: () => number, random?: () => number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void } }} options
 *   `fetchAccess` asks the Admin (null: the plan is not active there, or X research is not offered); `send` posts to the server.
 *   `device`: the sign-in that gets access, or null for none (default: one on an active paid plan). `timers`: the wait
 *   before asking again after a failure (setTimeout's by default).
 */
export function createIncludedXSync({ fetchAccess, send, device = paidDevice, now = Date.now, random = Math.random,
  timers = { set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) } }) {
  /** The sign-in and the plan's version: a changed plan asks again after a no. */
  const planKey = (state) => `${device(state)}@${state?.entitlement?.version ?? ""}`;
  /** @type {{ deviceId: string; access: { url: string; token: string } } | null} */
  let held = null;
  /** The plan key the Admin last said no to. */
  let refused = null;
  /** The newest state, so an answer that arrives after it changed is never sent. */
  let latest = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  /** The token held when the same sign-in's answer stopped being verified for a while (state "unavailable"). */
  let parked = null;
  /** Failed asks in a row for the plan key `failingKey`: none again before `failing.until()`, when `retry` asks. */
  const failing = createBackoff({ steps: TOKEN_RETRY_MS, now, random });
  let failingKey = null, retry = null, healthy = true;
  const askLater = (ms) => {
    if (retry) timers.clear(retry);
    retry = timers.set(() => { retry = null; if (latest) void onState(latest); }, Math.max(1, ms));
  };
  const unverified = (state, entry) => Boolean(entry) && state?.status === "unavailable" && state.deviceId === entry.deviceId;
  const onState = async (state) => {
    latest = state;
    // The sign-in verified again after its reads failed (the Admin is back): a failed ask goes again now.
    const verified = state?.status === "connected" && !state.checking;
    if (verified && !healthy) failing.ok();
    healthy = verified;
    const deviceId = device(state);
    if (!deviceId) {
      if (unverified(state, held)) parked = held;
      else if (!unverified(state, parked)) parked = null;
      // Clears a held token, or the server's note that the Admin said no.
      if (held || refused) { held = null; refused = null; send(null); }
      return;
    }
    if (held?.deviceId === deviceId || refused === planKey(state)) return;
    if (parked?.deviceId === deviceId) { held = parked; parked = null; send(held.access); return; }
    parked = null;
    const key = planKey(state);
    // Another sign-in or plan asks at once; the same one waits out its failures.
    if (failingKey !== key) { failing.ok(); failingKey = key; }
    if (failing.waiting()) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const access = await fetchAccess();
        failing.ok();
        // The sign-in or plan changed while asking: this answer is for a state that is gone.
        if (planKey(latest) !== key) return;
        if (access) { held = { deviceId, access }; refused = null; send(access); }
        else { held = null; refused = key; send(null, { offered: false }); }
      } catch (error) {
        // Offline or the Admin is down: asked again after a wait, longer each time. Another sign-in's token never stays with
        // the server meanwhile: the account in use just changed, and its bots would run on the one before.
        if (held && held.deviceId !== deviceId && planKey(latest) === key) { held = null; send(null); }
        if (planKey(latest) === key) askLater(failing.failed(error) - now());
      } finally {
        inflight = null;
      }
    })();
    await inflight;
    // A newer paid sign-in arrived while this one was asked about: ask for it now.
    if (device(latest) && latest !== state && planKey(latest) !== key) await onState(latest);
  };
  return {
    /** Every Cloud account state the desktop publishes. */
    onState,
    /** The window came to the front: an ask that failed goes again now, not at the end of its wait. */
    retryNow() {
      if (!failing.waiting()) return;
      failing.ok();
      if (retry) { timers.clear(retry); retry = null; }
      if (latest) void onState(latest);
    },
    /** The local server (re)started and holds nothing yet. */
    serverStarted() {
      if (held) send(held.access);
    },
  };
}

/**
 * The sync posting this sign-in's access to whichever local server is running, over the private parent port.
 * @param {{ account: () => { xResearchAccess(): Promise<{ url: string; token: string } | null> } | null,
 *   server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options
 */
export function createDesktopIncludedX({ account, server, log, ...cadence }) {
  return createIncludedXSync({
    ...cadence,
    fetchAccess: () => account()?.xResearchAccess() ?? Promise.resolve(null),
    send: (access, note) => {
      const proc = server();
      if (!proc) return;
      try { proc.postMessage({ type: "openmausbot:included-x", access, ...(note?.offered === false ? { offered: false } : {}) }); }
      catch (error) { log(`X research access sync failed: ${error?.message ?? error}`); }
    },
  });
}
