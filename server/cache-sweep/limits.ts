// The cache cap's numbers and switches, in one place (docs/bot-box.md, "Tool caches"). The cap is the smaller of 10 GB and
// 15% of the volume, per root group (the tools' cache folders, split evenly between a Team Cloud's audiences, and the
// app's own cache folder): 15% leaves a small Cloud (10 GB) 1.5 GB of caches, enough for a few projects' packages, and
// 10 GB keeps a large disk's caches from crowding out the work it was bought for. Everything in these folders is
// downloaded or computed again.
import { cloudRole } from "../bot-box/detect.ts";

export const GIB = 1024 ** 3;
/** The cap: the smaller of this and CAP_SHARE of the volume. */
export const CAP_MAX_BYTES = 10 * GIB;
export const CAP_SHARE = 0.15;
/** At this share of the volume used, the tools' caches are removed, least recently written first, until it is under
 * EMERGENCY_TARGET, but only while no bot process is alive (sweeper.ts). */
export const EMERGENCY_FULL = 0.95;
export const EMERGENCY_TARGET = 0.9;
/** An entry changed this recently may be a download or an install that just finished: no pass removes it. */
export const RECENT_MS = 30 * 60_000;
/** A full sweep (measure, then remove the least recently written over the cap) at most this often. */
export const SWEEP_EVERY_MS = 60 * 60_000;
/** The sweeper's tick: it looks at the disk for the emergency pass, and runs a sweep that is due, or that a busy home put
 * off, so a busy home is tried again within minutes, not an hour. */
export const TICK_EVERY_MS = 5 * 60_000;
/** After an emergency pass removed something, the next waits this long. */
export const EMERGENCY_BACKOFF_MS = 30 * 60_000;
/** Work per tick, then a pause, so the event loop and the disk stay free for turns. */
export const TICK_ENTRIES = 5_000;
export const YIELD_EVERY = 200;
export const TICK_PAUSE_MS = 1_000;

/** The switch: 1, on, true or yes on a Cloud home starts the sweeper and the admin routes; off, nothing is read, started or
 * deleted, and the routes are not there. */
export const CACHE_SWEEP_SWITCH = "OMB_CACHE_SWEEP";
/** Cap overrides, in bytes or with a K, M, G or T suffix (powers of 1024). */
export const TOOL_CAP_ENV = "OMB_CACHE_CAP_TOOLS";
export const APP_CAP_ENV = "OMB_CACHE_CAP_APP";

const ON = new Set(["1", "on", "true", "yes"]);

export function cacheSweepOn(env: Record<string, string | undefined>): boolean {
  return cloudRole(env) && ON.has((env[CACHE_SWEEP_SWITCH] ?? "").trim().toLowerCase());
}

/** `10G`, `512M`, `2000000`: bytes, or null for anything else. */
export function parseSize(raw: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(raw?.trim() ?? "");
  if (!match) return null;
  const power = ["", "K", "M", "G", "T"].indexOf(match[2]!.toUpperCase());
  const bytes = Math.floor(Number(match[1]) * 1024 ** power);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

/** The cap for a volume of `volumeBytes`: the override when it parses, else the smaller of CAP_MAX_BYTES and CAP_SHARE. */
export function capBytes(volumeBytes: number, override?: string): number {
  return parseSize(override) ?? Math.floor(Math.min(CAP_MAX_BYTES, CAP_SHARE * volumeBytes));
}
