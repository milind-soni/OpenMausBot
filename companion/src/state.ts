// The sidecar's own state directory, never the harness's ~/.openmausbot.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OMB_COMPANION_DIR isolates a test rig from a real paired fleet. */
export const DATA_DIR = process.env.OMB_COMPANION_DIR ?? join(homedir(), ".openmausbot-companion");

/** The paired fleet's hashes are an offline target, and the 0755/0644 defaults
 * would publish which phones someone owns to every account on the machine. */
const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
  // mkdirSync's mode applies only to a directory it creates.
  try {
    chmodSync(DATA_DIR, DIR_MODE);
  } catch {
  }
}

/**
 * Temp sibling, fsync, rename over the target: rename(2) is atomic on one
 * filesystem, so a crash never leaves a truncated device file, which would
 * read as empty and sign every phone out.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // The mode goes on at creation, so the contents are never readable meanwhile.
    fd = openSync(tmp, "w", FILE_MODE);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
