// Whether this computer's secure HTTPS address is needed. Each address holds one Cloudflare tunnel from a small
// shared pool, so a phone paired once and never used again must not hold one forever.
export const PHONE_UNUSED_RELEASE_MS = 30 * 24 * 60 * 60_000;

/** Phones are paired but none was seen for 30 days: give the address back, keep it ready to come back. */
export const MANAGED_ENDPOINT_PHONES_UNUSED = "unused";

/** Only a known last-seen time more than 30 days old: a missing one, or one in the future, keeps the phone in use. */
export function phoneUnused(device, now = Date.now()) {
  const seen = device?.lastSeenAt;
  return typeof seen === "number" && Number.isFinite(seen) && seen > 0 && now - seen > PHONE_UNUSED_RELEASE_MS;
}

/** true, false, "unused", or null when that cannot be told; only false or "unused" ever gives an address back. Once
 * this computer serves the end-to-end encrypted connection, only an old phone (no `e2eAt`) needs a tunnel: a new
 * pairing never makes one. */
export function managedEndpointNeed(state, now = Date.now()) {
  if (!state || typeof state !== "object" || state.enabled !== true || state.error) return null;
  if (state.devicesUnreadable === true || !Array.isArray(state.devices)) return null;
  const encrypted = state.e2e?.enabled === true;
  if (state.pairing && !encrypted) return true;
  const devices = encrypted ? state.devices.filter((device) => !Number.isSafeInteger(device?.e2eAt)) : state.devices;
  if (devices.length === 0) return false;
  const connected = new Set(Array.isArray(state.connectedDeviceIds) ? state.connectedDeviceIds : []);
  return devices.some((device) => connected.has(device?.id) || !phoneUnused(device, now))
    || MANAGED_ENDPOINT_PHONES_UNUSED;
}
