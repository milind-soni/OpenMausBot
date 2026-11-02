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
