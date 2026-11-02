// Plain sentences for a lent screen that cannot work, with the fix the person can make on this computer. They reach
// the bot through the server and this computer's lending activity, so they name no path.
import capabilitiesModule from "./capabilities.cjs";

const { driverBlocked } = capabilitiesModule;

export const SCREEN_LOCKED =
  "This computer's screen is locked, so its apps and screen cannot be seen or used. Unlock it and keep it unlocked while the bot works, then try again.";

export function helperMissing(platform = process.platform) {
  return platform === "win32"
    ? "Computer control could not start on this PC: its helper, cua-driver-background.exe or cua-driver.exe, is missing or blocked. Windows Security may have quarantined it: open Windows Security → Virus & threat protection → Protection history, restore or allow it (or reinstall OpenMausBot), then restart OpenMausBot."
    : "Computer control could not start on this computer: its helper, cua-driver, is missing or blocked. Reinstall OpenMausBot, then restart it.";
}

/** `reason` is the desktop's own cua start-up failure, which never crosses to the server as written. */
export function cuaUnavailable(reason, platform = process.platform) {
  const why = String(reason ?? "");
  if (driverBlocked(why)) return helperMissing(platform);
  if (/Accessibility|Screen Recording|permission/i.test(why)) {
    return "Computer control needs permission on this computer: allow Accessibility and Screen Recording for OpenMausBot in System Settings → Privacy & Security, then restart OpenMausBot.";
  }
  return "Computer control is not running on this computer. Open OpenMausBot on it, check that computer control is on in Settings, then try again.";
}

const PANES = Object.freeze(["accessibility", "screen"]);
/** The macOS permissions computer control lacks, in the order macOS asks for them, from its own start-up failure
 * ("Accessibility and Screen Recording required"): reading it never asks macOS anything. */
export function missingPermissions(reason) {
  const list = typeof reason === "string" ? /((?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))?) required\b/iu.exec(reason)?.[1] ?? "" : "";
  return PANES.filter((pane) => (pane === "screen" ? /Screen Recording/iu : /Accessibility/iu).test(list));
}
