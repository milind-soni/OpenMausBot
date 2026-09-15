import { describe, expect, it } from "vitest";
import { bodyPose, MOTION, poseTransform } from "./CursorAvatar";
import { createPoseMotion, stepPoseMotion, type BodyPose } from "./mascot-pose-motion";

function expectPoseClose(actual: BodyPose, expected: BodyPose) {
  for (const axis of Object.keys(actual) as (keyof BodyPose)[]) expect(actual[axis]).toBeCloseTo(expected[axis], 5);
}

describe("activity pose transitions", () => {
  it("keeps the authored working cycle moving unchanged throughout a long task", () => {
    const motion = createPoseMotion();
    for (let frame = 0; frame < 3600; frame++) {
      const target = bodyPose(MOTION.working, frame * 1000 / 60, 1);
      expect(stepPoseMotion(motion, target, "working", 1 / 60)).toEqual(target);
    }
  });

  it("carries a landing into thinking without suddenly undoing the squash", () => {
    const motion = createPoseMotion();
    const landing = bodyPose(MOTION.working, 675, 1);
    stepPoseMotion(motion, landing, "working", 0);
    expect(landing.sy).toBeCloseTo(0.89);
    const before = { ...motion.pose };
    expect(stepPoseMotion(motion, bodyPose(MOTION.thinking, 0, 1), "thinking", 1 / 60)).toEqual(before);
    for (let frame = 1; frame <= 60; frame++) {
      stepPoseMotion(motion, bodyPose(MOTION.thinking, frame * 1000 / 60, 1), "thinking", 1 / 60);
    }
    expectPoseClose(motion.pose, bodyPose(MOTION.thinking, 1000, 1));
    const thinking = { ...motion.pose };
    expect(stepPoseMotion(motion, bodyPose(MOTION.working, 0, 1), "working", 1 / 60)).toEqual(thinking);
  });

  it("enters an attention state smoothly without filtering away its fast jitter", () => {
    const motion = createPoseMotion();
    stepPoseMotion(motion, bodyPose(MOTION.working, 675, 1), "working", 0);
    const before = { ...motion.pose };
    expect(stepPoseMotion(motion, bodyPose(MOTION.alerting, 0, 1), "alerting", 1 / 60)).toEqual(before);
    for (let frame = 1; frame <= 180; frame++) {
      const target = bodyPose(MOTION.alerting, frame * 1000 / 60, 1);
      const pose = stepPoseMotion(motion, target, "alerting", 1 / 60);
      if (frame >= 120) expect(pose).toEqual(target);
    }
  });

  it("retargets rapid tool stages from the current pose instead of a stale origin", () => {
    const motion = createPoseMotion();
    const states = ["working", "thinking", "alerting", "notifying"] as const;
    for (let frame = 0; frame < 240; frame++) {
      const state = states[Math.floor(frame / 3) % states.length];
      const before = { ...motion.pose };
      const changing = motion.state !== null && motion.state !== state;
      const target = bodyPose(MOTION[state], (frame % 3) * 1000 / 60, 1);
      const pose = stepPoseMotion(motion, target, state, 1 / 60);
      if (changing) expect(pose).toEqual(before);
      expect(Object.values(pose).every(Number.isFinite)).toBe(true);
      expect(pose.scale).toBeGreaterThan(0);
      expect(pose.sx).toBeGreaterThan(0);
      expect(pose.sy).toBeGreaterThan(0);
    }
  });

  it("starts a newly mounted entrance small, without easing down from full size", () => {
    const motion = createPoseMotion();
    const target = bodyPose(MOTION.spawning, 0, 1);
    expect(stepPoseMotion(motion, target, "spawning", 1 / 60).scale).toBeCloseTo(0.02, 12);
    expect(poseTransform(motion.pose)).toContain("scale(0.0200)");
  });

  it("clears a transition immediately on pause or reduced motion, then resumes without a jump", () => {
    const motion = createPoseMotion();
    stepPoseMotion(motion, bodyPose(MOTION.working, 675, 1), "working", 0);
    stepPoseMotion(motion, bodyPose(MOTION.thinking, 0, 1), "thinking", 1 / 60);
    const resting = bodyPose(MOTION.thinking, 500, 0);
    expect(stepPoseMotion(motion, resting, "thinking", 1 / 60, true)).toEqual(resting);
    expect(poseTransform(motion.pose)).toBe("");
    expect(Object.values(motion.offset)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Object.values(motion.velocity)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(stepPoseMotion(motion, bodyPose(MOTION.alerting, 3000, 0), "alerting", 3, true)).toEqual(resting);
    expect(stepPoseMotion(motion, bodyPose(MOTION.alerting, 3100, 1), "alerting", 0.1)).toEqual(resting);
    expect(Object.values(stepPoseMotion(motion, bodyPose(MOTION.alerting, 3116, 1), "alerting", 1 / 60)).every(Number.isFinite)).toBe(true);
  });

  it("settles a change at the same speed on 30, 60 and 120 Hz displays", () => {
    const target = bodyPose(MOTION.thinking, 0, 1);
    const results = [30, 60, 120].map(fps => {
      const motion = createPoseMotion();
      stepPoseMotion(motion, bodyPose(MOTION.working, 675, 1), "working", 0);
      stepPoseMotion(motion, target, "thinking", 0);
      for (let frame = 0; frame < fps / 2; frame++) stepPoseMotion(motion, target, "thinking", 1 / fps);
      return motion.pose;
    });
    expectPoseClose(results[0], results[1]);
    expectPoseClose(results[0], results[2]);
  });
});
