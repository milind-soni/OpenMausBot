import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `companion-settings.json` in the app's user data. `enabled` is the phone link, `tailscale` the person's own choice
 * to offer it over their tailnet. */
export const COMPANION_SETTINGS_VERSION = 2;

/**
 * Settings written before version 2 had the phone link and a Tailscale check that started at every launch, whether or
 * not a phone ever paired, so they read as "off" unless a phone is paired; Tailscale is off until the person turns it
 * on. Anything unreadable is "off": these flags open a network listener and run the Tailscale CLI.
 */
export function readCompanionSettings(raw, pairedPhones) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const keepAwake = parsed.keepAwake === true;
  if (parsed.version === COMPANION_SETTINGS_VERSION) {
    return { version: COMPANION_SETTINGS_VERSION, enabled: parsed.enabled === true, keepAwake, tailscale: parsed.tailscale === true };
  }
  return {
    version: COMPANION_SETTINGS_VERSION,
    enabled: parsed.enabled === true && (pairedPhones ?? 0) > 0,
    keepAwake,
    tailscale: false,
  };
}

/** The phone link starts by itself at launch only for a computer that runs its own server and has a phone paired with
 * it; never for a desktop that is only a client of another computer. */
export function phoneLinkStartsAtLaunch({ remoteClient, serverReady, enabled, pairedPhones }) {
  return !remoteClient && serverReady === true && enabled === true && (pairedPhones ?? 0) > 0;
}

export const companionDevicesFile = (env = process.env, home = os.homedir()) =>
  path.join(env.OMB_COMPANION_DIR ?? path.join(home, ".openmausbot-companion"), "devices.json");

/** Paired phones in the companion's own store; null when the file exists but cannot be read. */
export function countPairedPhones(file = companionDevicesFile()) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? 0 : null;
  }
  try {
    const devices = JSON.parse(text)?.devices;
    return Array.isArray(devices) ? devices.length : null;
  } catch {
    return null;
  }
}
