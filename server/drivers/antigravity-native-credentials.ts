// Whether an Antigravity instance may hold a sign-in in the native CLI's own store (the OS keyring, or a file).
//
// The record is the server's, kept beside the instances' profiles and not in one: a process that runs in a bot box
// can write its profile folder but never this one.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

function recordPath(instanceId: string, baseDir: string): string {
  return join(baseDir, "providers", "antigravity-native-credentials", `${createHash("sha256").update(instanceId).digest("hex")}.json`);
}

/** Called before a pasted sign-in code reaches the CLI, and when the CLI reports this instance signed in. */
export function noteAntigravityNativeCredentials(instanceId: string, baseDir = DATA_DIR): void {
  const path = recordPath(instanceId, baseDir);
  mkdirSync(join(baseDir, "providers", "antigravity-native-credentials"), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileAtomic(path, `${JSON.stringify({ since: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function antigravityNativeCredentialsHeld(instanceId: string, baseDir = DATA_DIR): boolean {
  return existsSync(recordPath(instanceId, baseDir));
}

/** Only after the CLI confirmed the sign-in gone, or the instance itself is gone. */
export function clearAntigravityNativeCredentials(instanceId: string, baseDir = DATA_DIR): void {
  rmSync(recordPath(instanceId, baseDir), { force: true });
}
