import { statSync } from "node:fs";

/** A file's identity (inode, size, change times), or null when it is missing or was written in the last two seconds: a
 * coarse file system may not tick the mtime of a write that soon, so such a file is never trusted to be unchanged. */
export function settledFileStamp(path: string): string | null {
  try {
    const file = statSync(path, { bigint: true });
    return Date.now() - Number(file.mtimeMs) >= 2_000 ? `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : null;
  } catch {
    return null;
  }
}

/** `parse()` of the file at `path()`, run again only once the file's stamp changes or after forget(). A parse that
 * throws is never kept. */
export function settledFileCache<T>(path: () => string, parse: () => T): { read(): T; forget(): void } {
  let held: { stamp: string; value: T } | null = null;
  return {
    read() {
      const stamp = settledFileStamp(path());
      if (stamp !== null && held?.stamp === stamp) return held.value;
      held = null;
      const value = parse();
      if (stamp !== null) held = { stamp, value };
      return value;
    },
    forget() {
      held = null;
    },
  };
}
