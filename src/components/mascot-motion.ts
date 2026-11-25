import { FACE_BOX, type Ring } from "./cursor-face-data";
import type { CursorState, StateEffects } from "./CursorAvatar";

export const FULL_FRAME_MS = 1000 / 60;
export const LIST_FRAME_MS = 1000 / 30;
export const FRAME_SLACK_MS = 4;
const FRAME_TIERS_MS = [LIST_FRAME_MS, FULL_FRAME_MS];
export const SMALL_MASCOT_PX = 64;
export const COMPACT_MASCOT_PX = 36;
export const SMOOTH_STEP_PX = 0.5;
export const VISIBLE_PX = 0.2;
const SETTLE_MS = 1400;
export const GLYPH_EASE_MS = 200;
const CRITICAL_SPRING_PEAK = 1 / Math.E;
export const VIEW_SPAN = FACE_BOX + 30;

const BODY_RADIUS = FACE_BOX / 2;
const DEGREE = Math.PI / 180;
const GLANCE_UNITS_TO_VIEW = 0.8;

export interface BodyMotion {
  bob?: [number, number];
  sway?: [number, number];
  pulse?: [number, number];
  circle?: [number, number];
  jitter?: [number, number];
  glance?: [number, number];
  tilt?: number;
  squash?: number;
  enter?: [number, number];
  settle?: number;
}

export const MOTION = {
  sleeping: { pulse: [0.028, 4600], tilt: 2 },
  waking: { enter: [0.92, 700], pulse: [0.03, 2200] },
  idle: { pulse: [0.022, 3800], glance: [6, 4000] },
  listening: { bob: [2, 2600], pulse: [0.012, 2600] },
  thinking: { sway: [1.6, 3000], pulse: [0.01, 3000], glance: [4, 3000] },
  searching: { bob: [3, 1400], sway: [2.2, 1400] },
  working: { bob: [2.5, 900], squash: 0.22 },

  excited: { bob: [9, 520], sway: [3, 1040], squash: 0.35 },
  surprised: { enter: [1.14, 340], jitter: [0.8, 120] },
  suspicious: { sway: [2.4, 2600], tilt: -3 },
  angry: { jitter: [1.3, 95], tilt: 2 },
  drowsy: { pulse: [0.026, 5000], tilt: 3 },
  happy: { bob: [5, 820], squash: 0.28 },
  curious: { sway: [3.4, 1900], tilt: -4, glance: [5, 1900] },
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

/** States that show the bot doing something; every other state holds still unless a caller animates it or the pointer is over it. */
export const ACTIVE_STATES: ReadonlySet<CursorState> = new Set<CursorState>([
  "waking", "listening", "thinking", "searching", "working", "surprised", "celebrate", "orbit", "radar", "progress",
  "spawning", "loading", "dictating", "writing", "sending", "receiving", "uploading", "notifying", "alerting",
  "dragging", "bouncing", "powering-down",
]);

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const keyEase = cubicBezier(0.42, 0, 0.58, 1);
const KEY_EASE_PEAK_SLOPE = 1.73;
const blinkOpen = cubicBezier(0.4, 0.22, 0.28, 1.34);

export const BLINK_MS = 260;
const BLINK_CLOSE_MS = 90;
const BLINK_HOLD_MS = 33;
const BLINK_SHUT = 0.06;

/** Eye height through a blink, 1 open; null once the blink is over. */
export function blinkOpenness(elapsedMs: number): number | null {
  if (elapsedMs >= BLINK_MS) return null;
  if (elapsedMs <= 0) return 1;
  if (elapsedMs < BLINK_CLOSE_MS) return 1 - (1 - BLINK_SHUT) * smoothstep(elapsedMs / BLINK_CLOSE_MS);
  if (elapsedMs < BLINK_CLOSE_MS + BLINK_HOLD_MS) return BLINK_SHUT;
  const opening = (elapsedMs - BLINK_CLOSE_MS - BLINK_HOLD_MS) / (BLINK_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS);
  return BLINK_SHUT + (1 - BLINK_SHUT) * blinkOpen(opening);
}

export const HOVER_BLINK_MS: [number, number] = [3000, 6000];

export const BLEND_OMEGA = 14;

/** A critically damped spring released from x0 with velocity v0 (per second), t seconds later. */
export function criticalSpring(x0: number, v0: number, t: number, omega = BLEND_OMEGA): { x: number; v: number } {
  const decay = Math.exp(-omega * t);
  const b = v0 + omega * x0;
  return { x: (x0 + b * t) * decay, v: (v0 - omega * b * t) * decay };
}

export interface Pose {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  sx: number;
  sy: number;
  fx: number;
}

export const POSE_KEYS = ["x", "y", "rotate", "scale", "sx", "sy", "fx"] as const satisfies ReadonlyArray<keyof Pose>;
const SETTLED: Pose = { x: 0.05, y: 0.05, rotate: 0.02, scale: 3e-4, sx: 3e-4, sy: 3e-4, fx: 0.05 };
export const REST_POSE: Pose = { x: 0, y: 0, rotate: 0, scale: 1, sx: 1, sy: 1, fx: 0 };

type Track = ReadonlyArray<readonly [number, number]>;

const TRACKS: ReadonlyArray<Track> = [
  [[0, 0], [0.22, 1], [0.34, 1], [0.66, -1], [0.78, -1], [1, 0]],
  [[0, 0], [0.2, 0.8], [0.28, 0.8], [0.46, -0.4], [0.56, -0.4], [0.74, 0.6], [0.82, 0.6], [1, 0]],
  [[0, 0], [0.3, 1], [0.42, 1], [0.58, 0.2], [0.68, 0.2], [0.85, -1], [1, 0]],
];

const trackPeak = (track: Track) =>
  Math.max(...track.slice(1).map(([u, v], i) => Math.abs(v - track[i]![1]) / (u - track[i]![0]))) * KEY_EASE_PEAK_SLOPE;
const LOOP_PEAK_RATE = Math.max(...TRACKS.map(trackPeak));

function sampleTrack(track: Track, u: number): number {
  for (let i = 1; i < track.length; i++) {
    const [u1, v1] = track[i]!;
    if (u <= u1) {
      const [u0, v0] = track[i - 1]!;
      return v0 + (v1 - v0) * keyEase((u - u0) / (u1 - u0));
    }
  }
  return 0;
}

/** A per-bot offset into every loop, and which authored variant it plays, so a list of bots never moves in step. */
export interface LoopSeed {
  phase: number;
  variant: number;
}

export function loopSeed(key: string): LoopSeed {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  const unsigned = hash >>> 0;
  return { phase: (unsigned % 10007) / 10007, variant: (unsigned >>> 16) % TRACKS.length };
}

const easeOutBack = (t: number) => {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

export interface PoseOptions {
  seed?: LoopSeed;
  compact?: boolean;
}

export function bodyPose(motion: BodyMotion, elapsed: number, strength: number, options: PoseOptions = {}): Pose {
  const pose = { ...REST_POSE };
  if (strength <= 0) return pose;
  const seed = options.seed ?? { phase: 0, variant: 0 };
  const loop = (period: number, lane: number) => {
    const u = ((elapsed / period + seed.phase + lane * 0.37) % 1 + 1) % 1;
    return sampleTrack(TRACKS[(seed.variant + lane) % TRACKS.length]!, u);
  };
  const tremor = (period: number, phase = 0) => Math.sin((elapsed / period) * Math.PI * 2 + phase);

  pose.rotate = motion.tilt ? motion.tilt * strength : 0;
  if (motion.bob) {
    const [amplitude, period] = motion.bob;
    const p = loop(period, 0);
    pose.y -= amplitude * strength * p;
    if (motion.squash && !options.compact) {
      const amount = motion.squash * strength * Math.max(0, -p);
      pose.sy = 1 - amount * 0.5;
      pose.sx = 1 + amount * 0.5;
    }
  }
  if (motion.circle) {
    const [radius, period] = motion.circle;
    pose.x += radius * strength * Math.sin((elapsed / period + seed.phase) * Math.PI * 2);
    pose.y += radius * strength * Math.cos((elapsed / period + seed.phase) * Math.PI * 2);
  }
  if (motion.sway) pose.rotate += motion.sway[0] * strength * loop(motion.sway[1], 1);
  if (motion.pulse) pose.scale *= 1 + motion.pulse[0] * strength * loop(motion.pulse[1], 2);
  if (motion.glance && !options.compact) pose.fx = motion.glance[0] * strength * loop(motion.glance[1], 1);
  if (motion.jitter) {
    const [amplitude, period] = motion.jitter;
    pose.x += amplitude * strength * tremor(period);
    pose.y += amplitude * strength * tremor(period * 0.63, 1.1);
  }
  if (motion.enter) {
    const [from, duration] = motion.enter;
    const t = elapsed / duration;
    pose.scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0));
  }
  if (motion.settle !== undefined) {
    const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1);
    pose.scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength;
  }
  return pose;
}

export function restPose(motion: BodyMotion, strength: number): Pose {
  const pose = { ...REST_POSE };
  if (strength <= 0) return pose;
  pose.rotate = (motion.tilt ?? 0) * strength;
  if (motion.settle !== undefined) pose.scale = 1 + (motion.settle - 1) * strength;
  return pose;
}

/** `pixel` is one device pixel in viewBox units; the body's offset lands on it so a small mascot stays crisp. */
export function poseTransform(pose: Pose, pixel = 0): string {
  const centre = FACE_BOX / 2;
  const ground = FACE_BOX;
  const snap = (v: number) => (pixel > 0 ? Math.round(v / pixel) * pixel : v);
  const dx = snap(pose.x);
  const dy = snap(pose.y);
  const parts: string[] = [];
  if (Math.abs(dx) >= 0.005 || Math.abs(dy) >= 0.005) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  if (Math.abs(pose.rotate) >= 0.005) parts.push(`rotate(${pose.rotate.toFixed(2)} ${centre} ${centre})`);
  if (Math.abs(pose.scale - 1) >= 0.00005) {
    parts.push(`translate(${centre} ${centre}) scale(${pose.scale.toFixed(4)}) translate(${-centre} ${-centre})`);
  }
  if (Math.abs(pose.sx - 1) >= 0.00005 || Math.abs(pose.sy - 1) >= 0.00005) {
    parts.push(`translate(${centre} ${ground}) scale(${pose.sx.toFixed(4)} ${pose.sy.toFixed(4)}) translate(${-centre} ${-ground})`);
  }
  return parts.join(" ");
}

export function bodyTransform(motion: BodyMotion, elapsed: number, strength: number, options?: PoseOptions): string {
  return poseTransform(bodyPose(motion, elapsed, strength, options));
}

const zeroPose = (): Pose => ({ x: 0, y: 0, rotate: 0, scale: 0, sx: 0, sy: 0, fx: 0 });

/** Blends a pose into whatever it is asked to show next; interrupting a blend starts the next one from where the body is and how fast it moves. */
export class PoseBlend {
  private offset = zeroPose();
  private velocity = zeroPose();
  private since = 0;
  blending = false;

  retarget(now: number, shown: Pose, next: Pose): void {
    const velocity = this.sample(now).velocity;
    for (const key of POSE_KEYS) this.offset[key] = shown[key] - next[key];
    this.velocity = velocity;
    this.since = now;
    this.blending = POSE_KEYS.some((key) => Math.abs(this.offset[key]) >= SETTLED[key] || Math.abs(velocity[key]) >= SETTLED[key] * BLEND_OMEGA);
  }

  apply(now: number, target: Pose): Pose {
    if (!this.blending) return target;
    const { offset } = this.sample(now);
    if (POSE_KEYS.every((key) => Math.abs(offset[key]) < SETTLED[key])) {
      this.blending = false;
      return target;
    }
    const pose = { ...target };
    for (const key of POSE_KEYS) pose[key] += offset[key];
    return pose;
  }

  private sample(now: number): { offset: Pose; velocity: Pose } {
    const offset = zeroPose();
    const velocity = zeroPose();
    if (!this.blending) return { offset, velocity };
    const t = Math.max(0, now - this.since) / 1000;
    for (const key of POSE_KEYS) {
      const spring = criticalSpring(this.offset[key], this.velocity[key], t);
      offset[key] = spring.x;
      velocity[key] = spring.v;
    }
    return { offset, velocity };
  }
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
  hovered?: boolean;
  blending?: boolean;
}

export function frameIntervalFor(pxPerMs: number): number {
  if (!(pxPerMs > 0)) return Infinity;
  for (const ms of FRAME_TIERS_MS) if (pxPerMs * ms <= SMOOTH_STEP_PX) return ms;
  return FULL_FRAME_MS;
}

const SINE_PEAK_RATE = Math.PI * 2;

function loopSpeed(amplitude: number, period: number, px: number, rate = LOOP_PEAK_RATE): number {
  return amplitude * px >= VISIBLE_PX ? (rate * amplitude * px) / period : 0;
}

export function bodyPxPerMs(motion: BodyMotion, strength: number, px: number, compact = false): number {
  if (strength <= 0) return 0;
  let speed = 0;
  if (motion.bob) {
    speed += loopSpeed(motion.bob[0] * strength, motion.bob[1], px);
    if (motion.squash && !compact) speed += loopSpeed(motion.squash * strength * 0.5 * FACE_BOX, motion.bob[1], px);
  }
  if (motion.sway) speed += loopSpeed(motion.sway[0] * strength * DEGREE * BODY_RADIUS, motion.sway[1], px);
  if (motion.pulse) speed += loopSpeed(motion.pulse[0] * strength * BODY_RADIUS, motion.pulse[1], px);
  if (motion.glance && !compact) speed += loopSpeed(motion.glance[0] * strength * GLANCE_UNITS_TO_VIEW, motion.glance[1], px);
  if (motion.circle) speed += loopSpeed(motion.circle[0] * strength, motion.circle[1], px, SINE_PEAK_RATE);
  if (motion.jitter) speed += loopSpeed(motion.jitter[0] * strength, motion.jitter[1] * 0.63, px, SINE_PEAK_RATE);
  return speed;
}

function bodyTransient(motion: BodyMotion, elapsed: number): boolean {
  return Boolean(motion.enter && elapsed < motion.enter[1]) || (motion.settle !== undefined && elapsed < SETTLE_MS);
}

export function nextFrameAt(now: number, interval: number): number {
  if (interval === Infinity) return Infinity;
  return (Math.floor((now + FRAME_SLACK_MS) / interval) + 1) * interval;
}

export function frameFloorMs(sizePx: number, hovered = false): number {
  return sizePx <= SMALL_MASCOT_PX && !hovered ? LIST_FRAME_MS : FULL_FRAME_MS;
}

export function nextMascotFrame(now: number, input: CadenceInput): number {
  return Math.max(smoothFrameAt(now, input), nextFrameAt(now, frameFloorMs(input.sizePx, input.hovered)));
}

function smoothFrameAt(now: number, input: CadenceInput): number {
  const { motion, effects, stateElapsedMs: elapsed, strength } = input;
  const full = nextFrameAt(now, FULL_FRAME_MS);
  if (input.blinkingOrSpinning || input.blending) return full;
  if (strength > 0 && input.showEffects && (effects?.confetti || effects?.trails)) return full;
  if (strength > 0 && bodyTransient(motion, elapsed)) return full;
  const px = input.sizePx / VIEW_SPAN;
  const due = nextFrameAt(now, frameIntervalFor(bodyPxPerMs(motion, strength, px, input.sizePx <= COMPACT_MASCOT_PX) + input.faceUnitsPerMs * px));
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
