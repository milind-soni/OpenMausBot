import { MASCOT_BODIES, type MascotBodyId } from "../../shared/mascot-bodies";
import { MASCOT_MOTION_POINTS } from "../../shared/mascot-motion-points";

type Anchor = { x: number; y: number; scale: number };

export interface BodyMotion {
  id: MascotBodyId;
  points: number[];
  velocity: number[];
  anchor: Anchor;
  anchorVelocity: Anchor;
  settled: boolean;
}

/** Exact critically damped spring; elapsed seconds give the same motion at any FPS. */
export function springStep(value: number, velocity: number, target: number, dt: number, omega = 18): [number, number] {
  if (!Number.isFinite(dt) || dt <= 0) return [value, velocity];
  const displacement = value - target;
  const impulse = velocity + omega * displacement;
  const decay = Math.exp(-omega * dt);
  return [target + (displacement + impulse * dt) * decay, (velocity - omega * impulse * dt) * decay];
}

export function createBodyMotion(id: MascotBodyId): BodyMotion {
  return {
    id,
    points: [...MASCOT_MOTION_POINTS[id]],
    velocity: MASCOT_MOTION_POINTS[id].map(() => 0),
    anchor: { ...MASCOT_BODIES[id].anchor },
    anchorVelocity: { x: 0, y: 0, scale: 0 },
    settled: true,
  };
}

/** Mutates a mounted avatar's state. Retargeting retains its current contour and velocity. */
export function stepBodyMotion(motion: BodyMotion, id: MascotBodyId, dt: number): boolean {
  if (motion.id === id && motion.settled) return false;
  motion.id = id;
  const target = MASCOT_MOTION_POINTS[id];
  const anchor = MASCOT_BODIES[id].anchor;
  let settled = true;
  for (let i = 0; i < target.length; i++) {
    const [value, velocity] = springStep(motion.points[i], motion.velocity[i], target[i], dt);
    motion.points[i] = value;
    motion.velocity[i] = velocity;
    if (Math.abs(value - target[i]) > 0.001 || Math.abs(velocity) > 0.01) settled = false;
  }
  for (const axis of ["x", "y", "scale"] as const) {
    const [value, velocity] = springStep(motion.anchor[axis], motion.anchorVelocity[axis], anchor[axis], dt);
    motion.anchor[axis] = value;
    motion.anchorVelocity[axis] = velocity;
    if (Math.abs(value - anchor[axis]) > 0.001 || Math.abs(velocity) > 0.01) settled = false;
  }
  motion.settled = settled;
  if (settled) {
    motion.points = [...target];
    motion.velocity.fill(0);
    motion.anchor = { ...anchor };
    motion.anchorVelocity = { x: 0, y: 0, scale: 0 };
  }
  return !settled;
}

/** One path must drive both the body fill and face clip throughout the transition. */
export function bodyMotionPath(points: readonly number[]): string {
  let path = `M${points[0].toFixed(3)} ${points[1].toFixed(3)}`;
  for (let i = 2; i < points.length; i += 2) path += `L${points[i].toFixed(3)} ${points[i + 1].toFixed(3)}`;
  return `${path}Z`;
}
