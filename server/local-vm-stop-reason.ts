import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

function recordPath(key: string, dataDir: string): string {
  return join(dataDir, "local-vm-stops", `${createHash("sha256").update(key).digest("hex")}.json`);
}

/** Record the runtime's actual finish timestamp. An external stop later gets
 * a different timestamp and must not be misreported as OMB's idle shutdown. */
export function recordLocalVmIdleStop(key: string, stoppedAt: string | null | undefined, dataDir = DATA_DIR): void {
  if (!stoppedAt) return;
  const file = recordPath(key, dataDir);
  mkdirSync(join(dataDir, "local-vm-stops"), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify({ stoppedAt }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function localVmStopReason(key: string, status: { container: string; stopped_at?: string | null }, dataDir = DATA_DIR): "idle" | null {
  if (status.container !== "stopped" || !status.stopped_at) return null;
  try {
    return JSON.parse(readFileSync(recordPath(key, dataDir), "utf8")).stoppedAt === status.stopped_at ? "idle" : null;
  } catch {
    return null;
  }
}
