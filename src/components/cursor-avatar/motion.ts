// Body-motion math and view geometry, shape-agnostic so an uploaded logo
// animates like the built-in one. Split out of CursorAvatar.tsx.
import { FACE_BOX, FACE_CENTRE } from '../cursor-face-data'
import type { CursorState } from './expressions'

/* ------------------------------------------------------------------ motion */

/**
 * How the body itself moves. The face engine on its own leaves the silhouette perfectly
 * still, which reads as dead for states literally named `bouncing` or `spawning`.
 *
 * All of this is shape-agnostic — it moves whatever silhouette it is given, so an uploaded
 * logo animates exactly like the built-in circle.
 *
 *   bob     vertical travel, [amplitude in face units, period ms]
 *   sway    rotation, [degrees, period ms]
 *   pulse   uniform scale, [fraction, period ms] — breathing
 *   circle  orbital drift, [radius, period ms]
 *   jitter  fast nervous shake, [amplitude, period ms]
 *   tilt    constant lean, degrees
 *   squash  0..1, how much a bob squashes the body at the bottom of its arc
 *   enter   one-shot on entering the state, [starting scale, duration ms]
 *   settle  scale it eases to and holds, for exits like powering-down
 */
export interface BodyMotion {
  bob?: [number, number]
  sway?: [number, number]
  pulse?: [number, number]
  circle?: [number, number]
  jitter?: [number, number]
  tilt?: number
  squash?: number
  enter?: [number, number]
  settle?: number
}

export const MOTION = {
  // Lifecycle — quiet, breathing, alive but not busy.
  sleeping: { pulse: [0.028, 4600], tilt: 2 },
  waking: { enter: [0.92, 700], pulse: [0.03, 2200] },
  idle: { pulse: [0.014, 3600] },
  listening: { bob: [2, 2600], pulse: [0.012, 2600] },
  thinking: { sway: [1.6, 3000], pulse: [0.01, 3000] },
  searching: { bob: [3, 1400], sway: [2.2, 1400] },
  working: { bob: [2.5, 900], squash: 0.22 },

  // Reactions — the loud half.
  excited: { bob: [9, 520], sway: [3, 1040], squash: 0.35 },
  surprised: { enter: [1.14, 340], jitter: [0.8, 120] },
  suspicious: { sway: [2.4, 2600], tilt: -3 },
  angry: { jitter: [1.3, 95], tilt: 2 },
  drowsy: { pulse: [0.026, 5000], tilt: 3 },
  happy: { bob: [5, 820], squash: 0.28 },
  curious: { sway: [3.4, 1900], tilt: -4 },
  confused: { sway: [3, 2200] },
  bored: { pulse: [0.016, 5200], tilt: 2 },
  proud: { bob: [1.6, 2400], pulse: [0.02, 2400] },
  shy: { pulse: [0.016, 3000], tilt: 4 },
  sad: { pulse: [0.02, 4600], tilt: 3 },
  laughing: { bob: [7, 430], squash: 0.4 },
  scared: { jitter: [2.2, 75] },
  playful: { bob: [6, 620], sway: [5, 1240], squash: 0.3 },
  celebrate: { bob: [10, 480], sway: [4, 960], squash: 0.35 },

  // Agent morphs — the mascot standing in for a process.
  orbit: { circle: [6, 3200] },
  radar: { sway: [6, 2400], pulse: [0.012, 2400] },
  progress: { pulse: [0.022, 1600] },

  // Product cycle.
  spawning: { enter: [0.02, 820], pulse: [0.014, 3600] },
  humming: { pulse: [0.016, 2800] },
  loading: { sway: [2.2, 1500], pulse: [0.012, 1500] },
  dictating: { bob: [2, 2000] },
  writing: { bob: [1.6, 1100] },
  sending: { bob: [3, 900] },
  receiving: { bob: [3, 900] },
  uploading: { bob: [3, 1000] },
  notifying: { bob: [4, 700], sway: [2.5, 700] },
  alerting: { jitter: [2.6, 85] },
  dragging: { tilt: -6, sway: [2, 900] },
  bouncing: { bob: [12, 560], squash: 0.45 },
  'powering-down': { settle: 0.05, tilt: 4 },
} satisfies Record<CursorState, BodyMotion>

/** How long a `settle` takes to reach its resting scale. */
const SETTLE_MS = 1400

export const VIEW_BOX = `-15 -15 ${FACE_BOX + 30} ${FACE_BOX + 30}`
export const SPHERE_C = 114.2705
export const SPHERE_R = 105

export const TAU = Math.PI * 2

/** Face-space transform placing the face inside a silhouette. */
export const anchorTransform = (a: { x: number; y: number; scale: number }) =>
  `translate(${a.x} ${a.y}) scale(${a.scale}) translate(${-FACE_CENTRE[0]} ${-FACE_CENTRE[1]})`

/** Overshooting ease, so a pop-in lands with a little life instead of stopping dead. */
const easeOutBack = (t: number) => {
  const c = 1.7
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))

/**
 * Builds the body's transform for this frame.
 *
 * `elapsed` is time since the state was entered, which is what one-shot entrances need;
 * loops read it too so every mascot on a page doesn't pulse in lockstep.
 */
export function bodyTransform(motion: BodyMotion, elapsed: number, strength: number): string {
  if (strength <= 0) return ''
  const centre = FACE_BOX / 2
  const ground = FACE_BOX
  const wave = (period: number, phase = 0) => Math.sin((elapsed / period) * Math.PI * 2 + phase)

  let dx = 0
  let dy = 0
  let rotation = motion.tilt ? motion.tilt * strength : 0
  let scale = 1
  let sx = 1
  let sy = 1

  if (motion.bob) {
    const [amplitude, period] = motion.bob
    const p = wave(period)
    dy -= amplitude * strength * p
    if (motion.squash) {
      // Squash at the bottom of the arc, stretch at the top. Volume roughly conserved.
      const amount = motion.squash * strength * Math.max(0, -p)
      sy = 1 - amount * 0.5
      sx = 1 + amount * 0.5
    }
  }
  if (motion.circle) {
    const [radius, period] = motion.circle
    dx += radius * strength * wave(period)
    dy += radius * strength * wave(period, Math.PI / 2)
  }
  if (motion.sway) {
    const [degrees, period] = motion.sway
    rotation += degrees * strength * wave(period)
  }
  if (motion.pulse) {
    const [fraction, period] = motion.pulse
    scale *= 1 + fraction * strength * wave(period)
  }
  if (motion.jitter) {
    const [amplitude, period] = motion.jitter
    // Two incommensurate waves read as nervous rather than metronomic.
    dx += amplitude * strength * wave(period)
    dy += amplitude * strength * wave(period * 0.63, 1.1)
  }
  if (motion.enter) {
    const [from, duration] = motion.enter
    const t = elapsed / duration
    scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0))
  }
  if (motion.settle !== undefined) {
    const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1)
    scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength
  }

  const parts: string[] = []
  if (dx || dy) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`)
  if (rotation) parts.push(`rotate(${rotation.toFixed(2)} ${centre} ${centre})`)
  if (scale !== 1) {
    parts.push(`translate(${centre} ${centre}) scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})`)
  }
  if (sx !== 1 || sy !== 1) {
    // Squash pivots on the ground, not the middle — otherwise it floats instead of landing.
    parts.push(`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`)
  }
  return parts.join(' ')
}
