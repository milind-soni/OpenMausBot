export type { AvatarDefinition, AvatarEyes, AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState, RenderOptions, ValidationResult } from './types.ts';
export { validateAvatar } from './validate.ts';
export {
  avatarFrame,
  renderAvatarSvg,
  renderAvatarScene,
  sceneFrame,
  DEFAULT_COLOR,
  DEFAULT_DEPTH,
  DEFAULT_EYE_COLOR,
} from './render.ts';
export type { AvatarFrame, EyeMark, FramePath, FrameShape, Matrix, SceneFrame } from './render.ts';
export { BASE_PITCH, BASE_YAW, DONE_CYCLE_S, DONE_TURN_S, MOODS, STATES, blendPoses, computePose, isMood, isState, resolveLook } from './motion.ts';
export type { EyeLook, Pose, PoseInput } from './motion.ts';
export { MOOD_MS, moodProgress, settleMood } from './mood.ts';
export type { MoodState } from './mood.ts';
export { REST, followGaze, followStep, pointerGaze } from './follow.ts';
export type { FollowState } from './follow.ts';
export { createAnimator } from './animator.ts';
export type { Animator, AnimatorInput, AnimatorStep } from './animator.ts';
export { examples, getExample } from './examples.ts';
