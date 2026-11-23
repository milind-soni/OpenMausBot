/**
 * One shared animation loop for every live avatar on the page.
 *
 * Subscribers measure first and draw second, so layout reads never interleave
 * with DOM writes. The loop sleeps once no subscriber needs frames (every
 * avatar is still, or under reduced motion with its easing settled).
 * Subscribers that ask to wait are skipped until their time comes.
 */

export interface Pointer {
  x: number;
  y: number;
}

export interface FrameSubscriber {
  measure?: () => void;
  /**
   * `time` is the animation clock in seconds, `pointer` the last pointer
   * position in viewport pixels (null when there is none). Return true for
   * the next frame, a number of seconds to skip (neither measured nor drawn
   * until then), or false once no more frames are needed.
   */
  draw: (time: number, pointer: Pointer | null) => boolean | number;
}

const subscribers = new Set<FrameSubscriber>();
let frame = 0;
/** Animation time before which a subscriber that asked to wait is skipped (neither measured nor drawn). */
const due = new WeakMap<FrameSubscriber, number>();
let pointer: Pointer | null = null;
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

function tick(now: number) {
  frame = 0;
  const time = (now - startedAt) / 1000;
  let busy = false;
  const ready: FrameSubscriber[] = [];
  for (const s of subscribers) {
    const at = due.get(s);
    if (at !== undefined && at > time) busy = true;
    else ready.push(s);
  }
  for (const s of ready) s.measure?.();
  for (const s of ready) {
    const next = s.draw(time, pointer);
    if (typeof next === 'number') due.set(s, time + next);
    else due.delete(s);
    busy = next !== false || busy;
  }
  if (busy) wake();
}

function wake() {
  if (!frame && subscribers.size > 0 && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(tick);
}

export function subscribeFrames(subscriber: FrameSubscriber): () => void {
  subscribers.add(subscriber);
  wake();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/** Set the pointer every following avatar looks toward (viewport pixels), or null when there is none. */
export function setPointer(next: Pointer | null) {
  pointer = next;
  wake();
}

/** Request a frame after a non-animated change (color, depth, definition). */
export function requestFrame() {
  wake();
}
