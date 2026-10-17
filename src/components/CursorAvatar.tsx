/** Made with Blob Studio. */
import React, { useEffect, useId, useMemo, useRef } from 'react'

import { MASCOT_BODIES } from "../../shared/mascot-bodies"
import { GLYPH_BANG, GLYPH_MESSAGE, GLYPH_QUERY } from "./mascot-glyphs"
import {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
  type Ring,
} from "./cursor-face-data"

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
}
export type { Ring }


export interface CursorSilhouette {
  name: string
  fit: string
  /** SVG markup for the body. The token {{GRADIENT}} is replaced with the instance gradient. */
  body: string
  clip: string
  anchor: { x: number; y: number; scale: number }
}

const { id: _cursorBodyId, ...cursorSilhouette } = MASCOT_BODIES.cursor;
export const DEFAULT_SILHOUETTE: CursorSilhouette = cursorSilhouette;

export const DEFAULT_GRADIENT: [string, string, string] = ["#9FE6B5","#3FAE6E","#1C7A4C"]

const VIEW_BOX = `-15 -15 ${FACE_BOX + 30} ${FACE_BOX + 30}`
const SPHERE_C = 114.2705
const SPHERE_R = 105


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
  sleeping: { pulse: [0.028, 4600], tilt: 2 },
  waking: { enter: [0.92, 700], pulse: [0.03, 2200] },
  idle: { pulse: [0.014, 3600] },
  listening: { bob: [2, 2600], pulse: [0.012, 2600] },
  thinking: { sway: [1.6, 3000], pulse: [0.01, 3000] },
  searching: { bob: [3, 1400], sway: [2.2, 1400] },
  working: { bob: [2.5, 900], squash: 0.22 },

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

  orbit: { circle: [6, 3200] },
  radar: { sway: [6, 2400], pulse: [0.012, 2400] },
  progress: { pulse: [0.022, 1600] },

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

const SETTLE_MS = 1400


const TAU = Math.PI * 2

const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const CONFETTI_COLORS = ['#F472B6', '#C084FC', '#818CF8', '#38BDF8', '#34D399', '#FACC15', '#FB7185']
const RIBBON_COLORS = ['#4ADE80', '#34D399', '#22D3EE', '#60A5FA']

export interface ConfettiSpec {
  count: number
  period: number
  life: number
  origin: number
  spread: number
}

export interface TrailSpec {
  count: number
  period: number
  radius: number
}

export interface GlyphSpec {
  markup: string
  period: number
  hold: number
}

export interface StateEffects {
  confetti?: ConfettiSpec
  trails?: TrailSpec
  glyph?: GlyphSpec
}

interface EffectsByState extends Partial<Record<CursorState, StateEffects>> {}

export const EFFECTS: EffectsByState = {
  // Bounded by the viewBox's 15-unit margin: a piece thrown much past ~130 from centre is clipped mid-flight.
  celebrate: { confetti: { count: 16, period: 1500, life: 1300, origin: 74, spread: 54 } },
  excited: { confetti: { count: 9, period: 2000, life: 1100, origin: 72, spread: 44 } },
  laughing: { confetti: { count: 7, period: 2400, life: 1000, origin: 70, spread: 38 } },

  orbit: { trails: { count: 3, period: 2600, radius: 128 } },
  radar: { trails: { count: 2, period: 2000, radius: 132 } },
  progress: { trails: { count: 3, period: 1800, radius: 124 } },
  loading: { trails: { count: 2, period: 2200, radius: 126 } },
  uploading: { trails: { count: 2, period: 1700, radius: 122 } },
  sending: { trails: { count: 2, period: 1500, radius: 120 } },
  receiving: { trails: { count: 2, period: 1500, radius: 120 } },

  alerting: { glyph: { markup: GLYPH_BANG, period: 2600, hold: 1100 } },
  notifying: { glyph: { markup: GLYPH_MESSAGE, period: 4200, hold: 900 } },
  confused: { glyph: { markup: GLYPH_QUERY, period: 5200, hold: 1200 } },
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function poolPaths(layer: SVGGElement, count: number): SVGPathElement[] {
  while (layer.childNodes.length > count) layer.removeChild(layer.lastChild!)
  while (layer.childNodes.length < count) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('fill', 'none')
    layer.appendChild(path)
  }
  return Array.from(layer.querySelectorAll<SVGPathElement>(':scope > path'))
}

function drawConfetti(
  layer: SVGGElement,
  spec: ConfettiSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 1)
    const seedB = hash01(i + 41)
    const seedC = hash01(i + 91)

    const t = (((elapsed + seedC * spec.period) % spec.period) / spec.life) * 1
    if (t > 1) {
      path.setAttribute('opacity', '0')
      continue
    }

    const angle = seedA * TAU
    const travel = spec.spread * (0.45 + seedB * 0.55) * (1 - (1 - t) * (1 - t))
    const distance = (spec.origin + travel) * strength
    const gravity = 34 * strength * t * t
    const x = cx + Math.cos(angle) * distance
    const y = cy + Math.sin(angle) * distance + gravity
    const length = 11 + seedB * 12
    const spin = angle + (seedC - 0.5) * 5 * t
    const ex = x + Math.cos(spin) * length
    const ey = y + Math.sin(spin) * length
    const bend = (seedA - 0.5) * length * 0.7
    const mx = (x + ex) / 2 - Math.sin(spin) * bend
    const my = (y + ey) / 2 + Math.cos(spin) * bend

    path.setAttribute('d', `M${x.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`)
    path.setAttribute('stroke', CONFETTI_COLORS[i % CONFETTI_COLORS.length])
    path.setAttribute('stroke-width', (4 + seedB * 2.4).toFixed(1))
    path.setAttribute('opacity', (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88).toFixed(3))
  }
}

function drawTrails(
  layer: SVGGElement,
  spec: TrailSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  const SAMPLES = 12
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 3)
    const seedB = hash01(i + 29)
    const direction = i % 2 === 0 ? 1 : -1
    const period = spec.period * (0.8 + seedA * 0.5)
    const radius = spec.radius * strength * (0.78 + seedB * 0.4)
    const start = direction * (elapsed / period) * TAU + seedA * TAU
    const span = 0.85 + seedB * 0.7

    let d = ''
    for (let s = 0; s <= SAMPLES; s++) {
      const k = s / SAMPLES
      const angle = start + span * k
      const r = radius * (1 + Math.sin(k * Math.PI) * 0.14)
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r * 0.78
      d += (s === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1)
    }
    path.setAttribute('d', d)
    path.setAttribute('stroke', RIBBON_COLORS[i % RIBBON_COLORS.length])
    path.setAttribute('stroke-width', (5 + seedA * 3).toFixed(1))
    path.setAttribute('opacity', '0.85')
  }
}

function glyphAmount(spec: GlyphSpec, elapsed: number): number {
  const position = elapsed % spec.period
  const start = spec.period - spec.hold
  if (position < start) return 0
  const into = position - start
  const remaining = spec.hold - into
  const EASE = 200
  return Math.max(0, Math.min(1, Math.min(into, remaining) / EASE))
}

export interface EffectFrame {
  trails: SVGGElement | null
  confetti: SVGGElement | null
  glyph: SVGGElement | null
  bodyContent: SVGGElement | null
  state: CursorState
  elapsed: number
  strength: number
  paint: string
  showEffects: boolean
  showGlyphs: boolean
}

export function updateEffects(frame: EffectFrame) {
  const spec = EFFECTS[frame.state]
  const centre = FACE_BOX / 2
  const strength = frame.strength

  if (frame.trails) {
    if (spec?.trails && frame.showEffects && strength > 0) {
      drawTrails(frame.trails, spec.trails, frame.elapsed, strength, centre, centre)
    } else if (frame.trails.childNodes.length) {
      frame.trails.replaceChildren()
    }
  }

  if (frame.confetti) {
    if (spec?.confetti && frame.showEffects && strength > 0) {
      drawConfetti(frame.confetti, spec.confetti, frame.elapsed, strength, centre, centre)
    } else if (frame.confetti.childNodes.length) {
      frame.confetti.replaceChildren()
    }
  }

  if (frame.glyph && frame.bodyContent) {
    if (spec?.glyph && frame.showGlyphs) {
      const amount = glyphAmount(spec.glyph, frame.elapsed)
      const markup = spec.glyph.markup.replace(/\{\{GRADIENT\}\}/g, frame.paint)
      if (frame.glyph.getAttribute('data-glyph') !== markup) {
        frame.glyph.setAttribute('data-glyph', markup)
        frame.glyph.innerHTML = markup
      }
      frame.glyph.style.opacity = String(amount)
      const scale = 0.72 + 0.28 * amount
      frame.glyph.setAttribute(
        'transform',
        `translate(${centre} ${centre}) scale(${scale.toFixed(3)}) translate(${-centre} ${-centre})`
      )
      frame.bodyContent.style.opacity = String(1 - amount)
    } else {
      if (frame.glyph.getAttribute('data-glyph')) {
        frame.glyph.removeAttribute('data-glyph')
        frame.glyph.replaceChildren()
      }
      frame.glyph.style.opacity = '0'
      frame.bodyContent.style.opacity = '1'
    }
  }
}


export type CursorState =
  | "sleeping"
  | "waking"
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "working"
  | "excited"
  | "surprised"
  | "suspicious"
  | "angry"
  | "drowsy"
  | "happy"
  | "curious"
  | "confused"
  | "bored"
  | "proud"
  | "shy"
  | "sad"
  | "laughing"
  | "scared"
  | "playful"
  | "celebrate"
  | "orbit"
  | "radar"
  | "progress"
  | "spawning"
  | "humming"
  | "loading"
  | "dictating"
  | "sending"
  | "receiving"
  | "uploading"
  | "writing"
  | "notifying"
  | "alerting"
  | "bouncing"
  | "dragging"
  | "powering-down"

export const POOLS = {
  sleeping: [
    22,
    13,
    4
  ],
  waking: [
    13
  ],
  idle: [
    6,
    0,
    8
  ],
  listening: [
    1,
    10,
    19
  ],
  thinking: [
    17,
    8,
    16,
    14,
    5
  ],
  searching: [
    20,
    15,
    9,
    3,
    12,
    18
  ],
  working: [
    10,
    7,
    16,
    11
  ],
  excited: [
    2,
    17,
    21,
    3,
    11
  ],
  surprised: [
    21,
    3
  ],
  suspicious: [
    5,
    14,
    23
  ],
  angry: [
    7,
    16
  ],
  drowsy: [
    22,
    4,
    13
  ],
  happy: [
    19,
    2,
    11,
    17
  ],
  curious: [
    21,
    3,
    0,
    15
  ],
  confused: [
    8,
    14,
    5
  ],
  bored: [
    0,
    4,
    22
  ],
  proud: [
    2,
    15,
    8
  ],
  shy: [
    24,
    0,
    13
  ],
  sad: [
    22,
    4,
    13
  ],
  laughing: [
    2,
    11,
    17
  ],
  scared: [
    21,
    3
  ],
  playful: [
    2,
    17,
    11,
    8
  ],
  celebrate: [
    2,
    8,
    17
  ],
  orbit: [
    6,
    0,
    8
  ],
  radar: [
    6,
    0,
    8
  ],
  progress: [
    6,
    0,
    8
  ],
  spawning: [
    3,
    0
  ],
  humming: [
    6,
    0,
    8
  ],
  loading: [
    6,
    0,
    8
  ],
  dictating: [
    1,
    10,
    19
  ],
  sending: [
    6,
    0,
    8
  ],
  receiving: [
    19,
    0,
    8
  ],
  uploading: [
    15,
    9,
    8
  ],
  writing: [
    15,
    9
  ],
  notifying: [
    21,
    3,
    0
  ],
  alerting: [
    21,
    3
  ],
  bouncing: [
    2,
    17
  ],
  dragging: [
    3,
    15,
    0
  ],
  "powering-down": [
    22,
    13
  ]
} satisfies Record<CursorState, number[]>

const EXPR_CADENCE = {
  sleeping: [
    6000,
    10000
  ],
  waking: [
    800,
    800
  ],
  idle: [
    9000,
    16000
  ],
  listening: [
    2800,
    5000
  ],
  thinking: [
    2000,
    3600
  ],
  searching: [
    1000,
    1800
  ],
  working: [
    1800,
    3200
  ],
  excited: [
    1100,
    2000
  ],
  surprised: [
    2500,
    4000
  ],
  suspicious: [
    2600,
    4500
  ],
  angry: [
    2200,
    3800
  ],
  drowsy: [
    4000,
    8000
  ],
  happy: [
    2500,
    4500
  ],
  curious: [
    1800,
    3200
  ],
  confused: [
    2200,
    3800
  ],
  bored: [
    3500,
    6000
  ],
  proud: [
    3500,
    6000
  ],
  shy: [
    3000,
    5500
  ],
  sad: [
    4000,
    7000
  ],
  laughing: [
    1200,
    2400
  ],
  scared: [
    900,
    1800
  ],
  playful: [
    1500,
    3000
  ],
  celebrate: [
    1400,
    2600
  ],
  orbit: [
    4000,
    8000
  ],
  radar: [
    4000,
    8000
  ],
  progress: [
    4000,
    8000
  ],
  spawning: [
    1200,
    1200
  ],
  humming: [
    5000,
    9000
  ],
  loading: [
    6000,
    10000
  ],
  dictating: [
    4000,
    8000
  ],
  sending: [
    4000,
    8000
  ],
  receiving: [
    4000,
    8000
  ],
  uploading: [
    4000,
    8000
  ],
  writing: [
    4000,
    8000
  ],
  notifying: [
    1500,
    2600
  ],
  alerting: [
    2000,
    3600
  ],
  bouncing: [
    3000,
    6000
  ],
  dragging: [
    1600,
    3000
  ],
  "powering-down": [
    6000,
    9000
  ]
} satisfies Record<CursorState, [number, number]>

const BLINK = {
  sleeping: null,
  waking: null,
  idle: [
    6000,
    14000
  ],
  listening: [
    3000,
    7000
  ],
  thinking: [
    3500,
    7000
  ],
  searching: [
    1600,
    4000
  ],
  working: [
    2800,
    5500
  ],
  excited: [
    2000,
    4000
  ],
  surprised: [
    1800,
    3500
  ],
  suspicious: [
    4500,
    8000
  ],
  angry: [
    3500,
    7000
  ],
  drowsy: null,
  happy: [
    2500,
    5000
  ],
  curious: [
    2500,
    5500
  ],
  confused: [
    2800,
    5500
  ],
  bored: [
    4000,
    8000
  ],
  proud: [
    3500,
    7000
  ],
  shy: [
    3000,
    6000
  ],
  sad: [
    4000,
    8000
  ],
  laughing: [
    2500,
    5000
  ],
  scared: [
    1200,
    3000
  ],
  playful: [
    2000,
    4500
  ],
  celebrate: [
    2200,
    4500
  ],
  orbit: null,
  radar: null,
  progress: null,
  spawning: null,
  humming: [
    4000,
    8000
  ],
  loading: null,
  dictating: null,
  sending: null,
  receiving: null,
  uploading: null,
  writing: null,
  notifying: [
    2000,
    4000
  ],
  alerting: null,
  bouncing: null,
  dragging: [
    2200,
    4500
  ],
  "powering-down": null
} satisfies Record<CursorState, [number, number] | null>

export const STATE_GROUPS = {
  "Cycle de vie": [
    "sleeping",
    "waking",
    "idle",
    "listening",
    "thinking",
    "searching",
    "working"
  ],
  "Réactions": [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate"
  ],
  "Morphes agent": [
    "orbit",
    "radar",
    "progress"
  ],
  "Cycle produit": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down"
  ]
} satisfies Record<string, CursorState[]>

const isCursorState = (state: string): state is CursorState => state in POOLS
export const CURSOR_STATES = Object.keys(POOLS).filter(isCursorState)


const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const noTimestamp = (): number | null => null

const toPath = (ring: Ring) =>
  'M' + ring.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'

const clone = (rings: Ring[]): Ring[] =>
  rings.map(r => r.map((p): [number, number] => [p[0], p[1]]))

const ringCentre = (ring: Ring): [number, number] => {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

export function mouthPath(frame: { x: number; y: number; angle: number }, spec: number[]) {
  const ca = Math.cos(frame.angle)
  const sa = Math.sin(frame.angle)
  const at = (lx: number, ly: number): [number, number] => [
    frame.x + lx * ca - ly * sa,
    frame.y + lx * sa + ly * ca,
  ]
  const a = at(-spec[0], 0)
  const c = at(0, spec[1])
  const b = at(spec[0], 0)
  return (
    'M' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
    ' Q' + c[0].toFixed(2) + ' ' + c[1].toFixed(2) +
    ' ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2)
  )
}

export const anchorTransform = (a: { x: number; y: number; scale: number }) =>
  `translate(${a.x} ${a.y}) scale(${a.scale}) translate(${-FACE_CENTRE[0]} ${-FACE_CENTRE[1]})`

const easeOutBack = (t: number) => {
  const c = 1.7
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))

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
    parts.push(`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`)
  }
  return parts.join(' ')
}


export interface CursorAvatarProps {
  state?: CursorState
  expression?: number
  size?: number | string
  gaze?: { x?: number; y?: number }
  turn?: number
  lookAround?: number
  flip?: boolean
  spring?: number
  eyeScale?: number
  showMouth?: boolean
  mouthStroke?: number
  motion?: number
  effects?: boolean
  glyphs?: boolean
  autoBlink?: boolean
  autoExpression?: boolean
  paused?: boolean
  silhouette?: CursorSilhouette
  gradient?: [string, string, string]
  eyeColor?: string
  title?: string | null
  className?: string
  style?: React.CSSProperties
}

export interface CursorAvatarHandle {
  blink: () => void
  spin: (durationMs?: number) => void
  setExpression: (index: number) => void
}

export const CursorAvatar = React.forwardRef<CursorAvatarHandle, CursorAvatarProps>(
  function CursorAvatar(
    {
      state = 'idle',
      expression,
      size = 160,
      gaze,
      turn = 0,
      lookAround = 0.5,
      flip = false,
      spring = 7,
      eyeScale = 1,
      showMouth = true,
      mouthStroke = MOUTH_STROKE,
      motion,
      effects = true,
      glyphs = true,
      autoBlink = true,
      autoExpression = true,
      paused = false,
      silhouette = DEFAULT_SILHOUETTE,
      gradient = DEFAULT_GRADIENT,
      eyeColor = "#ffffff",
      title,
      className,
      style,
    },
    ref
  ) {
    const reactId = useId()
    const uid = useMemo(() => 'mascot' + reactId.replace(/[^a-zA-Z0-9]/g, ''), [reactId])
    const eye0 = useRef<SVGPathElement | null>(null)
    const eye1 = useRef<SVGPathElement | null>(null)
    const mouth = useRef<SVGPathElement | null>(null)
    const bodyGroup = useRef<SVGGElement | null>(null)
    const bodyContent = useRef<SVGGElement | null>(null)
    const trailLayer = useRef<SVGGElement | null>(null)
    const confettiLayer = useRef<SVGGElement | null>(null)
    const glyphLayer = useRef<SVGGElement | null>(null)

    const prefersReducedMotion = useMemo(
      () => globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      []
    )
    const motionStrength = motion ?? (prefersReducedMotion ? 0 : 1)
    const lastState: CursorState = state

    const engine = useRef({
      current: clone(EXPRESSIONS[0]),
      target: EXPRESSIONS[0],
      currentMouth: MOUTHS[0].slice(),
      targetMouth: MOUTHS[0],
      currentGaze: [...GAZE[0]],
      targetGaze: [...GAZE[0]],
      expression: 0,
      morph: 1,
      velocity: 0,
      blinkStart: noTimestamp(),
      spinStart: noTimestamp(),
      spinDuration: 900,
      last: 0,
      stateStart: 0,
      lastState,
      lastBodyTransform: '',
      pausedPaint: '',
      props: {
        state,
        expression,
        gaze,
        turn,
        spring,
        eyeScale,
        paused,
        lookAround,
        motionStrength,
        effects,
        glyphs,
      },
    })
    engine.current.props = {
      state,
      expression,
      gaze,
      turn,
      spring,
      eyeScale,
      paused,
      lookAround,
      motionStrength,
      effects,
      glyphs,
    }

    const selectExpression = (index: number) => {
      const e = engine.current
      const i = ((index % EXPRESSION_COUNT) + EXPRESSION_COUNT) % EXPRESSION_COUNT
      if (i === e.expression && e.morph >= 1) return
      e.current = displayed(e)
      e.currentMouth = displayedMouth(e)
      e.currentGaze = displayedGaze(e)
      e.target = EXPRESSIONS[i]
      e.targetMouth = MOUTHS[i]
      e.targetGaze = GAZE[i]
      e.expression = i
      e.morph = 0
      e.velocity = 0
    }

    React.useImperativeHandle(
      ref,
      () => ({
        blink: () => {
          engine.current.blinkStart = performance.now()
        },
        spin: (durationMs = 900) => {
          engine.current.spinDuration = durationMs
          engine.current.spinStart = performance.now()
        },
        setExpression: selectExpression,
      }),
      []
    )

    useEffect(() => {
      selectExpression(expression ?? POOLS[state][0])
    }, [state, expression])

    useEffect(() => {
      if (!autoExpression || expression !== undefined || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        const [lo, hi] = EXPR_CADENCE[state]
        timer = setTimeout(() => {
          const pool = POOLS[state]
          const alternatives = pool.filter(x => x !== engine.current.expression)
          selectExpression(
            alternatives.length
              ? alternatives[Math.floor(Math.random() * alternatives.length)]
              : pool[0]
          )
          tick()
        }, lo + Math.random() * (hi - lo))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoExpression, expression, paused])

    useEffect(() => {
      const cadence = BLINK[state]
      if (!autoBlink || !cadence || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        timer = setTimeout(() => {
          engine.current.blinkStart = performance.now()
          tick()
        }, cadence[0] + Math.random() * (cadence[1] - cadence[0]))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoBlink, paused])

    useEffect(() => {
      let frame = 0
      let wake: ReturnType<typeof setTimeout> | undefined
      engine.current.last = performance.now()

      const draw = (e: typeof engine.current, now: number, spinTurn: number) => {
        const p = e.props
        const g = displayedGaze(e)
        const look = p.lookAround ?? 0.35
        const ox = g[0] * look
        const oy = g[1] * look
        const rings = displayed(e).map(ring =>
          ring.map((pt): [number, number] => [pt[0] + ox, pt[1] + oy])
        )
        const gx = clamp(p.gaze?.x ?? 0, -1, 1) * GAZE_TRAVEL.x
        const gy = clamp(p.gaze?.y ?? 0, -1, 1) * GAZE_TRAVEL.y
        const radians = (((p.turn ?? 0) + spinTurn) * Math.PI) / 180
        const base = p.eyeScale ?? 1
        const blink = blinkScale(e, now)

        rings.forEach((ring, index) => {
          const el = index === 0 ? eye0.current : eye1.current
          if (!el) return
          const c = ringCentre(ring)
          const baseLongitude = Math.asin(clamp((c[0] - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          el.setAttribute('d', toPath(ring))
          el.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              c[1] + gy
            ).toFixed(2)}) scale(${clamp(perspective * base, 0.02, 2.4).toFixed(4)} ${clamp(
              blink * base,
              0.02,
              2.4
            ).toFixed(4)}) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`
          )
          el.style.opacity = depth > 0.02 ? '1' : '0'
        })

        const mouthEl = mouth.current
        if (mouthEl) {
          const spec = displayedMouth(e)
          const frameGeom = mouthFrame(rings, spec)
          const baseLongitude = Math.asin(clamp((frameGeom.x - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          mouthEl.setAttribute('d', mouthPath(frameGeom, spec))
          mouthEl.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              frameGeom.y + gy
            ).toFixed(2)}) scale(${clamp(perspective, 0.02, 2.4).toFixed(4)} 1) translate(${(
              -frameGeom.x
            ).toFixed(2)} ${(-frameGeom.y).toFixed(2)})`
          )
          mouthEl.style.opacity = depth > 0.02 ? '1' : '0'
        }

        const bodyEl = bodyGroup.current
        if (bodyEl) {
          if (p.state !== e.lastState) {
            e.lastState = p.state
            e.stateStart = now
          }
          const transform = bodyTransform(
            MOTION[p.state] ?? {},
            now - e.stateStart,
            p.motionStrength ?? 1
          )
          if (transform !== e.lastBodyTransform) {
            e.lastBodyTransform = transform
            if (transform) bodyEl.setAttribute('transform', transform)
            else bodyEl.removeAttribute('transform')
          }
        }

        updateEffects({
          trails: trailLayer.current,
          confetti: confettiLayer.current,
          glyph: glyphLayer.current,
          bodyContent: bodyContent.current,
          state: p.state,
          elapsed: now - e.stateStart,
          strength: p.motionStrength ?? 1,
          paint: paintRef.current,
          showEffects: p.effects !== false,
          showGlyphs: p.glyphs !== false,
        })
      }

      const step = (now: number) => {
        const e = engine.current
        const p = e.props
        // Check pause before re-arming (else idle faces tick at display rate), but paint the resting face once: the SVG
        // layers hold no expression until the first draw.
        if (p.paused) {
          e.last = now
          const still = `${p.state}|${p.expression ?? ''}|${paintRef.current}`
          if (e.pausedPaint !== still) {
            e.pausedPaint = still
            draw(e, now, 0)
          }
          wake = setTimeout(() => {
            frame = requestAnimationFrame(step)
          }, 250)
          return
        }
        e.pausedPaint = ''
        frame = requestAnimationFrame(step)
        const dt = Math.min((now - e.last) / 1000, 0.1)
        e.last = now

        const f = p.spring ?? 7
        e.velocity += (-2 * f * e.velocity - f * f * (e.morph - 1)) * dt
        e.morph += e.velocity * dt
        if (!Number.isFinite(e.morph)) {
          e.morph = 1
          e.velocity = 0
        }

        let spinTurn = 0
        if (e.spinStart !== null) {
          const tt = (now - e.spinStart) / e.spinDuration
          if (tt >= 1) e.spinStart = null
          else spinTurn = 360 * tt
        }

        draw(e, now, spinTurn)
      }

      frame = requestAnimationFrame(step)
      return () => {
        cancelAnimationFrame(frame)
        if (wake !== undefined) clearTimeout(wake)
      }
    }, [])

    const paint = `url(#${uid}-grad)`
    const paintRef = useRef(paint)
    paintRef.current = paint

    const dimension = size.constructor === Number ? `${size}px` : size
    const label = title === undefined ? `${silhouette.name} mascot` : title
    const body = silhouette.body.replace(/\{\{GRADIENT\}\}/g, `url(#${uid}-grad)`)

    return (
      <svg
        viewBox={VIEW_BOX}
        width={dimension}
        height={dimension}
        className={className}
        style={style}
        role={label ? 'img' : undefined}
        aria-label={label ?? undefined}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <linearGradient id={`${uid}-grad`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="55%" stopColor={gradient[1]} />
            <stop offset="100%" stopColor={gradient[2]} />
          </linearGradient>
          {/* The fit goes on the clipPath itself: browsers ignore a <g> inside one, which is also why silhouette.clip is pre-flattened. */}
          <clipPath
            id={`${uid}-clip`}
            transform={silhouette.fit || undefined}
            dangerouslySetInnerHTML={{ __html: silhouette.clip }}
          />
        </defs>
        <g transform={flip ? `translate(${FACE_BOX} 0) scale(-1 1)` : undefined}>
          <g ref={trailLayer} />
          <g ref={bodyGroup}>
          <g ref={bodyContent}>
          <g transform={silhouette.fit || undefined} dangerouslySetInnerHTML={{ __html: body }} />
          <g clipPath={`url(#${uid}-clip)`}>
            <g transform={anchorTransform(silhouette.anchor)}>
              <path ref={eye0} fill={eyeColor} />
              <path ref={eye1} fill={eyeColor} />
              {showMouth && (
                <path
                  ref={mouth}
                  fill="none"
                  stroke={eyeColor}
                  strokeWidth={mouthStroke}
                  strokeLinecap="round"
                />
              )}
            </g>
          </g>
          </g>
          <g ref={glyphLayer} style={{ opacity: 0 }} />
          </g>
          <g ref={confettiLayer} />
        </g>
      </svg>
    )
  }
)


function displayed(e: { current: Ring[]; target: Ring[]; morph: number }): Ring[] {
  const m = clamp(e.morph, 0, 1)
  return e.current.map((ring, eye) =>
    ring.map((p, i): [number, number] => [
      p[0] + (e.target[eye][i][0] - p[0]) * m,
      p[1] + (e.target[eye][i][1] - p[1]) * m,
    ])
  )
}

function displayedMouth(e: { currentMouth: number[]; targetMouth: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentMouth.map((v, i) => v + (e.targetMouth[i] - v) * m)
}

function displayedGaze(e: { currentGaze: number[]; targetGaze: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentGaze.map((v, i) => v + (e.targetGaze[i] - v) * m)
}

function blinkScale(e: { blinkStart: number | null }, now: number) {
  if (e.blinkStart === null) return 1
  const t = (now - e.blinkStart) / 320
  if (t >= 1) {
    e.blinkStart = null
    return 1
  }
  return Math.max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
}

export default CursorAvatar
