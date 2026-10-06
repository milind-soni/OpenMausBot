import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const Ownership = z.object({ name: z.string(), addedAt: z.string().optional() });

function recordPath(name: string, dataDir: string): string {
  return join(dataDir, "cua-space-ownership", `${createHash("sha256").update(name).digest("hex")}.json`);
}

/** Written before create, then bound to Cua's stable registry creation time
 * when the create response supplies it. Interrupted creates retain ownership. */
export function recordCuaSpaceOwnership(name: string, dataDir = DATA_DIR, addedAt?: string): void {
  mkdirSync(join(dataDir, "cua-space-ownership"), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath(name, dataDir), JSON.stringify({ name, ...(addedAt ? { addedAt } : {}) }), { mode: 0o600 });
}

export function cuaSpaceOwnership(name: string, dataDir = DATA_DIR): z.infer<typeof Ownership> | null {
  try {
    const record = Ownership.safeParse(JSON.parse(readFileSync(recordPath(name, dataDir), "utf8")));
    return record.success && record.data.name === name ? record.data : null;
  } catch {
    return null;
  }
}

/** Only called once both sandbox and registry deletion have succeeded. */
export function forgetCuaSpaceOwnership(name: string, dataDir = DATA_DIR): void {
  rmSync(recordPath(name, dataDir), { force: true });
}
