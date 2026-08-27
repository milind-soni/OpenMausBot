// The macOS TCC read.
//
// This is the one health check with no Windows analogue and the one an operator
// cannot script away: Accessibility and Screen Recording are granted per-binary,
// System Integrity Protection blocks writing the TCC database, and replacing the
// driver binary silently revokes them. So this reads the live grant on every
// poll rather than trusting a setup step that happened once.
//
// `currentMacOsPermissionStatus()` is the non-prompting read. Its sibling
// `requestMacOsPermissions()` raises the system dialog and must never be called
// here: an SSH-driven probe has no one at the screen to answer it, and a probe
// that blocks on a dialog reads to the control plane as a hung worker.
import { workerPlatform } from "./platform.ts";

export interface PermissionReport {
  accessibility: boolean | null;
  screenRecording: boolean | null;
}

const UNSUPPORTED: PermissionReport = { accessibility: null, screenRecording: null };

export async function readPermissions(): Promise<PermissionReport> {
  if (workerPlatform() !== "darwin") return UNSUPPORTED;
  // Imported lazily so a Windows worker never loads the darwin native module.
  const { currentMacOsPermissionStatus } = await import("@trycua/cua-driver");
  const status = currentMacOsPermissionStatus();
  // Anything other than an explicit true is reported false so the control
  // plane's ladder fails closed on a driver that answers unexpectedly.
  return {
    accessibility: status?.accessibility === true,
    screenRecording: status?.screenRecording === true,
  };
}

/** The exact line the health probe parses. Kept on one line, no trailing
 * whitespace, so a `grep` for `"accessibility": true` cannot straddle it. */
export const formatPermissions = (report: PermissionReport): string => JSON.stringify(report);
