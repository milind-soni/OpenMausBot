// The native Antigravity CLI releases that asked for a bridged agents tool in a spelling the approval path does not
// know. Such a request is refused, and from then on that release's turns list the agents tools unbridged.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

const FILE = "antigravity-bridge.json";

export const unbridgeableFile = (dataDir = DATA_DIR) => join(dataDir, FILE);

/** The versions recorded; an absent or unreadable record counts as none. A release in a damaged record is then
 * bridged again, and its first request in an unknown spelling is refused and recorded again; a turn is never stopped
 * by the record. */
export function unbridgeableVersions(file = unbridgeableFile()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { unbridgeable?: unknown };
    return Array.isArray(parsed.unbridgeable) ? parsed.unbridgeable.filter((version): version is string => typeof version === "string") : [];
  } catch {
    return [];
  }
}

export function rememberUnbridgeable(version: string, file = unbridgeableFile()): void {
  const known = unbridgeableVersions(file);
  if (known.includes(version)) return;
  writeFileAtomic(file, `${JSON.stringify({ unbridgeable: [...known, version] }, null, 2)}\n`, { mode: 0o600 });
}
