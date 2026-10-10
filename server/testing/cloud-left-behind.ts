// Test fixture: what a guest left behind on an OMB Cloud home before it was
// personal (server/cloud-owner.ts), made the way the server records it: a
// conversation or room whose opener is nobody (thread-starters.json), a
// routine whose writer is nobody and that carries no owner fingerprint
// (lending-routines.json). The server reads both files when it starts, so
// write them while it is stopped and start it again.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The key of nobody at all (server/index.ts CLOUD_NOBODY_KEY). */
export const CLOUD_NOBODY_KEY = `p_${createHash("sha256").update("cloud-nobody").digest("base64url").slice(0, 22)}`;

export function markLeftBehind(dataDir: string, of: { threadIds?: readonly string[]; routineIds?: readonly string[] }): void {
  const read = (name: string) => {
    const file = join(dataDir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, any> : null;
  };
  if (of.threadIds?.length) {
    const starters = read("thread-starters.json") ?? {};
    for (const threadId of of.threadIds) starters[threadId] = CLOUD_NOBODY_KEY;
    writeFileSync(join(dataDir, "thread-starters.json"), JSON.stringify(starters), { mode: 0o600 });
  }
  if (of.routineIds?.length) {
    const authors = read("lending-routines.json") ?? { version: 1, routines: {}, writers: {} };
    authors.writers ??= {};
    for (const routineId of of.routineIds) {
      delete authors.routines[routineId];
      authors.writers[routineId] = CLOUD_NOBODY_KEY;
    }
    writeFileSync(join(dataDir, "lending-routines.json"), JSON.stringify(authors), { mode: 0o600 });
  }
}
