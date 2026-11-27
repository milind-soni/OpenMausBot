// Fixture: what a guest left on a Cloud home before it was personal, as the server records it
// (thread-starters.json, lending-routines.json, and the guest's revoked key in cloud-owner.json, so the Cloud has had
// someone besides its owner). The server reads them at start, so write them while it is stopped.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The key of nobody at all; must match server/index.ts CLOUD_NOBODY_KEY. */
export const CLOUD_NOBODY_KEY = `p_${createHash("sha256").update("cloud-nobody").digest("base64url").slice(0, 22)}`;

/** The guest whose session the Cloud revoked. */
export const CLOUD_GUEST_KEY = `p_${createHash("sha256").update("a guest who left this behind").digest("base64url").slice(0, 22)}`;

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
  const owner = read("cloud-owner.json");
  if (owner && !owner.revokedKeys.includes(CLOUD_GUEST_KEY)) {
    writeFileSync(join(dataDir, "cloud-owner.json"), JSON.stringify({ ...owner, revokedKeys: [...owner.revokedKeys, CLOUD_GUEST_KEY] }), { mode: 0o600 });
  }
}
