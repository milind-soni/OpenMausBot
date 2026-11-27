import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

function recordPath(key: string, dataDir: string): string {
  return join(dataDir, "local-vm-stops", `${createHash("sha256").update(key).digest("hex")}.json`);
}

export function recordLocalVmIdleStop(key: string, stoppedAt: string | null | undefined, dataDir = DATA_DIR): void {
  if (!stoppedAt) return;
  mkdirSync(join(dataDir, "local-vm-stops"), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath(key, dataDir), JSON.stringify({ stoppedAt }), { mode: 0o600 });
}

export function localVmStopReason(key: string, status: { container: string; stopped_at?: string | null }, dataDir = DATA_DIR): "idle" | null {
  if (status.container !== "stopped" || !status.stopped_at) return null;
  try {
    return JSON.parse(readFileSync(recordPath(key, dataDir), "utf8")).stoppedAt === status.stopped_at ? "idle" : null;
  } catch {
    return null;
  }
}
