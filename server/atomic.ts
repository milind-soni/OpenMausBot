// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Windows refuses a rename onto an existing path while anything else holds a
 * handle to either file, and a virus scanner or the search indexer opening a
 * just-closed file for a few milliseconds is enough. It surfaces as EPERM or
 * EACCES from an operation that is correct and would succeed a moment later —
 * so it is retried rather than reported. Everything else throws immediately;
 * a real permission problem must not be papered over by a busy-wait.
 *
 * Total worst case is ~155 ms across 6 attempts. Kept synchronous because
 * every caller is a synchronous save path, and making one of them async is a
 * much larger change than this bug warrants.
 *
 * ponytail: fixed backoff, no jitter. If contention turns out to be heavy
 * enough that these collide, jitter it then. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  // No synchronous sleep in Node without a syscall: a zero-length read on a
  // shared array with a timeout is the standard trick and does not spin the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `rename` is injectable for tests only — there is no portable way to make a
 * real filesystem produce a transient EPERM on demand. */
export function renameWithRetry(
  tmp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export function writeFileAtomic(path: string, data: string, options: { mode?: number } = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, path);
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
