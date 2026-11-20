// For the doctor's tests: a fresh data folder each, removed after the test, and a context with a fixed clock.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { DOCTOR_BACKUPS_DIR } from "../doctor/backup.ts";
import type { DoctorContext } from "../doctor/types.ts";

export const NOW = Date.UTC(2026, 10, 17, 9, 30, 0);
/** A uuid in the shape atomic.ts puts in a temp file's name. */
export const UUID = "0b4d8f7a-3c2e-4f1a-9b6d-5e7c8a9f0d1e";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export function dataFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "omb-doctor-"));
  folders.push(folder);
  return folder;
}

export function context(dataDir: string, more: Partial<DoctorContext> = {}): DoctorContext {
  return { dataDir, version: "9.9.9", mode: "command", now: () => NOW, startedAt: NOW, pidAlive: () => false, ...more };
}

/** The pid of a process that has ended. */
export function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", ""]);
  return done.pid!;
}

/** The single backup folder a run made, or null. */
export function backupFolder(dataDir: string): string | null {
  let names: string[];
  try { names = readdirSync(join(dataDir, DOCTOR_BACKUPS_DIR)); } catch { return null; }
  if (names.length !== 1) throw new Error(`expected one backup folder, found ${names.length}`);
  return join(dataDir, DOCTOR_BACKUPS_DIR, names[0]!);
}

export function manifest(folder: string): { entries: { check: string; action: string; path: string; savedAs?: string; mode?: string }[] } {
  return JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
}
