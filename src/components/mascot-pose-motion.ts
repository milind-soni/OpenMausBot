import { springStep } from "./mascot-body-motion";

/** Uniform scale uses the centre; squash has its own ground pivot. */
export interface BodyPose {
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
  sx: number;
  sy: number;
}

const AXES = ["dx", "dy", "rotation", "scale", "sx", "sy"] as const;
const ZERO: BodyPose = { dx: 0, dy: 0, rotation: 0, scale: 0, sx: 0, sy: 0 };

export interface PoseMotion {
  state: string | null;
  pose: BodyPose;
  offset: BodyPose;
  velocity: BodyPose;
  paused: boolean;
}

export function createPoseMotion(): PoseMotion {
  return {
    state: null,
    pose: { dx: 0, dy: 0, rotation: 0, scale: 1, sx: 1, sy: 1 },
    offset: { ...ZERO },
    velocity: { ...ZERO },
    paused: false,
  };
}

/**
 * Keep authored cycles intact; only a state change's displacement settles on a
 * spring. Filtering the entire pose would erase the fast scared/alerting jitter.
 */
export function stepPoseMotion(motion: PoseMotion, target: BodyPose, state: string, dt: number, paused = false): BodyPose {
  if (motion.state === null || paused) {
    motion.pose = { ...target };
    motion.offset = { ...ZERO };
    motion.velocity = { ...ZERO };
  } else if (motion.state !== state || motion.paused) {
    for (const axis of AXES) motion.offset[axis] = motion.pose[axis] - target[axis];
    // Preserve the currently displayed pose on the first frame of a new state.
  } else {
    for (const axis of AXES) {
      let [offset, velocity] = springStep(motion.offset[axis], motion.velocity[axis], 0, dt);
      if (Math.abs(offset) < 0.00001 && Math.abs(velocity) < 0.0001) offset = velocity = 0;
      motion.offset[axis] = offset;
      motion.velocity[axis] = velocity;
      motion.pose[axis] = target[axis] + offset;
    }
  }
  motion.state = state;
  motion.paused = paused;
  return motion.pose;
}
