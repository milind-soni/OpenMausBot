// A Cloud home's computer runs in UTC, but its owner lives somewhere. "Every day at 9 AM", typed in their browser or
// asked of a bot that reads this computer's clock, must mean their 9 AM; and run titles, the bots' "current time" and
// the browser's clock must agree with the times the app shows them. So the owner's app tells the Cloud its time zone,
// and the server runs in it, the way the desktop runs in its computer's, and follows them when they travel the way a
// laptop's clock does. A desktop never sets one: its computer's clock is already the person's.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const TIME_ZONE_FILE = "time-zone.json";

/** An IANA Area/Location name (or UTC) the runtime knows, as a browser reports it; null for an offset, an abbreviation
 * such as "IST" (which ICU still takes) or anything else. */
export function knownTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || (value !== "UTC" && !/^[A-Za-z][\w+-]*(\/[\w+-]+){1,2}$/.test(value))) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** The zone this process tells time in: TZ when it names one, else the computer's. */
export function currentTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  return knownTimeZone(env.TZ) ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

/** At start, before any routine runs: the zone the owner's app last gave. Assigning process.env.TZ moves Node's clock,
 * and every engine, shell and browser started after it inherits the zone. */
export function adoptSavedTimeZone(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let saved: unknown;
  try {
    saved = (JSON.parse(readFileSync(join(dataDir, TIME_ZONE_FILE), "utf8")) as { timeZone?: unknown } | null)?.timeZone;
  } catch {
    return null;
  }
  const zone = knownTimeZone(saved);
  if (zone) env.TZ = zone;
  return zone;
}

/** True when the zone changed: saved first, so a restart keeps it, then the process runs in it. */
export function useTimeZone(dataDir: string, zone: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TZ === zone) return false;
  writeFileAtomic(join(dataDir, TIME_ZONE_FILE), `${JSON.stringify({ version: 1, timeZone: zone })}\n`, { mode: 0o600 });
  env.TZ = zone;
  return true;
}
