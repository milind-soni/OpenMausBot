// The baked-in "cursor" silhouette the mascot wears by default. Split out of
// CursorAvatar.tsx; `MASCOT_BODIES.cursor` stays the single source of truth.
import { MASCOT_BODIES } from '../../../shared/mascot-bodies'

/* ------------------------------------------------------------------- shape */

export interface CursorSilhouette {
  /** Human-readable name, used for the accessible label. */
  name: string
  /** Transform mapping the artwork into the 228.541-unit face box. '' for none. */
  fit: string
  /** SVG markup for the body. The token {{GRADIENT}} is replaced with the instance gradient. */
  body: string
  /** SVG markup defining the clip region — the union of the silhouette's filled shapes. */
  clip: string
  /** Where the face sits inside the silhouette, in face-space units. */
  anchor: { x: number; y: number; scale: number }
}

// The generator solves this body's face placement once; `MASCOT_BODIES.cursor`
// is the single source of truth desktop and iOS both build from. Its shape
// carries one extra field (`id`) that `CursorSilhouette` does not, so it is
// derived here rather than assigned directly.
const { id: _cursorBodyId, ...cursorSilhouette } = MASCOT_BODIES.cursor;
export const DEFAULT_SILHOUETTE: CursorSilhouette = cursorSilhouette;

export const DEFAULT_GRADIENT: [string, string, string] = ["#9FE6B5","#3FAE6E","#1C7A4C"]
