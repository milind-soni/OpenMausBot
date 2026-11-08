import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export function readBoundedSkillDescriptor(fd: number, expectedBytes: number): Buffer | null {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) return null;
  const bytes = Buffer.allocUnsafe(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (!count) break;
    offset += count;
  }
  return offset === expectedBytes ? bytes.subarray(0, expectedBytes) : null;
}

export function readBoundedSkillFile(path: string, limit: number): Buffer | null {
  let fd: number | null = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink > 1 || before.size > limit) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = readBoundedSkillDescriptor(fd, before.size), after = fstatSync(fd);
    return bytes && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs ? bytes : null;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}
