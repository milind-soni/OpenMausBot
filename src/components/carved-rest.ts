// When a carved face needs its next frame. A still face asks for none: its body is drawn already, and only a glance,
// a blink or a wake cue changes anything on screen. One face per bot adds up — a sidebar of 150 resting faces at 20
// frames a second was most of the renderer's budget.
import type { CarvedPose } from "./CarvedAvatar";

/** Below this the drawn pose is where the face wants it, and the last fraction of a unit is not visible. */
export const REST_EPSILON = 0.004;

export interface CarvedFrameInput {
  now: number;
  /** The frame interval this face's size allows. */
  frameMs: number;
  /** It is moving: a cue, a blink, or a pose that has not arrived. */
  moving: boolean;
  /** When the next glance is due; Infinity for a mood that does not glance. */
  glanceAt: number;
  /** When the next blink is due. */
  blinkAt: number;
}

/** True when the drawn pose has arrived at what the face wants. */
export function poseAtRest(pose: CarvedPose, want: CarvedPose): boolean {
  return Math.abs(pose.gx - want.gx) < REST_EPSILON
    && Math.abs(pose.gy - want.gy) < REST_EPSILON
    && Math.abs(pose.wide - want.wide) < REST_EPSILON
    && Math.abs(pose.shut - want.shut) < REST_EPSILON
    && Math.abs(pose.smile - want.smile) < REST_EPSILON;
}

/**
 * The time this face wants its next frame, as the clock takes it: `now + frameMs` while it moves, and otherwise the
 * earlier of its next glance and blink. A face with neither (`Infinity`) asks for nothing until it is woken, and the
 * `+ 1` only keeps a due time that has already passed from turning into a spin.
 */
export function nextCarvedFrameAt(input: CarvedFrameInput): number {
  if (input.moving) return input.now + input.frameMs;
  const next = Math.min(input.glanceAt, input.blinkAt);
  return next === Infinity ? Infinity : Math.max(input.now + 1, next);
}
