// CursorAvatar — public import surface. The implementation lives in focused
// modules under ./cursor-avatar/; every name the original single file exported
// is re-exported below, so existing imports keep working unchanged.
// See ./cursor-avatar/component.tsx for the component itself.
export {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
} from "./cursor-face-data";
export type { Ring } from "./cursor-face-data";
export { DEFAULT_GRADIENT, DEFAULT_SILHOUETTE } from "./cursor-avatar/silhouette";
export type { CursorSilhouette } from "./cursor-avatar/silhouette";
export { MOTION, anchorTransform, bodyTransform } from "./cursor-avatar/motion";
export type { BodyMotion } from "./cursor-avatar/motion";
export { EFFECTS, updateEffects } from "./cursor-avatar/effects";
export type {
  ConfettiSpec,
  EffectFrame,
  GlyphSpec,
  StateEffects,
  TrailSpec,
} from "./cursor-avatar/effects";
export { CURSOR_STATES, POOLS, STATE_GROUPS, mouthPath } from "./cursor-avatar/expressions";
export type { CursorState } from "./cursor-avatar/expressions";
export { CursorAvatar } from "./cursor-avatar/component";
export type { CursorAvatarHandle, CursorAvatarProps } from "./cursor-avatar/component";
export { default } from "./cursor-avatar/component";
