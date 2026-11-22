// Whether an Antigravity instance may hold a sign-in in the native CLI's own store (the OS keyring, or a file).
//
// The record is the server's, kept beside the instances' profiles and not in one: a process that runs in a bot box
// can write its profile folder but never this one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

/** `cli`: the CLI path the instance was configured with when the CLI held its sign-in, for signing it out after a switch. */
export interface NativeCredentialsRecord {
  since: string;
  cli?: string;
}

function recordPath(instanceId: string, baseDir: string): string {
  return join(baseDir, "providers", "antigravity-native-credentials", `${createHash("sha256").update(instanceId).digest("hex")}.json`);
}

export function antigravityNativeCredentials(instanceId: string, baseDir = DATA_DIR): NativeCredentialsRecord | null {
  let text: string;
  try { text = readFileSync(recordPath(instanceId, baseDir), "utf8"); } catch { return null; }
  try {
    const parsed = JSON.parse(text) as Partial<NativeCredentialsRecord> | null;
    const cli = typeof parsed?.cli === "string" && parsed.cli.trim() ? parsed.cli : undefined;
    return { since: typeof parsed?.since === "string" ? parsed.since : "", ...(cli ? { cli } : {}) };
  } catch {
    return { since: "" };
  }
}

/** Called before a pasted sign-in code reaches the CLI, and whenever the CLI accepts a session for this instance. */
export function noteAntigravityNativeCredentials(instanceId: string, cli: string | undefined, baseDir = DATA_DIR): void {
  const known = antigravityNativeCredentials(instanceId, baseDir);
  const configured = cli?.trim() || undefined;
  if (known && (configured === undefined || known.cli === configured)) return;
  mkdirSync(join(baseDir, "providers", "antigravity-native-credentials"), { recursive: true, mode: 0o700 });
  const record: NativeCredentialsRecord = { since: known?.since || new Date().toISOString(), ...(configured ? { cli: configured } : {}) };
  writeFileAtomic(recordPath(instanceId, baseDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function antigravityNativeCredentialsHeld(instanceId: string, baseDir = DATA_DIR): boolean {
  return antigravityNativeCredentials(instanceId, baseDir) !== null;
}

/** Only after the CLI confirmed the sign-in gone, or the instance itself is gone. */
export function clearAntigravityNativeCredentials(instanceId: string, baseDir = DATA_DIR): void {
  rmSync(recordPath(instanceId, baseDir), { force: true });
}
