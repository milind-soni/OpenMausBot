/**
 * Cursor following, as pure functions the frame loop steps once per frame.
 *
 * The pointer is mapped to a look direction from the avatar's eyes (not its
 * box center, so a pointer level with the eyes reads as level): radial
 * (diagonals are no stronger than straight lines) and soft, so it uses most of
 * the (small) range across the stage around the avatar and saturates gently
 * beyond it. `attention` fades the whole response in and out, so the eyes and
 * the body's turn hand over to idle motion without a jump.
 */

export interface FollowState {
  x: number;
  y: number;
  /** 0 = at rest (idle wander, resting turn), 1 = fully following the pointer. */
  attention: number;
}

export const REST: FollowState = { x: 0, y: 0, attention: 0 };

/** Time constant of the look easing, seconds: quick enough to track a moving pointer. */
const TAU = 0.12;
/**
 * Attention fades in and out more slowly, so taking up a target, losing it
 * (pointer leaves, follow toggled off) or settling back into the resting turn
 * is an unhurried turn rather than a snap.
 */
const ATTEND_TAU = 0.3;
/** Pointer distance, in avatar sizes, at which the look is at tanh(1) ≈ 76% of full. */
const REACH = 1;
/** Small avatars still get a usable reach, CSS px. */
const MIN_SIZE = 160;

/**
 * Look direction (-1..1, x right, y down) toward a viewport point, from the
 * avatar's bounding box. `origin` is where the look starts, as a fraction of
 * the box (the eyes; default the center).
 */
export function pointerGaze(
  pointer: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  origin: { x: number; y: number } = { x: 0.5, y: 0.5 },
) {
  const reach = Math.max(box.width, box.height, MIN_SIZE) * REACH;
  const dx = (pointer.x - (box.left + box.width * origin.x)) / reach;
  const dy = (pointer.y - (box.top + box.height * origin.y)) / reach;
  const m = Math.hypot(dx, dy);
  if (!Number.isFinite(m) || m < 1e-9) return { x: 0, y: 0 };
  const k = Math.tanh(m) / m;
  return { x: dx * k, y: dy * k };
}

/**
 * One easing step toward `target` (null = not following: back to rest).
 * Frame-rate independent; reduced motion snaps. Returns the next state and
 * whether it still needs frames.
 */
export function followStep(state: FollowState, target: { x: number; y: number } | null, dt: number, reduced: boolean): { state: FollowState; moving: boolean } {
  const goal: FollowState = target ? { x: target.x, y: target.y, attention: 1 } : REST;
  const step = Math.max(0, Math.min(dt, 0.1));
  const ease = (tau: number) => (reduced ? 1 : 1 - Math.exp(-step / tau));
  // Losing the target relaxes the look at the unhurried attention rate, as one movement.
  const k = ease(target ? TAU : ATTEND_TAU);
  const next: FollowState = {
    x: state.x + (goal.x - state.x) * k,
    y: state.y + (goal.y - state.y) * k,
    attention: state.attention + (goal.attention - state.attention) * ease(ATTEND_TAU),
  };
  const moving = Math.abs(goal.x - next.x) > 0.002 || Math.abs(goal.y - next.y) > 0.002 || Math.abs(goal.attention - next.attention) > 0.002;
  return { state: moving ? next : goal, moving };
}

/**
 * The pose's look target for a follow state, nothing at all once at rest.
 * Attention eased through a smoothstep is the weight, so the turn starts and
 * ends gently rather than at full speed.
 */
export function followGaze(state: FollowState): { x: number; y: number; weight: number } | undefined {
  const a = Math.min(1, Math.max(0, state.attention));
  return a > 0 ? { x: state.x, y: state.y, weight: a * a * (3 - 2 * a) } : undefined;
}
