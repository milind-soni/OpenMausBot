/**
 * The per-avatar state a live renderer keeps between frames, independent of
 * any platform: the eased look toward a target (follow.ts) and the eased
 * change between states and moods (mood.ts). Feed it once per frame; it
 * returns the `gaze`, `motionBlend` and `stateAge` render options for that
 * frame and whether it is still easing.
 */
import { REST, followGaze, followStep, type FollowState } from './follow.ts';
import { DONE_TURN_S, resolveLook } from './motion.ts';
import { moodProgress, settleMood, type MoodState } from './mood.ts';
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types.ts';

export interface AnimatorInput {
  /** Wall clock, ms (e.g. performance.now()). Easing runs on it even when the animation clock stops. */
  now: number;
  state?: AvatarState;
  mood?: AvatarMood;
  /** @deprecated Use `state` and `mood`; they win when given. */
  motion?: AvatarMotion;
  /** Look target, -1..1 per axis (x right, y down), e.g. from pointerGaze; null eases back to rest. */
  target: { x: number; y: number } | null;
  /** Keep the current look as it is (e.g. while the user drags the view). */
  hold?: boolean;
  /** Snap instead of easing. */
  reducedMotion: boolean;
}

export interface AnimatorStep {
  gaze?: { x: number; y: number; weight: number };
  motionBlend?: AvatarMotionBlend;
  /** Seconds since the state began (a change of mood alone does not restart it). */
  stateAge: number;
  /** True while the look or a change of state or mood is still easing. */
  moving: boolean;
}

export interface Animator {
  step(input: AnimatorInput): AnimatorStep;
  /** Back to rest with no history, e.g. when the avatar is remounted. */
  reset(): void;
}

export function createAnimator(): Animator {
  let follow: FollowState = REST;
  let last: number | null = null;
  // What is on screen, when its change began and when its state began.
  let shown: { state: AvatarState; mood: AvatarMood; blend?: AvatarMotionBlend; since: number; began: number } | null = null;

  return {
    step({ now, target, hold = false, reducedMotion, ...given }) {
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      let moving = false;
      if (!hold) ({ state: follow, moving } = followStep(follow, target, dt, reducedMotion));

      // A new state or mood eases in from the pose on screen (a change under way included); reduced motion switches at once.
      const { state, mood } = resolveLook(given);
      if (shown && (state !== shown.state || mood !== shown.mood)) {
        const before: MoodState = {
          state: shown.state,
          mood: shown.mood,
          age: (now - shown.began) / 1000,
          blend: shown.blend && { from: shown.blend.from, t: moodProgress(now - shown.since) },
        };
        shown = {
          state,
          mood,
          blend: reducedMotion ? undefined : { from: settleMood(before), t: 0 },
          since: now,
          began: state === shown.state ? shown.began : now,
        };
      }
      // An avatar that mounts done starts it at rest, as if it had just finished celebrating; any
      // other state starts afresh (a working bot's first sweep comes a second or two in).
      shown ??= { state, mood, since: now, began: now - (state === 'done' ? DONE_TURN_S * 1000 : 0) };
      const t = reducedMotion ? 1 : moodProgress(now - shown.since);
      let motionBlend: AvatarMotionBlend | undefined;
      if (shown.blend && t < 1) motionBlend = { from: shown.blend.from, t };
      else shown.blend = undefined;

      return { gaze: followGaze(follow), motionBlend, stateAge: (now - shown.began) / 1000, moving: moving || motionBlend !== undefined };
    },
    reset() {
      follow = REST;
      last = null;
      shown = null;
    },
  };
}
