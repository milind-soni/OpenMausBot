// Temp file, fsync, rename: rename(2) is atomic on one filesystem, so a reader sees the whole old or the whole new file.
// The fsync (F_FULLFSYNC on macOS, ~4 ms) is what `durable: false` drops: a crash still never tears the file, only a power
// loss can leave it empty.
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

/** Windows refuses a rename onto a path while anything (a virus scanner, the indexer) holds a handle, as EPERM or EACCES
 * that would succeed a moment later, so those are retried (~155 ms worst case); everything else throws. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  // Node has no synchronous sleep: Atomics.wait on a shared buffer blocks without spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Permissions go on the temp inode itself, so a broader-permission file is never visible before a chmod.
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
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}

/** Any doubt answers false, so this check is never why a save fails; it reads the disk, since a restore or hand edit may have changed it. */
function holdsExactly(path: string, data: string, mode: number | undefined): boolean {
  let fd: number | null = null;
  try {
    if (process.platform === "win32") {
      // No O_NOFOLLOW on Windows; a reparse point is replaced, not read.
      if (!lstatSync(path).isFile()) return false;
      fd = openSync(path, "r");
    } else {
      // Inspect the inode the open landed on, so a swap cannot pass as a match; O_NONBLOCK keeps a planted FIFO from hanging the open.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== Buffer.byteLength(data)) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return false;
    // Windows reports 0o666 for any writable file; its mode bits mean nothing.
    if (mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777 & ~mode) !== 0) return false;
    return readFileSync(fd).equals(Buffer.from(data));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

export function writeFileAtomicIfChanged(path: string, data: string, options: AtomicWriteOptions = {}): boolean {
  if (holdsExactly(path, data, options.mode)) return false;
  writeFileAtomic(path, data, options);
  return true;
}

/** A file only this process writes while it runs: a save whose text equals the last one written (or read at load) is
 * skipped without reading the disk back. */
export class OwnedFile {
  private last: string | undefined;
  readonly path: string;
  private readonly options: AtomicWriteOptions;

  constructor(path: string, options: AtomicWriteOptions = {}) {
    this.path = path;
    this.options = options;
  }

  loaded(text: string): void {
    this.last = text;
  }

  /** The text this file holds, as last read or written; undefined before either. */
  current(): string | undefined {
    return this.last;
  }

  write(text: string): boolean {
    if (text === this.last) return false;
    writeFileAtomic(this.path, text, this.options);
    this.last = text;
    return true;
  }
}
