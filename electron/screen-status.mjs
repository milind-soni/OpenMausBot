// Whether this computer's apps and screen can be lent to the person's own Clouds now and, when they can't, why and the
// one fix. Read from computer control's own state: reading it never starts or asks anything.
import capabilitiesModule from "./capabilities.cjs";
import { missingPermissions } from "./lent-screen-failures.mjs";
import { sharedCuaConnection } from "./shared-cua-connection.mjs";

const { driverBlocked, localComputerReady } = capabilitiesModule;

/** A Linux session computer control refuses to drive (Wayland, no desktop, a driver that failed its check). */
const LINUX_UNSUPPORTED = new Set(["linux-wayland-seat-safety-blocked", "headless-session", "unsupported-platform", "bundled-driver-invalid"]);

/**
 * `ready`: computer control works, so apps and screen are lent and used. `lent`: they are lent, which a Mac lacking only
 * macOS's permissions also is, so a Cloud's bot can ask macOS for them. Otherwise `reason`:
 * - "starting": computer control is still starting;
 * - "permissions": macOS has not allowed Accessibility and Screen Recording;
 * - "blocked": its helper is missing, or the system refused to run it;
 * - "off": Linux control is off until the person turns it on;
 * - "not-running": computer control stopped or failed to start;
 * - "unsupported": it can't work in this session (Wayland, no desktop) or this app is a remote companion.
 * `fix`: "start" (start computer control again, or turn Linux control on), "allow" (ask macOS), or null.
 */
export function screenStatus({ platform = process.platform, connection = null, remote = false } = {}) {
  if (remote) return off("unsupported", null);
  if (sharedCuaConnection(connection) !== null && localComputerReady(platform, connection)) return { ready: true, lent: true, reason: null, fix: null };
  if (platform === "darwin" && missingPermissions(connection?.reason).length > 0) return { ready: false, lent: true, reason: "permissions", fix: "allow" };
  if (platform === "linux") {
    if (connection?.status === "disabled" || connection?.reasonCode === "opt-in-required") return off("off", "start");
    if (connection?.status === "checking" || connection?.status === "starting") return off("starting", null);
    if (LINUX_UNSUPPORTED.has(connection?.reasonCode)) return off("unsupported", null, connection?.message);
    return off("not-running", "start");
  }
  if (platform !== "darwin" && platform !== "win32") return off("unsupported", null);
  if (!connection || connection.reason === "not-started") return off("starting", null);
  return driverBlocked(connection.reason) ? off("blocked", "start") : off("not-running", "start");
}

function off(reason, fix, message) {
  return { ready: false, lent: false, reason, fix, ...(typeof message === "string" && message.trim() ? { message: message.trim().slice(0, 300) } : {}) };
}
