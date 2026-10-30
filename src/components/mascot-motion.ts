import { FACE_BOX, type Ring } from "./cursor-face-data";
import type { CursorState, StateEffects } from "./CursorAvatar";

export const FULL_FRAME_MS = 1000 / 60;
export const FRAME_SLACK_MS = 4;
const FRAME_TIERS_MS = [1000 / 20, 1000 / 30, FULL_FRAME_MS];
export const SMOOTH_STEP_PX = 0.5;
export const VISIBLE_PX = 0.2;
const SETTLE_MS = 1400;
export const GLYPH_EASE_MS = 200;
const CRITICAL_SPRING_PEAK = 1 / Math.E;
export const VIEW_SPAN = FACE_BOX + 30;

const BODY_RADIUS = FACE_BOX / 2;
const TAU = Math.PI * 2;
const DEGREE = Math.PI / 180;

export interface BodyMotion {
  bob?: [number, number];
  sway?: [number, number];
  pulse?: [number, number];
  circle?: [number, number];
  jitter?: [number, number];
  tilt?: number;
  squash?: number;
  enter?: [number, number];
  settle?: number;
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
  "powering-down": { settle: 0.05, tilt: 4 },
} satisfies Record<CursorState, BodyMotion>;

const easeOutBack = (t: number) => {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

export function bodyTransform(motion: BodyMotion, elapsed: number, strength: number): string {
  if (strength <= 0) return "";
  const centre = FACE_BOX / 2;
  const ground = FACE_BOX;
  const wave = (period: number, phase = 0) => Math.sin((elapsed / period) * Math.PI * 2 + phase);

  let dx = 0;
  let dy = 0;
  let rotation = motion.tilt ? motion.tilt * strength : 0;
  let scale = 1;
  let sx = 1;
  let sy = 1;

  if (motion.bob) {
    const [amplitude, period] = motion.bob;
    const p = wave(period);
    dy -= amplitude * strength * p;
    if (motion.squash) {
      const amount = motion.squash * strength * Math.max(0, -p);
      sy = 1 - amount * 0.5;
      sx = 1 + amount * 0.5;
    }
  }
  if (motion.circle) {
    const [radius, period] = motion.circle;
    dx += radius * strength * wave(period);
    dy += radius * strength * wave(period, Math.PI / 2);
  }
  if (motion.sway) {
    const [degrees, period] = motion.sway;
    rotation += degrees * strength * wave(period);
  }
  if (motion.pulse) {
    const [fraction, period] = motion.pulse;
    scale *= 1 + fraction * strength * wave(period);
  }
  if (motion.jitter) {
    const [amplitude, period] = motion.jitter;
    dx += amplitude * strength * wave(period);
    dy += amplitude * strength * wave(period * 0.63, 1.1);
  }
  if (motion.enter) {
    const [from, duration] = motion.enter;
    const t = elapsed / duration;
    scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0));
  }
  if (motion.settle !== undefined) {
    const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1);
    scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength;
  }

  const parts: string[] = [];
  if (dx || dy) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  if (rotation) parts.push(`rotate(${rotation.toFixed(2)} ${centre} ${centre})`);
  if (scale !== 1) {
    parts.push(`translate(${centre} ${centre}) scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})`);
  }
  if (sx !== 1 || sy !== 1) {
    parts.push(`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`);
  }
  return parts.join(" ");
}

export interface CadenceInput {
  motion: BodyMotion;
  effects: StateEffects | undefined;
  stateElapsedMs: number;
  strength: number;
  showEffects: boolean;
  showGlyphs: boolean;
  sizePx: number;
  faceUnitsPerMs: number;
  blinkingOrSpinning: boolean;
}

export function frameIntervalFor(pxPerMs: number): number {
  if (!(pxPerMs > 0)) return Infinity;
  for (const ms of FRAME_TIERS_MS) if (pxPerMs * ms <= SMOOTH_STEP_PX) return ms;
  return FULL_FRAME_MS;
}

function loopSpeed(amplitude: number, period: number, px: number): number {
  return amplitude * px >= VISIBLE_PX ? (TAU * amplitude * px) / period : 0;
}

export function bodyPxPerMs(motion: BodyMotion, strength: number, px: number): number {
  if (strength <= 0) return 0;
  let speed = 0;
  if (motion.bob) {
    speed += loopSpeed(motion.bob[0] * strength, motion.bob[1], px);
    if (motion.squash) speed += loopSpeed(motion.squash * strength * 0.5 * FACE_BOX, motion.bob[1], px);
  }
  if (motion.sway) speed += loopSpeed(motion.sway[0] * strength * DEGREE * BODY_RADIUS, motion.sway[1], px);
  if (motion.pulse) speed += loopSpeed(motion.pulse[0] * strength * BODY_RADIUS, motion.pulse[1], px);
  if (motion.circle) speed += loopSpeed(motion.circle[0] * strength, motion.circle[1], px);
  if (motion.jitter) speed += loopSpeed(motion.jitter[0] * strength, motion.jitter[1] * 0.63, px);
  return speed;
}

function bodyTransient(motion: BodyMotion, elapsed: number): boolean {
  return Boolean(motion.enter && elapsed < motion.enter[1]) || (motion.settle !== undefined && elapsed < SETTLE_MS);
}

export function nextFrameAt(now: number, interval: number): number {
  if (interval === Infinity) return Infinity;
  return (Math.floor((now + FRAME_SLACK_MS) / interval) + 1) * interval;
}

export function nextMascotFrame(now: number, input: CadenceInput): number {
  const { motion, effects, stateElapsedMs: elapsed, strength } = input;
  const full = nextFrameAt(now, FULL_FRAME_MS);
  if (input.blinkingOrSpinning) return full;
  if (strength > 0 && input.showEffects && (effects?.confetti || effects?.trails)) return full;
  if (strength > 0 && bodyTransient(motion, elapsed)) return full;
  const px = input.sizePx / VIEW_SPAN;
  const due = nextFrameAt(now, frameIntervalFor(bodyPxPerMs(motion, strength, px) + input.faceUnitsPerMs * px));
  const glyph = input.showGlyphs ? effects?.glyph : undefined;
  if (!glyph) return due;
  const position = elapsed % glyph.period;
  const shown = glyph.period - glyph.hold;
  if (position < shown) return Math.min(due, now + shown - position);
  const fadingOut = glyph.period - GLYPH_EASE_MS;
  if (position < shown + GLYPH_EASE_MS || position >= fadingOut) return full;
  return Math.min(due, now + fadingOut - position);
}

export function morphUnitsPerMs(velocity: number, morph: number, stiffness: number, travel: number): number {
  if (morph >= 1) return 0;
  return (Math.max(Math.abs(velocity), CRITICAL_SPRING_PEAK * stiffness * (1 - morph)) / 1000) * travel;
}

export function faceTravelUnits(
  from: { rings: Ring[]; mouth: number[]; gaze: number[] },
  to: { rings: Ring[]; mouth: number[]; gaze: number[] },
): number {
  let travel = 0;
  from.rings.forEach((ring, eye) => ring.forEach((point, i) => {
    const target = to.rings[eye][i];
    travel = Math.max(travel, Math.hypot(target[0] - point[0], target[1] - point[1]));
  }));
  from.mouth.forEach((value, i) => { travel = Math.max(travel, Math.abs(to.mouth[i] - value)); });
  return travel + Math.hypot(to.gaze[0] - from.gaze[0], to.gaze[1] - from.gaze[1]);
}
