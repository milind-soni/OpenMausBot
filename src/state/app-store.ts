import { flushSync } from "react-dom";

/** Runs `flush` once, at the next animation frame or after `fallbackMs` when no frame comes (a hidden window). */
export type FrameSchedule = (flush: () => void) => () => void;

/** Chromium pauses animation frames in a hidden window; the timer still runs there, throttled. */
const HIDDEN_WINDOW_FALLBACK_MS = 100;

export const nextPaint: FrameSchedule = (flush) => {
  let frame: number | null = null;
  const timer = setTimeout(run, HIDDEN_WINDOW_FALLBACK_MS);
  if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run);
  function cancel() {
    clearTimeout(timer);
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  }
  function run() {
    cancel();
    flush();
  }
  return cancel;
};

export interface AppStore<State, Action, Frame> {
  getState(): State;
  /** Applies every queued frame first, so actions and frames reach the reducer in the order they arrived. */
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
  /** Queues a live frame for the next paint. An urgent frame is applied and rendered now, after every frame queued
   * before it. */
  enqueueFrame(frame: Frame, urgent?: boolean): void;
  /** Applies the queued frames now, in order, as one change to subscribers. */
  flushFrames(): void;
  /** Sets what applies a frame; the returned stop drops the queue. */
  handleFrames(handler: (frame: Frame) => void): () => void;
}

export function createAppStore<State, Action, Frame>(
  reducer: (state: State, action: Action) => State,
  initial: State,
  schedule: FrameSchedule = nextPaint,
): AppStore<State, Action, Frame> {
  let state = initial;
  const listeners = new Set<() => void>();
  let held = 0;
  let changedWhileHeld = false;
  let queue: Frame[] = [];
  let handler: ((frame: Frame) => void) | null = null;
  let cancelScheduled: (() => void) | null = null;

  const notify = () => {
    if (held > 0) {
      changedWhileHeld = true;
      return;
    }
    for (const listener of listeners) listener();
  };
  const flushFrames = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    const apply = handler;
    if (!apply || queue.length === 0) return;
    const frames = queue;
    queue = [];
    held++;
    try {
      for (const frame of frames) {
        try {
          apply(frame);
        } catch (error) {
          // One bad frame must not drop the frames after it, as it could not when each frame had its own task.
          queueMicrotask(() => { throw error; });
        }
      }
    } finally {
      held--;
      if (held === 0 && changedWhileHeld) {
        changedWhileHeld = false;
        notify();
      }
    }
  };

  return {
    getState: () => state,
    dispatch(action) {
      flushFrames();
      const next = reducer(state, action);
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enqueueFrame(frame, urgent = false) {
      queue.push(frame);
      if (urgent) flushSync(flushFrames);
      else if (!cancelScheduled) {
        let ran = false;
        const cancel = schedule(() => { ran = true; flushFrames(); });
        if (!ran) cancelScheduled = cancel;
      }
    },
    flushFrames,
    handleFrames(next) {
      handler = next;
      return () => {
        if (handler !== next) return;
        handler = null;
        queue = [];
        cancelScheduled?.();
        cancelScheduled = null;
      };
    },
  };
}
