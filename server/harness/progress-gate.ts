// Coalesces turn.progress for the bus. An engine can report a tool call's input dozens of times a second; the chat's
// status line needs a frame only when what it shows changes, and never more than a few a second.
import { progressKey } from "../../shared/turn-progress.ts";
import type { RuntimeEvent } from "../contracts.ts";

export type ProgressEvent = Extract<RuntimeEvent, { type: "turn.progress" }>;

/** The least time between two frames for one thread. */
export const PROGRESS_FRAME_MS = 400;

interface ThreadGate {
  shown: string;
  sentAt: number;
  pending: ProgressEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ProgressGate {
  private readonly threads = new Map<string, ThreadGate>();
  private readonly send: (event: ProgressEvent) => void;
  private readonly now: () => number;
  private readonly frameMs: number;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(send: (event: ProgressEvent) => void, options: { now?: () => number; frameMs?: number } = {}) {
    this.send = send;
    this.now = options.now ?? Date.now;
    this.frameMs = options.frameMs ?? PROGRESS_FRAME_MS;
  }

  /** A report that reads like the last one sent is dropped; a new one goes now, or when the thread's frame window ends. */
  offer(event: ProgressEvent): void {
    let gate = this.threads.get(event.threadId);
    if (!gate) {
      gate = { shown: "", sentAt: -Infinity, pending: null, timer: null };
      this.threads.set(event.threadId, gate);
    }
    if (progressKey(event) === gate.shown) {
      gate.pending = null;
      return;
    }
    const wait = gate.sentAt + this.frameMs - this.now();
    if (wait <= 0) {
      this.release(gate);
      this.emit(gate, event);
      return;
    }
    gate.pending = event;
    if (gate.timer) return;
    const held = gate;
    held.timer = setTimeout(() => {
      held.timer = null;
      const next = held.pending;
      held.pending = null;
      if (next) this.emit(held, next);
    }, wait);
    held.timer.unref?.();
  }

  /** Anything else the thread says is newer than a waiting report, which is dropped; the turn's end forgets the thread. */
  supersede(threadId: string, ended: boolean): void {
    const gate = this.threads.get(threadId);
    if (!gate) return;
    this.release(gate);
    gate.shown = "";
    if (ended) this.threads.delete(threadId);
  }

  private release(gate: ThreadGate): void {
    if (gate.timer) clearTimeout(gate.timer);
    gate.timer = null;
    gate.pending = null;
  }

  private emit(gate: ThreadGate, event: ProgressEvent): void {
    gate.shown = progressKey(event);
    gate.sentAt = this.now();
    this.send(event);
  }
}
