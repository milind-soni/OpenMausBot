// Opt-in size cap for per-thread NDJSON logs: keep the newest half, cut on a line boundary, same filename.
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

let capProvider: () => number | null = () => null;

export function bindThreadLogCapProvider(provider: () => number | null): void {
  capProvider = provider;
}

export function currentThreadLogCap(): number | null {
  try {
    return capProvider();
  } catch {
    return null;
  }
}

export function capThreadLog(file: string, maxBytes: number | null): void {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) return;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  trimToTail(file, Math.max(1, Math.floor(maxBytes / 2)));
}

function trimToTail(file: string, keepBytes: number): void {
  const staging = `${file}.trim`;
  try {
    const source = openSync(file, "r");
    try {
      const size = fstatSync(source).size;
      const start = Math.max(0, size - keepBytes);
      const window = Buffer.allocUnsafe(size - start);
      // readSync may return fewer bytes than asked; zero means the file shrank, so leave it.
      let filled = 0;
      while (filled < window.length) {
        const count = readSync(source, window, filled, window.length - filled, start + filled);
        if (count === 0) return;
        filled += count;
      }
      // Start on a record boundary; a window with no newline is one oversized record, so leave the file alone.
      const firstNewline = window.indexOf(0x0a);
      if (firstNewline === -1 || firstNewline + 1 >= window.length) return;
      const target = openSync(staging, "w", 0o600);
      try {
        // writeSync can stop short too; zero progress is a failure.
        let written = firstNewline + 1;
        while (written < window.length) {
          const count = writeSync(target, window, written, window.length - written);
          if (count === 0) throw new Error(`no progress writing ${staging}`);
          written += count;
        }
      } finally {
        closeSync(target);
      }
    } finally {
      closeSync(source);
    }
    renameSync(staging, file);
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
    }
  }
}
