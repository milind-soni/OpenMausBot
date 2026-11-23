/**
 * Deterministic pose model. A pose is a pure function of (seed, time, state,
 * mood, gaze, reducedMotion): no wall clock, no Math.random, so any frame can
 * be reproduced exactly (tests, SSR, scrubbing).
 */
import type { AvatarMood, AvatarMotion, AvatarMotionBlend, AvatarState } from './types.ts';

/**
 * How the eyes are drawn, as numbers that blend: any two looks mix into a shape in between, so
 * the eyes morph from one to the other (see eyes.ts).
 */
export interface EyeLook {
  /** 0 = the plain pill, 1 = the happy arc. */
  arc: number;
  /** 0 = the plain pill, 1 = the flat slit of a waiting bot. Never more than `1 - arc`. */
  slit: number;
}

export interface Pose {
  /** View rotation in radians: yaw turns about the vertical axis, pitch about the horizontal. */
  yaw: number;
  pitch: number;
  /** In-plane rotation, degrees. */
  roll: number;
  /** Vertical offset (negative = up), viewBox units. */
  lift: number;
  /** Squash and stretch about the base of the body. */
  sx: number;
  sy: number;
  /** Eye look direction, -1..1 per axis. */
  gazeX: number;
  gazeY: number;
  /** 0 = open, 1 = fully closed. */
  blink: number;
  /** Extra lid narrowing per eye, 0..1. */
  squintL: number;
  squintR: number;
  eyes: EyeLook;
  /** Presence of the ribbons that circle the body: 0..1 draws them out and back in. */
  ribbons: number;
  /** Which layout the ribbons take: 0 a working turn's one hoop, 1 a celebration's cage of three. */
  cage: number;
  /**
   * How far the body's turn has carried the ribbons round, radians, signed and not wrapped: each
   * ribbon goes its own share of it, so a whole turn more does not put them back where they were.
   */
  sweep: number;
  /** How far the body has given way to a mark, 0..1 each: the exclamation mark and the three dots. */
  bang: number;
  dots: number;
}

/** Every state and mood, in the order hosts list them. */
export const STATES: readonly AvatarState[] = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done'];
export const MOODS: readonly AvatarMood[] = ['neutral', 'happy'];

export function isState(value: unknown): value is AvatarState {
  return STATES.includes(value as AvatarState);
}

export function isMood(value: unknown): value is AvatarMood {
  return MOODS.includes(value as AvatarMood);
}

/**
 * The state and mood to show. `motion` is the single option that came before them: `thinking`
 * is a state, `happy` a mood. An explicit `state` or `mood` wins over it.
 */
export function resolveLook(given: { state?: unknown; mood?: unknown; motion?: unknown }): { state: AvatarState; mood: AvatarMood } {
  return {
    state: isState(given.state) ? given.state : given.motion === 'thinking' ? 'thinking' : 'idle',
    mood: isMood(given.mood) ? given.mood : given.motion === 'happy' ? 'happy' : 'neutral',
  };
}

/** Resting view: turned a little and seen a little from above, so the volume reads without dominating. */
export const BASE_YAW = -0.3;
export const BASE_PITCH = 0.2;
/**
 * Following a look target: the body turns toward it by up to these angles
 * (radians, at full deflection) and the eyes use this share of their small
 * range, so the whole character looks rather than the eyes sliding alone.
 */
export const LOOK_YAW = 0.32;
export const LOOK_PITCH = 0.18;
export const LOOK_EYES = 0.7;

const TAU = Math.PI * 2;

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stateless hash noise in [0, 1). */
export function noise(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Blink closure 0..1: one blink per ~4.2 s slot at a seeded offset, sometimes a double blink. */
export function blinkAt(seed: number, t: number): number {
  const SLOT = 4.2, DUR = 0.19;
  const slot = Math.floor(t / SLOT);
  let closure = 0;
  for (const s of [slot - 1, slot]) {
    const start = s * SLOT + 0.5 + noise(seed, s * 2) * 2.9;
    const starts = noise(seed, s * 2 + 1) > 0.8 ? [start, start + 0.34] : [start];
    for (const b of starts) {
      const u = (t - b) / DUR;
      if (u > 0 && u < 1) closure = Math.max(closure, Math.sin(Math.PI * u));
    }
  }
  return closure;
}

/** Idle eye wander: short holds between quick saccades, centered more often than not. */
export function wanderAt(seed: number, t: number): [number, number] {
  const SLOT = 1.9;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => {
    if (noise(seed, 1000 + k * 3) < 0.4) return [0, 0];
    return [(noise(seed, 1001 + k * 3) * 2 - 1) * 0.6, (noise(seed, 1002 + k * 3) * 2 - 1) * 0.35];
  };
  const a = target(s - 1), b = target(s);
  const e = smooth((t - s * SLOT) / 0.16);
  return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
}

/** Working: the eyes dart from one thing to the next, mostly down at the work. */
function dartAt(seed: number, t: number): [number, number] {
  const SLOT = 0.62;
  const s = Math.floor(t / SLOT);
  const target = (k: number): [number, number] => [(noise(seed, 2001 + k * 3) * 2 - 1) * 0.8, 0.1 + noise(seed, 2002 + k * 3) * 0.5];
  const a = target(s - 1), b = target(s);
  const e = smooth((t - s * SLOT) / 0.12);
  return [mix(a[0], b[0], e), mix(a[1], b[1], e)];
}

export interface PoseInput {
  seed: number;
  time: number;
  state?: AvatarState;
  mood?: AvatarMood;
  /** @deprecated Use `state` and `mood`; they win when given. */
  motion?: AvatarMotion;
  /** Seconds since `state` began: `done` celebrates from then on. Without it the state is at rest. */
  stateAge?: number;
  /** Look target, -1..1 per axis (x right, y down); `weight` 0..1 fades it in over the idle pose (default 1). */
  gaze?: { x: number; y: number; weight?: number };
  reducedMotion: boolean;
  /** Extra view rotation in radians (e.g. from drag-to-turn), added to the resting view. */
  view?: { yaw: number; pitch: number };
  /** Easing in from what was shown before (see blendPoses). */
  blend?: AvatarMotionBlend;
}

/**
 * Pose part way from `a` to `b`, both taken at the same moment so either side's motion keeps
 * running. Everything is a number, the eyes' look included, so eyes morph from one shape to the
 * next and a body gives way to a mark (and back) part by part.
 */
export function blendPoses(a: Pose, b: Pose, t: number): Pose {
  const k = clamp(t, 0, 1);
  const m = (x: number, y: number) => mix(x, y, k);
  // The ribbons stay where the side that shows them has carried them: mixing a celebration's many
  // turns with a pose that has none would wind them back round while they fade.
  const sweep = a.ribbons > 0 && b.ribbons > 0 ? m(a.sweep, b.sweep) : a.ribbons > 0 ? a.sweep : b.sweep;
  // Likewise their layout: a celebration fading out keeps its cage.
  const cage = a.ribbons > 0 && b.ribbons > 0 ? m(a.cage, b.cage) : a.ribbons > 0 ? a.cage : b.cage;
  return {
    yaw: m(a.yaw, b.yaw), pitch: m(a.pitch, b.pitch), roll: m(a.roll, b.roll), lift: m(a.lift, b.lift),
    sx: m(a.sx, b.sx), sy: m(a.sy, b.sy), gazeX: m(a.gazeX, b.gazeX), gazeY: m(a.gazeY, b.gazeY),
    blink: m(a.blink, b.blink), squintL: m(a.squintL, b.squintL), squintR: m(a.squintR, b.squintR),
    eyes: { arc: m(a.eyes.arc, b.eyes.arc), slit: m(a.eyes.slit, b.eyes.slit) },
    ribbons: m(a.ribbons, b.ribbons), cage, sweep, bang: m(a.bang, b.bang), dots: m(a.dots, b.dots),
  };
}

export function computePose(input: PoseInput): Pose {
  const pose = statePose(input);
  const blend = input.blend;
  if (!blend || !(blend.t < 1)) return pose;
  const from = typeof blend.from === 'string' ? { motion: blend.from } : blend.from;
  // A change of mood alone keeps the state's clock running on both sides, so a turn under way
  // stays one turn; a state that was left is held at the age it had.
  const stateAge = resolveLook(from).state === resolveLook(input).state ? input.stateAge : from.age;
  const before = computePose({ ...input, state: from.state, mood: from.mood, motion: from.motion, stateAge, blend: from.blend });
  return blendPoses(before, pose, Number.isFinite(blend.t) ? blend.t : 1);
}

/**
 * Done celebrates in cycles, timed from a reference animation: the ribbons go round
 * DONE_SWEEPS times while the body turns DONE_SWEEPS / 3 times (see celebration), then they draw
 * back in and the bot rests. DONE_TURN_S covers the turn and the drawing in. A cycle lasts
 * DONE_CYCLE_S or up to a seventh longer, differently for each avatar, so several done bots on a
 * page drift apart instead of turning together.
 */
export const DONE_TURN_S = 3.87;
export const DONE_CYCLE_S = 6.2;
const DONE_SWEEPS = 9;
/**
 * How long the ribbons take to draw back in, seconds: they start once the turn has slowed below
 * about 0.9 rad/s, 3.37 s in, and are gone at DONE_TURN_S.
 */
const DONE_DRAW_IN_S = 0.5;

/**
 * A working bot gets on with it and every so often throws itself into the work: a band of
 * ribbons sweeps once round it, easing in like a spring settling, then draws back in. The first comes WORK_FIRST_S
 * (plus up to WORK_FIRST_JITTER_S) after the state begins, then one every WORK_GAP_S, each up to
 * WORK_JITTER_S late, so several working bots do not turn together. A turn takes WORK_TURN_S.
 */
const WORK_FIRST_S = 1.2;
const WORK_FIRST_JITTER_S = 1.2;
const WORK_GAP_S = 7.5;
const WORK_JITTER_S = 1.5;
const WORK_TURN_S = 1.5;
/** How quickly a working turn eases in to its full circle, per second: a critically damped spring's rate. */
const WORK_EASE = 6.2;

/**
 * Where a working bot is in its turns `age` seconds into the state: how far into the current
 * turn (seconds), or null between turns.
 */
function workTurn(seed: number, age: number): number | null {
  const first = WORK_FIRST_S + WORK_FIRST_JITTER_S * noise(seed, 41);
  if (age < first) return null;
  const n = Math.floor((age - first) / WORK_GAP_S);
  // A turn may start up to WORK_JITTER_S late, so the one before may still be running.
  for (const k of [n, n - 1]) {
    if (k < 0) continue;
    const start = first + k * WORK_GAP_S + (k ? WORK_JITTER_S * noise(seed, 60 + k) : 0);
    if (age >= start && age < start + WORK_TURN_S) return age - start;
  }
  return null;
}

/** An angle as the nearest way round to it, -π..π, so a blend never unwinds whole turns. */
const near = (angle: number) => angle - TAU * Math.round(angle / TAU);

/**
 * How far a celebration's ribbons have gone round `t` seconds in, radians, on the reference curve: half
 * a radian of wind-up the other way over 0.24 s, a speed-up to a steady run, then from 2.54 s a
 * slow-down that lands, at 3.79 s, on DONE_SWEEPS whole turns.
 */
const CELEBRATION_END_S = 3.79;
const CELEBRATION_SPEED = (DONE_SWEEPS * TAU + 0.5) / 2.4625;
function celebration(t: number): number {
  const v = CELEBRATION_SPEED;
  if (t <= 0) return 0;
  if (t < 0.24) return -0.25 * (1 - Math.cos((Math.PI * t) / 0.24));
  if (t < 0.54) return -0.5 + (v * (t - 0.24) ** 2) / 0.6;
  if (t < 2.54) return -0.5 + v * (t - 0.39);
  if (t < CELEBRATION_END_S) return -0.5 + v * 2.15 + (1.25 * v * (1 - (1 - (t - 2.54) / 1.25) ** 4)) / 4;
  return DONE_SWEEPS * TAU;
}

function statePose(input: PoseInput): Pose {
  const { seed, time, gaze, reducedMotion, view } = input;
  const { state, mood } = resolveLook(input);
  // Per-avatar phase offset so several avatars on a page do not move in lockstep.
  const t = reducedMotion ? 0 : time + noise(seed, 7) * 10;
  const live = reducedMotion ? 0 : 1;
  const wave = (period: number, phase = 0) => (reducedMotion ? 0 : Math.sin((TAU * t) / period + phase));
  const given = gaze && Number.isFinite(gaze.x) && Number.isFinite(gaze.y)
    ? [clamp(gaze.x, -1, 1), clamp(gaze.y, -1, 1)] as [number, number]
    : null;
  const weight = given ? (Number.isFinite(gaze?.weight) ? clamp(gaze?.weight as number, 0, 1) : 1) : 0;
  // While it attends to a target the body holds its aim: idle sway of the turn settles to a trace.
  const sway = 1 - 0.7 * weight;

  const pose: Pose = {
    yaw: BASE_YAW, pitch: BASE_PITCH, roll: 0, lift: 0, sx: 1, sy: 1,
    gazeX: 0, gazeY: 0, blink: 0, squintL: 0, squintR: 0,
    eyes: { arc: mood === 'happy' ? 1 : 0, slit: 0 }, ribbons: 0, cage: 0, sweep: 0, bang: 0, dots: 0,
  };
  /** The calm pose of a bot with nothing to do: it breathes, sways, blinks and looks around. */
  const rest = (pace: number) => {
    pose.yaw += 0.07 * sway * wave(6.1 * pace);
    pose.pitch += 0.04 * sway * wave(4.7 * pace, 1);
    pose.roll = 1.6 * wave(5.3 * pace, 2);
    pose.lift = reducedMotion ? 0 : -0.45 * (1 - Math.cos((TAU * t) / (3.4 * pace)));
    const breath = wave(3.4 * pace, -Math.PI / 2);
    pose.sy = 1 + 0.012 * breath;
    pose.sx = 1 - 0.008 * breath;
    if (!reducedMotion) {
      pose.blink = blinkAt(seed, t);
      [pose.gazeX, pose.gazeY] = wanderAt(seed, t);
    }
  };

  if (state === 'idle' && mood === 'happy') {
    // With nothing to do, a happy bot hops.
    const period = 0.92;
    const p = reducedMotion ? 0.5 : ((t % period) + period) % period / period;
    const air = 4 * p * (1 - p);
    const land = reducedMotion ? 0 : clamp(1 - Math.min(p, 1 - p) / 0.12, 0, 1);
    pose.lift = reducedMotion ? 0 : -3.2 * air;
    pose.sy = 1 - 0.09 * land + 0.03 * air * live;
    pose.sx = 1 + 0.07 * land - 0.015 * air * live;
    pose.roll = 4.5 * wave(period * 2);
    pose.yaw += 0.1 * wave(period * 2, 0.6);
  } else if (state === 'thinking') {
    // Looks up and away while it gives way to the three dots.
    pose.yaw += 0.12 + 0.05 * sway * wave(7.3);
    pose.pitch += 0.08;
    pose.roll = -5 + 1.4 * wave(4.1);
    pose.lift = -0.5 * (1 - Math.cos((TAU * t) / 5.2)) * live;
    pose.gazeX = 0.55 + 0.3 * wave(5.6);
    pose.gazeY = -0.8;
    pose.squintL = 0.22;
    pose.squintR = 0.32 + 0.1 * wave(3.1);
    if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.7);
    pose.dots = 1;
  } else if (state === 'working') {
    // Bent over the work and busy: a quick steady bob and eyes darting across it, and every so
    // often a turn with a band of ribbons sweeping round it.
    const beat = wave(0.7);
    pose.yaw += 0.08 * sway * wave(2.3, 0.4);
    pose.pitch -= 0.05;
    pose.roll = 3 + 0.6 * beat;
    pose.lift = -0.3 * (0.5 + 0.5 * beat) * live;
    pose.sy = 0.99 - 0.008 * beat;
    pose.sx = 1.005 + 0.005 * beat;
    pose.squintL = 0.25;
    pose.squintR = 0.25;
    if (reducedMotion) {
      pose.gazeX = 0.15;
      pose.gazeY = 0.3;
    } else {
      [pose.gazeX, pose.gazeY] = dartAt(seed, t);
      pose.blink = blinkAt(seed, t * 1.3);
    }
    // Counted from when the state began; without an age, from the clock.
    const age = Number.isFinite(input.stateAge) ? Math.max(0, input.stateAge as number) : Math.max(0, time);
    const into = reducedMotion ? null : workTurn(seed, age);
    if (into !== null) {
      // A full circle that eases in like a spring settling. The band rides it round, out at the
      // start and back in at the end; the body keeps facing the work, leaning into the sweep, and
      // the eyes follow the band across.
      const e = WORK_EASE * into;
      const turn = TAU * (1 - (1 + e) * Math.exp(-e));
      const swell = Math.sin(turn / 2);
      pose.ribbons = clamp(into / 0.16, 0, 1) * clamp((WORK_TURN_S - into) / 0.5, 0, 1);
      pose.sweep = turn;
      pose.yaw += 0.22 * swell;
      pose.roll += 3 * swell;
      pose.lift -= 1.2 * swell;
      pose.gazeX = clamp(pose.gazeX * (1 - swell) - 0.85 * Math.sin(turn), -1, 1);
      pose.gazeY = pose.gazeY * (1 - swell) - 0.3 * swell;
    }
  } else if (state === 'waiting') {
    // Leans to one side, eyes flattened to slits, glancing off at whatever it is waiting on.
    // Now and then it sighs. A happy bot keeps its arcs.
    const p = reducedMotion ? 0 : ((t % 6.5) + 6.5) % 6.5 / 6.5;
    // One breath in and out over the first third of the cycle.
    const sigh = Math.sin(TAU * clamp(p / 0.33, 0, 1));
    pose.yaw += 0.04 * sway * wave(7.4);
    pose.pitch += 0.02 + 0.03 * sigh;
    pose.roll = 7 + 1.2 * wave(6.4, 2);
    pose.lift = -0.3 * (1 - Math.cos((TAU * t) / 6.5)) * live;
    pose.sy = 1 + 0.025 * sigh;
    pose.sx = 1 - 0.012 * sigh;
    pose.gazeX = 0.5 + 0.15 * wave(8.2);
    pose.gazeY = 0.1;
    pose.eyes.slit = 1 - pose.eyes.arc;
    if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.6);
  } else if (state === 'blocked') {
    // Stops still while it gives way to the exclamation mark.
    pose.sy = 1.02;
    pose.sx = 0.99;
    pose.bang = 1;
  } else if (state === 'done') {
    // Celebrates: a few turns with ribbons flying round it, then a rest, content and a little
    // slower than idle, and after a while again, the other way round.
    rest(1.25);
    // Counted from when the state began. Without an age it is at rest.
    const age = !reducedMotion && Number.isFinite(input.stateAge) ? Math.max(0, input.stateAge as number) : DONE_TURN_S;
    const length = DONE_CYCLE_S * (1 + 0.15 * noise(seed, 31));
    const cycle = Math.floor(age / length), since = age - cycle * length;
    if (since < DONE_TURN_S) {
      const swell = Math.sin((Math.PI * since) / DONE_TURN_S);
      const way = cycle % 2 ? -1 : 1;
      const sweep = celebration(since) * way;
      // The body turns a third as often as the ribbons go round.
      pose.yaw += near(sweep / 3);
      pose.lift -= 2.2 * swell;
      pose.sy += 0.04 * swell;
      // All the ribbons out at full strength while the turn is quick, drawn back in as it settles.
      pose.ribbons = clamp(since / 0.1, 0, 1) * clamp((DONE_TURN_S - since) / DONE_DRAW_IN_S, 0, 1);
      pose.cage = 1;
      // The ribbons only set off once the turn goes forward: the wind-up does not carry them.
      pose.sweep = way * Math.max(0, celebration(since));
    }
  } else {
    rest(1);
  }

  if (given && weight > 0) {
    // A look target wins over idle wander. The body turns to face it: the resting
    // three-quarter turn gives way (so a target on either side turns the front that
    // way) and the eyes add a modest share on top. Reduced motion keeps the body
    // still, so the eyes alone use their full (still small) range. Happy arcs stay put.
    const share = reducedMotion ? 1 : LOOK_EYES;
    const follow = weight * (1 - pose.eyes.arc);
    pose.gazeX = mix(pose.gazeX, given[0] * share, follow);
    pose.gazeY = mix(pose.gazeY, given[1] * share, follow);
    if (!reducedMotion) {
      // Positive yaw turns the front to the right, positive pitch tips it up.
      pose.yaw += weight * (given[0] * LOOK_YAW - BASE_YAW);
      pose.pitch += weight * (-given[1] * LOOK_PITCH - BASE_PITCH / 2);
    }
  }
  if (view && Number.isFinite(view.yaw) && Number.isFinite(view.pitch)) {
    pose.yaw += view.yaw;
    pose.pitch += view.pitch;
  }
  return pose;
}
