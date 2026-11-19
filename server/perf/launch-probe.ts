// This server's own part of the desktop app's launch record: when it started, when it listened, and the programs and
// outside requests it made meanwhile. Only under the desktop app; any other server is left exactly as it is.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { watchLaunchWork } from "../../electron/launch-probes.mjs";

/** With no launch record written by then, the counting stops anyway. */
const WATCH_AT_MOST_MS = 120_000;

const watch = process.env.OMB_DESKTOP_PARENT === "1"
  ? watchLaunchWork({ childProcess: childProcess as unknown as Record<string, unknown>, sync: syncBuiltinESMExports, fetchOwners: [globalThis] })
  : null;
if (watch) setTimeout(() => watch.finish(), WATCH_AT_MOST_MS).unref();
let listeningAt = 0;

export function launchListening(): void {
  listeningAt ||= Date.now();
}

export function launchServerPart(): { startedAt: number; listeningAt: number; children: unknown; net: unknown } | null {
  return watch && listeningAt ? { startedAt: performance.timeOrigin, listeningAt, ...watch.finish() } : null;
}
