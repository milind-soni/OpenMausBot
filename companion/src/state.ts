// Where the sidecar keeps its own state, and how it writes it.
//
// Its own directory, not the harness's. The two processes have separate
// lifecycles and separate concerns, and a sidecar that writes into
// ~/.openmausbot would be reaching into somebody else's data layout — the
// exact coupling this design exists to avoid. If the harness reorganises its
// files tomorrow, nothing here notices.
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

/** 0700 on the directory, 0600 on the files it holds.
 *
 * What lives here is the paired fleet: one record per phone, each holding a
 * hash rather than a token. A hash is not a credential, so this is posture
 * rather than a hole — but it is an offline target for anyone who can read
 * it, and the default 0755/0644 publishes both it and which phones someone
 * owns to every other account on the machine. This process is the only reader
 * there has ever been. */
const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
  // mkdirSync's mode applies only to a directory it creates — `recursive`
  // leaves an existing one's mode alone — and an install from before this
  // line already has a 0755 one, so it is tightened here rather than at
  // creation.
  try {
    chmodSync(DATA_DIR, DIR_MODE);
  } catch {
    /* not ours to chmod, or a filesystem with no such notion — the write still works */
  }
}

/**
 * Durable, atomic file replace: write a sibling temp file, fsync it, then
 * rename over the target. `rename(2)` is atomic on the same filesystem, so a
 * crash mid-write can never leave a truncated file behind — a reader sees
 * either the complete old contents or the complete new ones.
 *
 * It matters more here than it looks. This file holds the paired devices; a
 * half-written one fails to parse on next boot and is silently treated as
 * empty, which would sign every phone out with no way to tell why.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // The mode goes on at creation, not after: it is right from the moment
    // the file exists and survives the rename, where a chmod after the fact
    // leaves a window in which the contents are already there and readable
    // for exactly as long as it takes someone to look.
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
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}
