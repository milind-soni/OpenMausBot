import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `companion-settings.json` in the app's user data: each way into this computer and whether the person turned it on.
 * `wifi` is Same Wi-Fi (the device port on the LAN, and Bonjour), `relay` is Anywhere, through MausBot, `tailscale`
 * the tailnet address (with `computers` when the person's other computers may open this one's server over it), `https`
 * the HTTPS address (the managed tunnel). `notices` lists routes kept on by the update that the person has not seen yet. */
export const COMPANION_SETTINGS_VERSION = 2;
export const ROUTES = Object.freeze(["wifi", "relay", "tailscale", "https"]);
/** A device seen this recently counts as using its routes. */
export const RECENT_DEVICE_MS = 30 * 24 * 60 * 60 * 1_000;

const off = () => ({ on: false, since: null });

export function defaultCompanionSettings() {
  return { version: COMPANION_SETTINGS_VERSION, keepAwake: false, routes: Object.fromEntries(ROUTES.map((route) => [route, off()])), notices: [] };
}

function readRoute(value, route) {
  if (!value || typeof value !== "object" || value.on !== true) return off();
  const since = Number.isSafeInteger(value.since) ? value.since : null;
  if (route === "tailscale") return { on: true, since, name: typeof value.name === "string" && /\.ts\.net$/i.test(value.name) ? value.name : null, ...(value.computers === true ? { computers: true } : {}) };
  return { on: true, since };
}

/**
 * Settings before version 2 had one flag that started everything at launch. The update keeps a route on only where a
 * paired device seen in the last 30 days could be using it, and lists each kept route as a notice: nothing paired keeps
 * nothing on. The sidecar records no route per device, so this goes by what a device could use: Same Wi-Fi for any
 * device; the relay for an end-to-end device not limited to home routes; the HTTPS address for a device not limited
 * to home routes while this computer has its managed address; Tailscale only while this computer has a tailnet address.
 * Anything unreadable is "off": these flags open network listeners.
 */
export function readCompanionSettings(raw, facts = {}) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const keepAwake = parsed.keepAwake === true;
  if (parsed.version === COMPANION_SETTINGS_VERSION) {
    const routes = Object.fromEntries(ROUTES.map((route) => [route, readRoute(parsed.routes?.[route], route)]));
    const notices = Array.isArray(parsed.notices) ? ROUTES.filter((route) => parsed.notices.includes(route) && routes[route].on) : [];
    return { version: COMPANION_SETTINGS_VERSION, keepAwake, routes, notices };
  }
  const settings = { ...defaultCompanionSettings(), keepAwake };
  if (parsed.enabled !== true) return settings;
  const now = facts.now ?? Date.now();
  const recent = (Array.isArray(facts.devices) ? facts.devices : []).filter((device) => Number.isFinite(device?.lastSeenAt) && now - device.lastSeenAt <= RECENT_DEVICE_MS);
  if (recent.length === 0) return settings;
  const away = recent.filter((device) => device.routes !== "local");
  const kept = {
    wifi: true,
    relay: away.some((device) => Number.isSafeInteger(device.e2eAt)),
    tailscale: facts.tailnetAddress === true,
    https: away.length > 0 && facts.managedAddress === true,
  };
  for (const route of ROUTES) if (kept[route]) settings.routes[route] = route === "tailscale" ? { on: true, since: now, name: null } : { on: true, since: now };
  settings.notices = ROUTES.filter((route) => kept[route]);
  return settings;
}

export const anyRouteOn = (settings) => ROUTES.some((route) => settings?.routes?.[route]?.on === true);

/** Same Wi-Fi and Tailscale are what the sidecar itself listens for; the relay and the HTTPS address reach it otherwise. */
export const directRoutesOn = (settings) => ({ wifi: settings?.routes?.wifi?.on === true, tailscale: settings?.routes?.tailscale?.on === true });

export function setRoute(settings, route, on, { now = Date.now(), name, computers } = {}) {
  if (!ROUTES.includes(route)) return settings;
  const current = settings.routes[route];
  const next = on ? { on: true, since: current.on ? current.since : now, ...(route === "tailscale" ? { name: name !== undefined ? name : current.name ?? null, ...((computers ?? current.computers) === true ? { computers: true } : {}) } : {}) } : off();
  return { ...settings, routes: { ...settings.routes, [route]: next }, notices: on ? settings.notices : settings.notices.filter((notice) => notice !== route) };
}

/**
 * The phone link's sidecar runs only for a computer that runs its own server, has a way in turned on and has a device
 * paired with it (or a pairing code open, which the dialog asks for). Never for a desktop that is only a client of
 * another computer.
 */
export function phoneLinkStartsAtLaunch({ remoteClient, serverReady, settings, pairedPhones }) {
  return !remoteClient && serverReady === true && anyRouteOn(settings) && (pairedPhones ?? 0) > 0;
}

/** A running sidecar with nothing paired and no code open goes back to sleep; its routes stay as set. */
export const phoneLinkShouldSleep = (state) =>
  state?.enabled === true && !state.error && state.devicesUnreadable !== true && Array.isArray(state.devices) && state.devices.length === 0 && !state.pairing;

export const companionDevicesFile = (env = process.env, home = os.homedir()) =>
  path.join(env.OMB_COMPANION_DIR ?? path.join(home, ".openmausbot-companion"), "devices.json");

/** Paired devices in the companion's own store; null when the file exists but cannot be read. */
export function readPairedDevices(file = companionDevicesFile()) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? [] : null;
  }
  try {
    const devices = JSON.parse(text)?.devices;
    return Array.isArray(devices) ? devices : null;
  } catch {
    return null;
  }
}

export const countPairedPhones = (file) => readPairedDevices(file)?.length ?? null;

/** Looks at this computer's interfaces only: Tailscale's own interface (`tailscale0`, "Tailscale", or the utun that
 * carries a fd7a:115c:a1e0::/48 address). A 100.64/10 address alone is not Tailscale: carrier NAT and other VPNs use it. */
export function hasTailnetAddress(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).some(([name, entries]) =>
    (entries ?? []).length > 0 && (/^tailscale/i.test(name) || (entries ?? []).some((entry) => /^fd7a:115c:a1e0:/i.test(entry?.address ?? ""))));
}
