// Per-thread log rotation — the size cap for the two NDJSON tees each
// thread grows: events/<threadId>.ndjson (the bus's canonical stream,
// server/harness/bus.ts) and native/<threadId>.ndjson (the provider-native
// tee, server/drivers/native.ts). Retention sweeps only reach threads that
// closed or archived; a thread that stays open grows both files without
// bound (#1280), and a busy thread can stay open for weeks.
//
// When a capped file outgrows its limit it is rewritten in place, keeping
// the newest half of its bytes and cutting only on a line boundary — the
// same recent tail readThreadEvents already serves. One filename per
// thread and log, before and after: every reader and every cleanup path
// (thread, bot and group delete; the retention sweep) already targets that
// one name, so rotation can never orphan a fragment. What rotates away is
// gone; the cap is opt-in and off by default.
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

let capProvider: () => number | null = () => null;

/** Bound once at server boot: config.json is read per process (a change
 * restarts the server, like every other hand-edited knob), so a binding
 * made at startup stays current for the life of the process. */
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

/** Check a freshly appended log against the configured cap. Best effort and
 * never throwing: a rotation that cannot complete leaves the file exactly
 * as it was, and logging must never break the run it is observing. */
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
      // readSync may hand back fewer bytes than asked for, so fill the
      // window in a loop. A zero count is an early EOF — the file shrank
      // under us — and the original is left untouched.
      let filled = 0;
      while (filled < window.length) {
        const count = readSync(source, window, filled, window.length - filled, start + filled);
        if (count === 0) return;
        filled += count;
      }
      // The window starts mid-line unless a record happened to end exactly
      // at `start`; drop everything up to the first newline so the rewritten
      // file opens on a record boundary. A window without a usable newline
      // is a single record bigger than the keep window — leave the file
      // alone rather than corrupt the only copy.
      const firstNewline = window.indexOf(0x0a);
      if (firstNewline === -1 || firstNewline + 1 >= window.length) return;
      const target = openSync(staging, "w", 0o600);
      try {
        // writeSync can also stop short of the requested length; keep
        // going until every remaining byte lands, and treat zero progress
        // as a failure so the outer catch clears the staging file.
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
      /* an inert staging file is the worst case */
    }
  }
}
