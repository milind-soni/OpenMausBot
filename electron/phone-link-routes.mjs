import { checkTailscale } from "./tailscale-check.mjs";
import { phoneLinkShouldSleep, ROUTES } from "./companion-settings.mjs";

/** A sidecar started for a pairing code gets this long before an empty one goes back to sleep. */
export const PHONE_LINK_SLEEP_GRACE_MS = 3 * 60_000;
const SLEEP_CHECK_MS = 60_000;

/**
 * The phone link's ways in, as the person turns them on and off: each switch is its own choice, Tailscale runs only on
 * Turn on or Check again, and a sidecar with nothing paired and no code open goes back to sleep.
 *
 * `wake()` starts the sidecar when the launch rule now holds (a way in is on and something is paired).
 */
export function createPhoneLinkRoutes({ rememberRoute, routeOn, tailscaleRoute = () => null, dismissNotice, state, running, wake, sleep, changed = () => {}, check = checkTailscale, shareChanged = async () => {}, now = Date.now, setTimer = setInterval, log = () => {} }) {
  let activeSince = 0;
  let timer = null;

  async function setTailscale(on) {
    if (!on) {
      await rememberRoute("tailscale", false);
      await shareChanged();
      return state();
    }
    const result = await check();
    if (result.state !== "ready") return { ...(await state()), tailscaleProblem: result.state };
    await rememberRoute("tailscale", true, { name: result.name, forShare: false });
    await shareChanged();
    await wake();
    return state();
  }

  /**
   * Whether the person's other computers may open this one over Tailscale. The share needs the Tailscale route: turning
   * the share on turns an off route on, marked as the share's, and turning the share off turns a route so marked off
   * again unless a device is paired, which may be using it. A route the person turned on themselves is never turned off here.
   */
  async function setTailscaleComputers(on) {
    if (on && !routeOn("tailscale")) {
      const result = await check();
      if (result.state !== "ready") return { ...(await state()), tailscaleProblem: result.state };
      await rememberRoute("tailscale", true, { name: result.name, computers: true, forShare: true });
    } else if (on) {
      await rememberRoute("tailscale", true, { computers: true });
    } else if (!routeOn("tailscale")) {
      return state();
    } else if (tailscaleRoute()?.forShare === true && !((await state().catch(() => null))?.devices?.length > 0)) {
      await rememberRoute("tailscale", false);
    } else {
      await rememberRoute("tailscale", true, { computers: false });
    }
    await shareChanged();
    return state();
  }

  const api = {
    setTailscale,
    setTailscaleComputers,
    /** Check again: asks Tailscale for the name only while the route is on, and starts nothing. */
    async checkTailscale() {
      if (!routeOn("tailscale")) return state();
      const result = await check();
      if (result.state !== "ready") return { ...(await state()), tailscaleProblem: result.state };
      await rememberRoute("tailscale", true, { name: result.name });
      await shareChanged();
      return state();
    },
    async setRoute(route, on) {
      if (!ROUTES.includes(route)) return state();
      if (route === "tailscale") return setTailscale(on === true);
      await rememberRoute(route, on === true);
      await changed(route, on === true);
      if (on === true) await wake();
      return state();
    },
    async dismissNotice(route) {
      dismissNotice(route);
      return state();
    },
    /** A code opened or the sidecar started for one: an empty sidecar is kept a while for the device to arrive. */
    touched() {
      activeSince = now();
    },
    async sleepIfIdle() {
      if (!running() || now() - activeSince < PHONE_LINK_SLEEP_GRACE_MS) return false;
      if (!phoneLinkShouldSleep(await state().catch(() => null))) return false;
      log("phone link: nothing paired and no code open; sleeping");
      await sleep();
      return true;
    },
    /** Every channel is the desktop window's own (`localOnly`). */
    install(ipcMain, localOnly) {
      const handle = (channel, run) => ipcMain.handle(channel, localOnly(channel, run));
      handle("companion:refresh-tailscale", () => api.checkTailscale());
      handle("companion:tailscale", (_event, on) => api.setTailscale(on === true));
      handle("companion:tailscale-computers", (_event, on) => api.setTailscaleComputers(on === true));
      handle("companion:route", (_event, route, on) => api.setRoute(String(route), on === true));
      handle("companion:notice-dismiss", (_event, route) => api.dismissNotice(String(route)));
    },
    start() {
      timer ??= setTimer(() => void api.sleepIfIdle(), SLEEP_CHECK_MS);
      timer.unref?.();
    },
  };
  return api;
}
