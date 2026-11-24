/**
 * Avatar definition contract v1 (see docs/avatar-contract.md).
 *
 * A definition is geometry only: one monochrome silhouette path in a fixed
 * 0 0 100 100 viewBox plus a placement for the eye pair. Everything else
 * (color, implied volume, view, gaze, blinking, motion) is owned by the
 * runtime renderer.
 */

export interface AvatarEyes {
  /** Center of the eye pair, viewBox units. */
  x: number;
  y: number;
  /** Center-to-center distance between the two eyes, viewBox units. */
  spacing: number;
  /** 1 = each neutral eye is ~4 units wide and ~11 units tall. */
  scale: number;
}

export interface AvatarDefinition {
  version: 1;
  /** Lowercase slug, e.g. "controller". */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One filled path, nonzero fill rule; holes wind opposite to their outline. */
  body: { path: string };
  eyes: AvatarEyes;
}

/**
 * What the bot is doing. `thinking` and `blocked` replace the body with a mark (three dots, an
 * exclamation mark); `working` sweeps a band of ribbons round the body every few seconds; `done`
 * celebrates: it turns a few times with ribbons flying, rests, and after a while does it again.
 */
export type AvatarState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';

/** How the bot feels. It shapes the eyes on top of any state; in `idle` a happy bot also hops. */
export type AvatarMood = 'neutral' | 'happy';

/**
 * The single option that came before `state` and `mood`, still accepted: `idle` and `thinking`
 * are states, `happy` is the idle state in a happy mood.
 * @deprecated Use `state` and `mood`.
 */
export type AvatarMotion = 'idle' | 'thinking' | 'happy';

/**
 * A change easing in over what was shown before it: a plain legacy motion, or a state and mood
 * that were themselves still easing in (their progress frozen where it was). `t` 0..1.
 */
export interface AvatarMotionBlend {
  from:
    | AvatarMotion
    | {
        state?: AvatarState;
        mood?: AvatarMood;
        /** @deprecated Use `state` and `mood`. */
        motion?: AvatarMotion;
        /** Seconds that state had been showing when the change began (see RenderOptions.stateAge). */
        age?: number;
        blend?: AvatarMotionBlend;
      };
  t: number;
}

/** A body's finish: a flat fill, or a coat of fluffy fur (live avatars on a canvas, see AvatarOptions). */
export type AvatarMaterial = 'flat' | 'fluffy';

export interface RenderOptions {
  /** Body color as #rgb or #rrggbb. Invalid values fall back to the default. */
  color?: string;
  /** Eye color as #rgb or #rrggbb. Defaults to a plain near-black ink. */
  eyeColor?: string;
  /**
   * Rendered width/height in CSS pixels. Omit for a fluid SVG. In sceneFrame it lets small
   * live avatars skip cross-sections that would sit less than a pixel apart.
   */
  size?: number;
  /** Volume amount 0..14 (default 6 = natural depth; 0 = flat). Scales every part's inferred depth. */
  depth?: number;
  /** Extra view rotation in radians on top of the resting view (drag-to-turn). yaw turns left/right, pitch tips. */
  view?: { yaw: number; pitch: number };
  /** Animation clock in seconds. Same inputs always produce the same SVG. */
  time?: number;
  /**
   * Look target, each axis normalized -1..1 (x right, y down). Overrides idle eye
   * wander and turns the body toward it; `weight` (0..1, default 1) blends it in
   * over the idle pose so following can start and stop without a jump.
   */
  gaze?: { x: number; y: number; weight?: number };
  /** What the bot is doing (default `idle`). */
  state?: AvatarState;
  /** How the bot feels (default `neutral`). */
  mood?: AvatarMood;
  /** @deprecated Use `state` and `mood`; they win when given. */
  motion?: AvatarMotion;
  /**
   * Seconds since `state` began. `done` celebrates from the moment it begins, so hosts that
   * animate pass this (createAnimator returns it); without it the state is drawn at rest.
   */
  stateAge?: number;
  /**
   * Ease into `state` and `mood` from what was shown before: the pose blends between the two
   * and the eyes morph from one shape to the other. Hosts leave it out once `t` reaches 1 (and
   * under reduced motion).
   */
  motionBlend?: AvatarMotionBlend;
  /** Freeze body motion, blinking, ribbons and marks at a calm pose; gaze still applies. */
  reducedMotion?: boolean;
}

export type ValidationResult =
  | { ok: true; value: AvatarDefinition }
  | { ok: false; errors: string[] };
