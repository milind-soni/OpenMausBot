/**
 * Changes of state and mood as pure functions a frame loop steps: the pose
 * eases from what is on screen into the new state and mood (see blendPoses in
 * motion.ts), and a change during a change continues from where it is.
 */
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types.ts';

/** Length of a mood change, ms. */
export const MOOD_MS = 420;

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Eased progress of a mood change from elapsed time (smoothstep, clamped). */
export function moodProgress(elapsedMs: number): number {
  return smooth(elapsedMs / MOOD_MS);
}

/** A state and mood on screen, possibly still easing in over what came before. */
export interface MoodState {
  state?: AvatarState;
  mood?: AvatarMood;
  /** @deprecated Use `state` and `mood`. */
  motion?: AvatarMotion;
  /** Seconds the state had been showing when the next change began. */
  age?: number;
  blend?: AvatarMotionBlend;
}

/**
 * What a new mood change eases in from: the mood on screen with any change
 * still under way frozen at its progress, so the pose continues from exactly
 * where it is. Older changes whose share has all but faded (or beyond a few
 * levels) are dropped, so rapid clicking never grows the chain.
 */
export function settleMood(state: MoodState, share = 1, depth = 0): MoodState {
  const b = state.blend;
  if (!b) return state;
  const { blend: _, ...settled } = state;
  const rest = share * (1 - b.t);
  if (rest < 0.02 || depth >= 3) return settled;
  return { ...settled, blend: { from: typeof b.from === 'string' ? b.from : settleMood(b.from, rest, depth + 1), t: b.t } };
}
