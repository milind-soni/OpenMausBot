import { RESTART_EXIT_CODE } from "./restart.ts";

// Whole-file saves asked for while one synchronous pass runs (one runtime event's delivery, a turn's start) are written
// once when the pass returns, before anything else can run: the files hold what they would have held at every point
// the server yields to the event loop, with one write instead of one per change.

let depth = 0;
const pending = new Map<object, () => void>();

export function batchSaves<T>(run: () => T): T {
  depth += 1;
  try {
    return run();
  } finally {
    depth -= 1;
    if (depth === 0) writePending();
  }
}

/** Writes now, or once at the end of the running batch; `owner` keeps one pending write per file. */
export function saveSoon(owner: object, write: () => void): void {
  if (depth === 0) write();
  else pending.set(owner, write);
}

function writePending(): void {
  while (pending.size) {
    const [owner, write] = pending.entries().next().value!;
    pending.delete(owner);
    try {
      write();
    } catch (error) {
      // The changes stay in memory and the next save of the file writes them; a failed save never ends the pass early.
      console.error("a batched save failed; the next save of the file retries it", error);
    }
  }
}

// A few changes a turn makes at its end are harmless to lose (server/registry-save.ts DEFERRABLE_FIELDS says which and
// why), and each whole-file save blocks the server for as long as the file is big. Those changes are written together,
// a bounded moment after the first one. A crash inside that moment loses them: the file then holds the state of at most
// SAVE_LATER_MAX_MS earlier, whole and consistent, since it is still written in one piece. Anything else (what a person
// or a bot asked for, an engine session set or cleared, what was handed to an engine) never goes through here.
const SAVE_LATER_MIN_MS = 50;
export const SAVE_LATER_MAX_MS = 1_000;
/** Saving waits this many times as long as the last save took, so it stays under a tenth of the server's time however big the file is. */
const SAVE_LATER_COST_FACTOR = 10;
const SAVE_LATER_RETRIES = 5;

const later = new Map<unknown, () => void>();
let laterTimer: ReturnType<typeof setTimeout> | undefined;
let lastLaterWriteMs = 0;
let laterFailures = 0;
let flushesAtExit = false;

export const saveLaterDelayMs = (): number => Math.min(SAVE_LATER_MAX_MS, Math.max(SAVE_LATER_MIN_MS, lastLaterWriteMs * SAVE_LATER_COST_FACTOR));

/** Writes within saveLaterDelayMs() of the first change still waiting; `owner` (the file's path) keeps one waiting write per file. */
export function saveLater(owner: unknown, write: () => void): void {
  later.set(owner, write);
  if (!flushesAtExit) {
    flushesAtExit = true;
    process.on("exit", flushAtCleanExit);
  }
  laterTimer ??= setTimeout(flushLaterSaves, saveLaterDelayMs());
}

/** A write still waiting for this file has nothing left to add: the file was just written whole, or is being loaded afresh. */
export function supersedeLaterSave(owner: unknown): void {
  later.delete(owner);
}

export const waitingSaves = (): number => later.size;

/**
 * What waits is written when the process ends cleanly: a graceful shutdown (server/index.ts flushes before its exit),
 * a restart it asked for (75), or a plain exit (0). An exit after a fatal error (1 from an uncaught exception, 70 from
 * the crash guard) writes nothing: memory may hold half a change, and the file on disk is the last whole state, at most
 * SAVE_LATER_MAX_MS old. A kill (SIGKILL, or Windows' TerminateProcess, which is how the desktop app stops its server
 * there) runs no handler at all, so the same holds.
 */
export function flushAtCleanExit(code: number): void {
  if (code === 0 || code === RESTART_EXIT_CODE) flushLaterSaves();
}

/** Writes everything still waiting, now. Called before the process exits and before anything reads the files from disk. */
export function flushLaterSaves(): void {
  if (laterTimer) clearTimeout(laterTimer);
  laterTimer = undefined;
  if (!later.size) return;
  const started = performance.now();
  let failed = false;
  for (const [owner, write] of Array.from(later)) { // a snapshot: a failed write is put back and must not be met again here
    later.delete(owner);
    try {
      write();
    } catch (error) {
      failed = true;
      if (!later.has(owner)) later.set(owner, write);
      console.error("a deferred save failed; it is tried again", error);
    }
  }
  lastLaterWriteMs = performance.now() - started;
  laterFailures = failed ? laterFailures + 1 : 0;
  // After SAVE_LATER_RETRIES failures in a row the write waits for the file's next save or the exit, instead of a timer.
  if (later.size && laterFailures <= SAVE_LATER_RETRIES) laterTimer = setTimeout(flushLaterSaves, SAVE_LATER_MAX_MS);
}
