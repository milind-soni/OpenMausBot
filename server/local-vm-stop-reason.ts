import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { z } from "zod";

function recordPath(key: string, dataDir: string): string {
  return join(dataDir, "local-vm-stops", `${createHash("sha256").update(key).digest("hex")}.json`);
}

const stopReceipt = z.object({
  stoppedAt: z.string(),
  backend: z.literal("cua-spaces").optional(),
});

/** Record the runtime's actual finish timestamp. An external stop later gets
 * a different timestamp and must not be misreported as OMB's idle shutdown. */
export function recordLocalVmIdleStop(key: string, stoppedAt: string | null | undefined, dataDir = DATA_DIR): void {
  if (!stoppedAt) return;
  mkdirSync(join(dataDir, "local-vm-stops"), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath(key, dataDir), JSON.stringify({ stoppedAt }), { mode: 0o600 });
}

/** Spaces have no runtime finish timestamp. Keep an app receipt instead;
 * every OMB start/wake or explicit stop/remove clears it. */
export function recordLocalVmSpaceIdleStop(key: string, dataDir = DATA_DIR): void {
  mkdirSync(join(dataDir, "local-vm-stops"), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath(key, dataDir), JSON.stringify({ backend: "cua-spaces", stoppedAt: new Date().toISOString() }), { mode: 0o600 });
}

export function clearLocalVmSpaceIdleStop(key: string, dataDir = DATA_DIR): void {
  rmSync(recordPath(key, dataDir), { force: true });
}

export function localVmStopReason(key: string, status: { container: string; stopped_at?: string | null; backend?: string }, dataDir = DATA_DIR): "idle" | null {
  if (status.container !== "stopped") return null;
  try {
    const receipt = stopReceipt.parse(JSON.parse(readFileSync(recordPath(key, dataDir), "utf8")));
    if (status.backend === "cua-spaces") return receipt.backend === "cua-spaces" ? "idle" : null;
    return status.stopped_at && receipt.backend === undefined && receipt.stoppedAt === status.stopped_at ? "idle" : null;
  } catch {
    return null;
  }
}
