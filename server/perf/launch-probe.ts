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

/** A desktop launch whose window never reports in (a start into a Cloud's page, a crashed page) still lets its waiting
 * work run this long after the server listens. */
export const SETTLE_AT_MOST_MS = 15_000;
let settled = watch === null;
const waiting: Array<() => void> = [];
const run = (work: () => void) => { try { work(); } catch (error) { console.warn("launch: deferred start-up work failed", error); } };

export function launchListening(): void {
  if (!listeningAt && !settled) setTimeout(launchSettled, SETTLE_AT_MOST_MS).unref();
  listeningAt ||= Date.now();
}

/**
 * Start-up work the first window does not need (container runtime checks, the process sampler, update and model-list
 * downloads): under the desktop app it waits until the app's window is in use, so it does not compete with the page
 * the person is waiting for. That is when a part of the launch record arrives (the main process sends its part two
 * seconds after the window shows, or at once for a start out of sight; the page sends its part once the chat is drawn),
 * or SETTLE_AT_MOST_MS after listening. Any other server (a Cloud home, a self-hosted one) runs it at once, as before.
 */
export function afterLaunchSettles(work: () => void): void {
  if (settled) run(work); else waiting.push(work);
}

/** The window is in use (perf-host calls this for each launch part it takes): everything waiting runs, in order. */
export function launchSettled(): void {
  if (settled) return;
  settled = true;
  for (const work of waiting.splice(0)) run(work);
}

export function launchServerPart(): { startedAt: number; listeningAt: number; children: unknown; net: unknown } | null {
  return watch && listeningAt ? { startedAt: performance.timeOrigin, listeningAt, ...watch.finish() } : null;
}
