export interface ReplayFrame {
  seq: number;
  kind: string;
  frame: string | null;
  clientFrame: string | null;
  payload: Record<string, unknown> | null;
  /** Only this person's streams get it (a Team Cloud's room as they read it). */
  person?: string;
}

export const REPLAY_MAX_FRAMES = 500;
/** A bot frame carries every task the bot has, so a few hundred of them can hold hundreds of megabytes. */
export const REPLAY_MAX_CHARS = 8_000_000;

/** A frame's payload is kept beside its serialization and costs about as much again. */
function retainedChars(entry: ReplayFrame): number {
  const frame = entry.frame?.length ?? 0;
  const clientFrame = entry.clientFrame !== entry.frame ? entry.clientFrame?.length ?? 0 : 0;
  return frame + clientFrame + (entry.payload ? frame : 0);
}

/** Kinds that mean something only live: the buffer keeps their sequence slot, so resume-gap detection still works, and
 * never the frame. A screen is a large picture, stale at once; a Cloud home's `power` frame ("going to sleep"), replayed
 * to a page that reconnects after waking the home, would send that page straight back to sleep. */
const LIVE_ONLY = new Set(["screen", "power"]);

/** The newest frames for reconnecting streams, oldest first; the newest frame always stays. */
export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private chars = 0;
  private readonly maxFrames: number;
  private readonly maxChars: number;

  constructor(maxFrames = REPLAY_MAX_FRAMES, maxChars = REPLAY_MAX_CHARS) {
    this.maxFrames = maxFrames;
    this.maxChars = maxChars;
  }

  push(entry: ReplayFrame): void {
    const kept = LIVE_ONLY.has(entry.kind) ? { ...entry, frame: null, clientFrame: null, payload: null } : entry;
    this.frames.push(kept);
    this.chars += retainedChars(kept);
    while (this.frames.length > 1 && (this.frames.length > this.maxFrames || this.chars > this.maxChars)) {
      this.chars -= retainedChars(this.frames.shift()!);
    }
  }

  /** Whether every frame after `since` is still here, so a stream resuming from it misses nothing. */
  covers(since: number, lastSeq: number): boolean {
    const oldest = this.frames[0];
    return oldest === undefined ? since === lastSeq : oldest.seq <= since + 1;
  }

  [Symbol.iterator](): Iterator<ReplayFrame> {
    return this.frames[Symbol.iterator]();
  }
}
