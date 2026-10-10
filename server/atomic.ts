// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
//
// The fsync is the expensive part: on macOS it is F_FULLFSYNC, about 4 ms of
// blocked event loop per call. `durable: false` drops only the fsync, for
// files whose loss after a power cut costs nothing (a derived cache, a
// session-scoped token). The temp file and rename stay, so an app crash or
// kill -9 still never leaves a torn file; only a power loss or kernel panic
// can leave such a file empty.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export type AtomicWriteOptions = {
  mode?: number;
  /** false skips the fsync. Default true. */
  durable?: boolean;
};

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

export function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    if (options.durable !== false) fsyncSync(fd);
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

/** True only when `path` is already exactly `data`: a regular file (never a
 * symlink, FIFO or directory), owned by this user, with permissions no
 * broader than `mode`. Any doubt or error answers false, so the caller falls
 * back to a full write — this check must never be the reason a save fails.
 *
 * It reads the file on disk rather than remembering the last write: a
 * workspace restore or a hand edit can change the file underneath, and the
 * next save has to put its own bytes back exactly as before. */
function holdsExactly(path: string, data: string, mode: number | undefined): boolean {
  let fd: number | null = null;
  try {
    if (process.platform === "win32") {
      // No O_NOFOLLOW on Windows; a reparse point is replaced, not read.
      if (!lstatSync(path).isFile()) return false;
      fd = openSync(path, "r");
    } else {
      // Inspect and read the same inode the open landed on, so a swap
      // between a stat and the read cannot be mistaken for a match.
      // O_NONBLOCK keeps a FIFO planted at the path from hanging the open.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== Buffer.byteLength(data)) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return false;
    // Windows reports 0o666 for any writable file; its mode bits mean nothing.
    if (mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777 & ~mode) !== 0) return false;
    // Bytes, not strings: decoding and comparing a megabyte-sized registry as
    // a JS string costs several times more than a memcmp of the raw bytes.
    return readFileSync(fd).equals(Buffer.from(data));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** writeFileAtomic for saves that often repeat what the file already holds.
 * A save that changes nothing costs one open and read instead of a temp
 * file, a rename and an fsync; a save whose size differs pays only an
 * open and fstat before the normal write. Returns whether it wrote. */
export function writeFileAtomicIfChanged(path: string, data: string, options: AtomicWriteOptions = {}): boolean {
  if (holdsExactly(path, data, options.mode)) return false;
  writeFileAtomic(path, data, options);
  return true;
}
