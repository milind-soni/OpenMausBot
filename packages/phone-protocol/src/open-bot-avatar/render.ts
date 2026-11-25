/**
 * Renderers for a validated silhouette + eye placement with implied volume
 * (see volume.ts). One flat body color, two plain dark eyes; no gradients,
 * gloss, rim light or shadows. Output is built only from numbers and the
 * renderer's own markup.
 *
 * - avatarFrame: one frame flattened to plain data (paths, matrices, eyes),
 *   for any vector renderer.
 * - renderAvatarSvg: a standalone still, serialized from avatarFrame. Cross-sections of the stack that
 *   faces the viewer are projected orthographically and painted back to front.
 * - renderAvatarScene + sceneFrame: a CSS 3D scene. Every cross-section is its
 *   own small SVG placed once with a 3D transform; animating, turning and
 *   recoloring only change a few CSS transforms, and the browser's compositor
 *   does projection and occlusion. Each visible slice costs a compositor layer,
 *   so mountAvatar paints live avatars to one canvas by default and only uses
 *   the scene with `renderer: 'scene'`.
 *
 * A state can draw more than the body (see effects.ts): ribbons behind and in front of it, and
 * the marks a thinking or blocked bot turns into. Those stay where they are while the body hops
 * and rolls.
 */
import { mix, parseHex, toHex } from './color.ts';
import type { Rgb } from './color.ts';
import { bodyScale, markParts, ribbonPieces, ribbonReach, rimOf } from './effects.ts';
import type { Rim } from './effects.ts';
import type { Box } from './effects.ts';
import { eyePath, plainLook } from './eyes.ts';
import type { EyeSpot } from './eyes.ts';
import { computePose, hashString, noise } from './motion.ts';
import type { EyeLook, Pose } from './motion.ts';
import type { Bounds, Point } from './path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC, analyzeBody, eyeCenters, gazeRange, validateAvatar } from './validate.ts';
import type { GazeRange } from './validate.ts';
import { buildVolume } from './volume.ts';
import type { EyePlane, Vec3, Volume, VolumeSlice } from './volume.ts';
import type { AvatarDefinition, RenderOptions } from './types.ts';

export const DEFAULT_COLOR = '#ff6a1a';
export const DEFAULT_EYE_COLOR = '#151515';
/** `depth` option value that maps to the natural inferred volume. */
export const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 14;
/**
 * CSS eyes sit this far above the surface so they never touch the body planes. iOS WebKit treats planes
 * closer than about a pixel as one and may draw the body over an eye (0.3 did: a band of the
 * barbell's bar through one eye), so the gap is a few pixels at the stage's size. Turned, an eye
 * drifts lift × sin(angle) from its spot: under half a unit at rest, about one at 45°.
 */
const CSS_EYE_LIFT = 1.5;

interface Prepared {
  def: AvatarDefinition;
  vol: Volume;
  range: GazeRange;
  seed: number;
  /** Prefix for SVG ids; equal geometry and depth always give equal ids, so repeats on a page are safe. */
  id: string;
  /** Stable SVG id per distinct cross-section path, assigned once. */
  ids: Map<string, string>;
  /** Slices kept at a rendered size, per stack, keyed by stack and rounded size. */
  detail: Map<string, boolean[]>;
  /** Where the ribbons' hoops are centred and how far the body reaches from there (see ribbonRims). */
  rims: () => { work: Rim; cage: Rim };
}

const cache = new Map<string, Prepared>();

const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function depthOption(options: RenderOptions): number {
  const d = clamp(Number.isFinite(options.depth) ? (options.depth as number) : DEFAULT_DEPTH, 0, MAX_DEPTH);
  return Math.round(d * 2) / 2;
}

const lazy = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

/**
 * How far the body reaches from the middle of its box, for a working turn's hoop and for a
 * celebration's cage. The hoops' centre hops and stretches with the body (see ribbonsFollow) but
 * does not lean or sway with it, so each is measured over the leans its state takes, the body
 * stretched about the centre: a working bot leans 2.4° to 6.6° and squashes to 98%; a celebrating
 * one sways ±1.7° and stretches up to 5.5%. The hoops stand just outside that, so the body never
 * moves through a point where a ribbon passes behind it.
 */
export function ribbonRims(polys: Point[][], b: Bounds): { work: Rim; cage: Rim } {
  const [cx, cy] = pivotOf(b);
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  /** The body leaned by each of `rolls` (degrees, about its base) and stretched by each of `sys` about the centre. */
  const posed = (rolls: number[], sys: number[]) => {
    const out: Point[][][] = [];
    for (const roll of rolls) {
      const r = (roll * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
      for (const k of sys) {
        out.push(polys.map((poly) => poly.map(([x, y]): Point => {
          const lx = bx + c * (x - bx) - sn * (y - by), ly = by + sn * (x - bx) + c * (y - by);
          return [cx + 1.01 * (lx - cx), cy + k * (ly - cy)];
        })));
      }
    }
    return out;
  };
  return { work: rimOf(posed([2.4, 4.5, 6.6], [0.98, 1]), cx, cy), cage: rimOf(posed([-1.7, 0, 1.7], [0.99, 1.055]), cx, cy) };
}

/**
 * The rim moved to where the hoops' centre is in this pose: it hops and stretches with the body
 * (the root motion's lift and scale about the base) but does not lean or sway with it.
 */
export function ribbonsFollow(rim: Rim, pose: Pick<Pose, 'lift' | 'sx' | 'sy'>, b: Bounds): Rim {
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  return { ...rim, cx: bx + pose.sx * (rim.cx - bx), cy: by + pose.sy * (rim.cy - by) + pose.lift };
}

function prepare(definition: AvatarDefinition, depth: number): Prepared {
  const key = JSON.stringify([definition?.id, definition?.name, definition?.body?.path, definition?.eyes, depth]);
  const hit = cache.get(key);
  if (hit) return hit;
  const res = validateAvatar(definition);
  if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join('; ')}`);
  const def = res.value;
  const body = analyzeBody(def.body.path);
  const vol = buildVolume(def, depth / DEFAULT_DEPTH, body);
  const id = `oba-${hashString(`${def.id}|${def.body.path}|${depth}`).toString(36)}`;
  const ids = new Map<string, string>();
  for (const part of vol.parts) for (const s of [...part.zSlices, ...part.xSlices]) if (!ids.has(s.d)) ids.set(s.d, `${id}-${ids.size}`);
  const prepared: Prepared = {
    def,
    vol,
    range: gazeRange(body.polys, { ...def.eyes, scale: vol.eyeScale }),
    seed: hashString(def.id),
    id,
    ids,
    detail: new Map(),
    rims: lazy(() => ribbonRims(body.polys, vol.bounds)),
  };
  if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, prepared);
  return prepared;
}

/** The validated definition and its cached volume, exactly as the renderers use them. Throws if invalid. */
export function preparedVolume(definition: AvatarDefinition, depth?: number): { def: AvatarDefinition; vol: Volume } {
  const p = prepare(definition, depthOption({ depth }));
  return { def: p.def, vol: p.vol };
}

function poseOf(p: Prepared, options: RenderOptions): Pose {
  return computePose({
    seed: p.seed,
    time: Number.isFinite(options.time) ? (options.time as number) : 0,
    state: options.state,
    mood: options.mood,
    motion: options.motion,
    stateAge: options.stateAge,
    gaze: options.gaze,
    reducedMotion: options.reducedMotion === true,
    view: options.view,
    blend: options.motionBlend,
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// View math

type M = Matrix;
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const about = (x: number, y: number, m: M): M => mul(translate(x, y), mul(m, translate(-x, -y)));
const invert = ([a, b, c, d, e, g]: M): M => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det];
};
const mat = (m: M) => `matrix(${m.map((v, i) => (i < 4 ? (Math.round(v * 10000) / 10000).toString() : f(v))).join(' ')})`;

export interface ViewBasis {
  cY: number;
  sY: number;
  cP: number;
  sP: number;
  /** cos(yaw)·cos(pitch): > 0 when the front faces the viewer. */
  facing: number;
}

export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const cY = Math.cos(yaw), cP = Math.cos(pitch);
  return { cY, sY: Math.sin(yaw), cP, sP: Math.sin(pitch), facing: cY * cP };
}

/** Toward-viewer component of a model-space direction under this view (1 = straight at the viewer). */
export function facingOf(v: ViewBasis, [x, y, z]: Vec3): number {
  return v.sP * y + v.cP * (-v.sY * x + v.cY * z);
}

/** The signed projected area of a unit of eye plane goes to zero at the limb. */
function eyeVisible(v: ViewBasis, plane: EyePlane): boolean {
  return facingOf(v, [-plane.dzdx, -plane.dzdy, 1]) > 1e-6;
}

function eyeMatrix(v: ViewBasis, { x, y, z, dzdx, dzdy }: EyePlane, pivot: Point): M {
  const m = planeMatrix(v, z - x * dzdx - y * dzdy, pivot);
  m[0] += v.sY * dzdx;
  m[1] -= v.cY * v.sP * dzdx;
  m[2] += v.sY * dzdy;
  m[3] -= v.cY * v.sP * dzdy;
  return m;
}

/** Which slice stack faces the viewer more: front-facing z-planes or side-facing x-planes. */
export function activeStack(v: ViewBasis): 'z' | 'x' {
  return Math.abs(v.cY) >= Math.abs(v.sY) ? 'z' : 'x';
}

/**
 * Orthographic projection of the plane at depth z, pivoting on `pivot` at z = 0.
 * Yaw turns about the vertical axis, then pitch tips about the horizontal axis.
 */
export function planeMatrix(v: ViewBasis, z: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [
    v.cY, v.sY * v.sP, 0, v.cP,
    cx - v.cY * cx + v.sY * z,
    cy - v.cP * cy - v.sY * v.sP * cx - v.cY * v.sP * z,
  ];
}

/** Projection of the side plane x = x0, whose local coordinates are (u = -z, y). */
export function sidePlaneMatrix(v: ViewBasis, x0: number, pivot: Point): M {
  const [cx, cy] = pivot;
  return [-v.sY, v.cY * v.sP, 0, v.cP, cx + v.cY * (x0 - cx), cy - v.cP * cy + v.sY * v.sP * (x0 - cx)];
}

/** Project a 3D point: screen x, screen y and depth toward the viewer. */
export function projectPoint(v: ViewBasis, [x, y, z]: Vec3, pivot: Point): Vec3 {
  const m = planeMatrix(v, z, pivot);
  const X = x - pivot[0], Y = y - pivot[1];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], v.sP * Y + v.cP * (-v.sY * X + v.cY * z)];
}

function rootMatrix(pose: Pose, b: Bounds): M {
  const bx = (b.minX + b.maxX) / 2, by = b.maxY;
  const r = (pose.roll * Math.PI) / 180;
  const rot: M = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  return mul(translate(0, pose.lift), about(bx, by, mul(rot, [pose.sx, 0, 0, pose.sy, 0, 0])));
}

const pivotOf = (b: Bounds): Point => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** The hop and the share of a point's distance from the base that roll and squash can move it. */
const POSE_LIFT = 4;
const POSE_SWAY = 0.2;

/**
 * A square of viewBox units that holds the avatar at every view and pose. Throws if invalid. The
 * canvas renderer uses it only as an upper bound: it sizes each bitmap to what is actually painted.
 */
export function avatarExtent(definition: AvatarDefinition, depth?: number): { x: number; y: number; size: number } {
  const p = prepare(definition, depthOption({ depth }));
  const { vol } = p;
  const b = vol.bounds;
  const [cx, cy] = pivotOf(b);
  const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, Math.max(...vol.parts.map((part) => part.depth)) + 2 * CSS_EYE_LIFT) / 2;
  // Ribbons reach their hoop plus their band from the middle of the body's box, and keep the
  // canvas's antialiasing margin (FIT_PAD) inside.
  const { work, cage } = p.rims();
  // The hoops' centre also hops and stretches with the body: as far as the body's own pose moves it.
  const reach = (rim: Rim) => {
    const r = ribbonReach(rim.max);
    return Math.hypot(rim.cx - cx, rim.cy - cy) + POSE_LIFT + POSE_SWAY * Math.abs(b.maxY - rim.cy) + r.radius + r.band + 1.2;
  };
  const half = Math.max(radius + POSE_LIFT + POSE_SWAY * (radius + b.maxY - cy), reach(work), reach(cage));
  return { x: cx - half, y: cy - half, size: 2 * half };
}

/**
 * Every cross-section a view draws, with its projection: the stack facing the
 * viewer, minus z-slices hidden behind the core (they add nothing to the
 * silhouette or the paint). Their union is the silhouette on screen.
 */
function drawnSlices(p: Prepared, v: ViewBasis, size: number | undefined, visit: (s: VolumeSlice, m: M, part: number, index: number) => void) {
  const { vol } = p;
  const stack = activeStack(v);
  const pivot = pivotOf(vol.bounds);
  const drawn = sliceCull(v);
  const kept = sliceDetail(p, stack, size);
  let k = 0;
  vol.parts.forEach((part, i) => {
    (stack === 'z' ? part.zSlices : part.xSlices).forEach((s, j) => {
      if (!kept[k++] || !drawn(s)) return;
      visit(s, stack === 'z' ? planeMatrix(v, s.at, pivot) : sidePlaneMatrix(v, s.at, pivot), i, j);
    });
  });
}

/** Whether a slice of the active stack shows: z-slices hidden behind the core are skipped. */
function sliceCull(v: ViewBasis): (s: VolumeSlice) => boolean {
  // Screen shift per unit of depth, and the smallest on-screen size of an in-plane inset.
  const sweep = Math.hypot(v.sY, v.cY * v.sP);
  const inset = Math.min(Math.abs(v.cY), Math.abs(v.cP));
  return (s) => s.axis !== 'z' || s.inset <= 0 || Math.abs(s.at) * sweep > s.inset * inset;
}

// ---------------------------------------------------------------------------
// Eyes (shared by both renderers, in face-plane coordinates)

interface EyeState {
  /** Neutral center and size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Gaze offset. */
  dx: number;
  dy: number;
  /** Drawn pill height after blink/squint, and its downward shift (lids close toward a point below center). */
  open: number;
  shift: number;
  look: EyeLook;
  /** The plain pill or the plain happy arc, drawn as such; null for every other look (a path). */
  plain: 'pill' | 'arc' | null;
}

function eyeStates(p: Prepared, pose: Pose): [EyeState, EyeState] {
  const s = p.vol.eyeScale;
  const w = EYE_W * s, h = EYE_H * s;
  const r = p.range;
  const dx = pose.gazeX * (pose.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
  const dy = pose.gazeY * (pose.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
  const centers = eyeCenters(p.def.eyes);
  const plain = plainLook(pose.eyes);
  return ([0, 1] as const).map((i) => {
    const squint = i === 0 ? pose.squintL : pose.squintR;
    const open = Math.max(h * Math.max(0.09, (1 - pose.blink) * (1 - squint * 0.4)), w * 0.55);
    return { x: centers[i][0], y: centers[i][1], w, h, dx, dy, open, shift: (h - open) * 0.18, look: pose.eyes, plain };
  }) as [EyeState, EyeState];
}

/** Where an eye is drawn: with its gaze offset, or without it where a transform applies the gaze. */
function eyeSpot(e: EyeState, gaze: boolean): EyeSpot {
  return { x: e.x + (gaze ? e.dx : 0), y: e.y + (gaze ? e.dy : 0), w: e.w, h: e.h, open: e.open, shift: e.shift };
}

function happyArc(e: EyeState): string {
  const ex = e.x + e.dx, ey = e.y + e.dy;
  const hw = e.w * HAPPY_ARC.halfWidth, base = ey + e.h * HAPPY_ARC.base;
  return `M${f(ex - hw)} ${f(base)}Q${f(ex)} ${f(ey - e.h * HAPPY_ARC.peak)} ${f(ex + hw)} ${f(base)}`;
}

function eyeMark(e: EyeState): EyeMark {
  if (e.plain === 'arc') return { shape: 'arc', d: happyArc(e), strokeWidth: e.w * HAPPY_ARC.stroke };
  if (e.plain === null) return { shape: 'path', d: eyePath(e.look, eyeSpot(e, true)) };
  const cx = e.x + e.dx, cy = e.y + e.dy + e.shift;
  return { shape: 'pill', x: cx - e.w / 2, y: cy - e.open / 2, width: e.w, height: e.open, radius: Math.min(e.w, e.open) / 2 };
}

/**
 * MausBot: a smile under the eyes, stroked like the happy arc. It follows the gaze with the eyes,
 * deepens as the eyes turn happy and flattens as they turn to a waiting slit.
 */
function mouthMark([a, b]: [EyeState, EyeState]): EyeMark {
  const x = (a.x + b.x) / 2 + a.dx, y = a.y + a.h * 0.62 + a.dy;
  const hw = Math.max((b.x - a.x) * 0.3, a.w * 0.7);
  const happy = clamp(a.look.arc, 0, 1), flat = clamp(a.look.slit, 0, 1);
  const depth = hw * (0.42 + 0.38 * happy) * (1 - 0.8 * flat);
  return { shape: 'arc', d: `M${f(x - hw)} ${f(y)}Q${f(x)} ${f(y + 2 * depth)} ${f(x + hw)} ${f(y)}`, strokeWidth: a.w * 0.55 };
}

function colors(options: RenderOptions): { color: string; ink: string } {
  return {
    color: toHex(parseHex(options.color) ?? (parseHex(DEFAULT_COLOR) as Rgb)),
    ink: toHex(parseHex(options.eyeColor) ?? (parseHex(DEFAULT_EYE_COLOR) as Rgb)),
  };
}

// ---------------------------------------------------------------------------
// Flat frames: the whole projected avatar as plain data

/** 2D affine matrix in SVG order (a b c d e f). */
export type Matrix = [number, number, number, number, number, number];

/**
 * How one eye is drawn, in its face plane's coordinates (viewBox units): the plain pill, the
 * plain happy arc (stroked, round caps), or for every other look a filled outline (a waiting
 * bot's slits, and every shape on the way from one look to the next).
 */
export type EyeMark =
  | { shape: 'pill'; x: number; y: number; width: number; height: number; radius: number }
  | { shape: 'arc'; d: string; strokeWidth: number }
  | { shape: 'path'; d: string };

export type FrameShape =
  | {
      kind: 'slice';
      /** Stable across frames for the same cross-section: use it as a key in retained renderers. */
      key: string;
      /** Id of an entry in AvatarFrame.paths. */
      path: string;
      matrix: Matrix;
    }
  | { kind: 'eye'; key: 'eye-0' | 'eye-1' | 'mouth'; matrix: Matrix; mark: EyeMark }
  | {
      /**
       * A piece of a ribbon: fill `d` in `fill`. Each ribbon has a hue of its own, set apart from
       * the body's; a piece `front` of the body is lighter than one behind it.
       */
      kind: 'ribbon';
      key: string;
      d: string;
      box: { x: number; y: number; w: number; h: number };
      matrix: Matrix;
      front: boolean;
      /** The ribbon's colour where it is plainest (the middle of its gradient). */
      fill: string;
      /**
       * A linear gradient along the whole ribbon, in the same coordinates as `d`: from its tail
       * (x1, y1) to its head (x2, y2), the stops evenly spaced. Every piece of a ribbon shares it.
       */
      gradient: { x1: number; y1: number; x2: number; y2: number; stops: string[] };
    };

/** One cross-section outline, shared by every shape that draws it. */
export interface FramePath {
  id: string;
  d: string;
  evenOdd: boolean;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * One frame of the avatar flattened onto the screen: every cross-section the
 * view draws with its projection, and the visible eyes, sorted back to front,
 * between the ribbons behind the body and those in front of it. The marks of
 * `thinking` and `blocked` are listed as slices too, in place of the body.
 * Painting them in order (body paths in `color`, eyes in `ink`) inside the
 * `root` transform and a 0 0 100 100 viewBox gives the avatar exactly as
 * renderAvatarSvg draws it. Plain numbers and path strings, so any vector
 * renderer (SVG, canvas, Skia, react-native-svg) can draw it.
 */
export interface AvatarFrame {
  name: string;
  color: string;
  ink: string;
  /**
   * Distinct cross-section paths this frame uses; ids are stable for equal geometry and depth.
   * `box` bounds `d` in its own coordinates, before a shape's matrix.
   */
  paths: FramePath[];
  /** 2D motion (hop, roll, squash) about the base of the body, applied to every shape. */
  root: Matrix;
  /** Back to front. */
  shapes: FrameShape[];
  /**
   * The body as one surface, for a renderer that draws it in 3D instead of as slices (the fluffy
   * material): the view's rotation, the body's scale as it gives way to a mark, and both eyes,
   * including an eye `shapes` leaves out because its spot faces away.
   */
  surface: { view: ViewBasis; scale: number; eyes: SurfaceEye[] };
}

/**
 * An eye on the body's surface, in face coordinates: its mark where it rests, and how far its
 * gaze has moved it from there. Apart, so a renderer can tell a moving eye from a changing one.
 */
export interface SurfaceEye {
  mark: EyeMark;
  dx: number;
  dy: number;
}

/** Compute one flat frame of a definition. Throws if the definition is invalid. */
export function avatarFrame(definition: AvatarDefinition, options: RenderOptions = {}): AvatarFrame {
  return flatFrame(definition, options, undefined);
}

/**
 * avatarFrame for a live avatar drawn `options.size` CSS pixels wide: like the scene, it skips
 * cross-sections that would sit less than a pixel apart. Internal to the live renderers, so
 * `size` never changes what avatarFrame returns to custom renderers.
 */
export function liveFrame(definition: AvatarDefinition, options: RenderOptions = {}): AvatarFrame {
  return flatFrame(definition, options, options.size);
}

/** The colour `t` (0..1) of the way along a colour run, in sRGB between its stops. */
function runAt(run: Rgb[], t: number): string {
  const x = clamp(t, 0, 1) * (run.length - 1), n = Math.min(Math.floor(x), run.length - 2);
  return toHex(mix(run[n], run[n + 1], x - n));
}

/** MausBot: every ribbon takes one of our comet palettes (three neighbouring hues head to tail), whatever the body's colour. */
const COMET_COLORS: Rgb[][] = [
  ['#A855F7', '#6366F1', '#38BDF8'], ['#22D3EE', '#34D399', '#A3E635'], ['#FB923C', '#F43F5E', '#D946EF'],
  ['#818CF8', '#C084FC', '#F472B6'], ['#FACC15', '#FB923C', '#EC4899'], ['#34D399', '#22D3EE', '#60A5FA'],
].map((run) => run.map((hex) => parseHex(hex) as Rgb));

function cometPalette(seed: number): Rgb[][] {
  const turn = Math.floor(noise(seed, 500) * COMET_COLORS.length);
  return Array.from({ length: 9 }, (_, i) => COMET_COLORS[(i + turn) % COMET_COLORS.length]);
}

/** What a frame draws besides the body, in viewBox units outside the body's own motion. */
interface Effects {
  /** How much of its size the body keeps while it gives way to a mark (0 = gone). */
  body: number;
  ribbons: { d: string; box: Box; front: boolean; fill: string; gradient: RibbonGradient }[];
  marks: { id: string; d: string; box: Box; matrix: M }[];
}

function effectsOf(p: Prepared, pose: Pose, options: RenderOptions): Effects {
  const b = p.vol.bounds;
  const time = Number.isFinite(options.time) ? (options.time as number) : 0;
  const still = options.reducedMotion === true;
  const [cx, cy] = pivotOf(b);
  return {
    body: bodyScale(pose.bang, pose.dots),
    // No ribbons are out below a presence of 0.01 (see ribbonPieces), so their rims are not measured for it.
    ribbons: still || pose.ribbons <= 0.01 ? [] : ribbonPieces(b, pose.ribbons, p.seed, time, pose.sweep, pose.cage, ribbonsFollow(pose.cage >= 0.5 ? p.rims().cage : p.rims().work, pose, b)).map((r) => {
      const hue = cometPalette(p.seed)[r.ribbon % 9];
      // The piece's stretch of its ribbon's colour run, front and back alike.
      const [s0, s1] = r.along;
      const stops = [s0, (s0 + s1) / 2, s1].map((t) => runAt(hue, t));
      // A gradient needs some length; a piece too short to have one takes its middle colour.
      const long = Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]) > 0.01;
      return {
        d: r.d, box: r.box, front: r.front, fill: stops[1],
        gradient: long ? { x1: r.from[0], y1: r.from[1], x2: r.to[0], y2: r.to[1], stops } : { x1: r.from[0], y1: r.from[1], x2: r.from[0] + 0.01, y2: r.from[1], stops: [stops[1], stops[1], stops[1]] },
      };
    }),
    marks: markParts(b, pose.bang, pose.dots, p.seed, time, still).map((part) => {
      const turn: M = [Math.cos(part.turn), Math.sin(part.turn), -Math.sin(part.turn), Math.cos(part.turn), 0, 0];
      return {
        id: `${p.id}-${part.shape}`,
        d: part.d,
        box: part.box,
        matrix: mul(about(cx, cy, turn), mul(translate(part.x, part.y), [part.scale, 0, 0, part.scale, 0, 0])),
      };
    }),
  };
}

function flatFrame(definition: AvatarDefinition, options: RenderOptions, size: number | undefined): AvatarFrame {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const b = vol.bounds;
  const { color, ink } = colors(options);
  const pose = poseOf(p, options);
  const pivot = pivotOf(b);
  const v = viewBasis(pose.yaw, pose.pitch);
  const stack = activeStack(v);
  const eyes: SurfaceEye[] = [];
  const fx = effectsOf(p, pose, options);
  const root = rootMatrix(pose, b);
  // The body shrinks toward its center as it gives way to a mark.
  const shrink = (m: M): M => (fx.body < 1 ? mul(about(pivot[0], pivot[1], [fx.body, 0, 0, fx.body, 0, 0]), m) : m);

  // Only the cross-sections this view draws are listed; ids are stable across frames.
  const paths = new Map<string, FramePath>();
  const items: { depth: number; shape: FrameShape }[] = [];
  if (fx.body > 0) {
    drawnSlices(p, v, size, (s, m, i, j) => {
      let path = paths.get(s.d);
      if (!path) {
        path = { id: p.ids.get(s.d) as string, d: s.d, evenOdd: s.evenOdd, box: { ...s.box } };
        paths.set(s.d, path);
      }
      // Parallel slices have the same order along every viewing ray.
      const depth = stack === 'z' ? v.facing * s.at : -v.sY * v.cP * s.at;
      items.push({ depth, shape: { kind: 'slice', key: `${i}${stack}${j}`, path: path.id, matrix: shrink(m) } });
    });
    // Painted on the surface; each eye goes once the surface under it turns away.
    const states = eyeStates(p, pose);
    states.forEach((e, idx) => {
      const plane = vol.eyePlanes[idx];
      eyes.push({ mark: eyeMark({ ...e, dx: 0, dy: 0 }), dx: e.dx, dy: e.dy });
      if (!eyeVisible(v, plane)) return;
      // A slice through the middle of a mark must paint before the entire mark: sort at the near
      // edge of its footprint on the active stack.
      const halfW = e.w * (e.plain === 'pill' ? 0.5 : HAPPY_ARC.halfWidth + 0.5 * HAPPY_ARC.stroke);
      const xDepth = -v.sY * v.cP;
      const z = plane.z + e.dx * plane.dzdx + e.dy * plane.dzdy;
      const depth = stack === 'z'
        ? v.facing * z + Math.abs(v.facing) * (Math.abs(plane.dzdx) * halfW + (Math.abs(plane.dzdy) * e.h) / 2)
        : xDepth * (e.x + e.dx) + Math.abs(xDepth) * halfW;
      items.push({
        depth: depth + 1e-6,
        shape: { kind: 'eye', key: idx === 0 ? 'eye-0' : 'eye-1', matrix: shrink(eyeMatrix(v, plane, pivot)), mark: eyeMark(e) },
      });
    });
    // MausBot: the mouth sits on the plane midway between the eye planes and shows while both eyes
    // do. It paints over every slice, as on a fluffy coat: below the eyes the face can stand
    // proud of the eyes' plane, and its slices would cut through the mouth.
    const [pa, pb] = vol.eyePlanes;
    if (eyeVisible(v, pa) && eyeVisible(v, pb)) {
      const plane = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2, dzdx: (pa.dzdx + pb.dzdx) / 2, dzdy: (pa.dzdy + pb.dzdy) / 2 };
      items.push({ depth: Infinity, shape: { kind: 'eye', key: 'mouth', matrix: shrink(eyeMatrix(v, plane, pivot)), mark: mouthMark(states) } });
    }
    items.sort((a, c) => a.depth - c.depth);
  }

  // Ribbons and marks stay put while the body moves: their matrices undo the root's motion.
  const fixed = fx.ribbons.length || fx.marks.length ? invert(root) : null;
  const ribbon = (front: boolean): FrameShape[] =>
    fx.ribbons.flatMap((r, i) =>
      r.front === front ? [{ kind: 'ribbon' as const, key: `ribbon-${i}`, d: r.d, box: r.box, matrix: fixed as M, front, fill: r.fill, gradient: r.gradient }] : [],
    );
  const marks = fx.marks.map((mark, i): FrameShape => {
    if (!paths.has(mark.id)) paths.set(mark.id, { id: mark.id, d: mark.d, evenOdd: false, box: mark.box });
    return { kind: 'slice', key: `mark-${i}`, path: mark.id, matrix: mul(fixed as M, mark.matrix) };
  });
  return {
    name: p.def.name, color, ink, paths: [...paths.values()], root,
    shapes: [...ribbon(false), ...items.map((it) => it.shape), ...ribbon(true), ...marks],
    surface: { view: v, scale: fx.body, eyes },
  };
}

// ---------------------------------------------------------------------------
// Standalone SVG still

function eyeSvg(mark: EyeMark, ink: string): string {
  if (mark.shape === 'path') return `<path d="${mark.d}" fill="${ink}"/>`;
  if (mark.shape === 'arc') {
    return `<path d="${mark.d}" fill="none" stroke="${ink}" stroke-width="${f(mark.strokeWidth)}" stroke-linecap="round"/>`;
  }
  return `<rect x="${f(mark.x)}" y="${f(mark.y)}" width="${f(mark.width)}" height="${f(mark.height)}" rx="${f(mark.radius)}" fill="${ink}"/>`;
}

type RibbonGradient = { x1: number; y1: number; x2: number; y2: number; stops: string[] };

/**
 * A ribbon piece with its gradient alongside it. The id is taken from the gradient itself, so
 * repeats on a page (the same avatar at the same moment) share one harmlessly.
 */
function ribbonSvg(d: string, g: RibbonGradient): string {
  const id = `oba-g${hashString(`${f(g.x1)},${f(g.y1)},${f(g.x2)},${f(g.y2)},${g.stops.join()}`).toString(36)}`;
  const stops = g.stops.map((c, i) => `<stop offset="${f(i / (g.stops.length - 1))}" stop-color="${c}"/>`).join('');
  return (
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}">${stops}</linearGradient>` +
    `<path d="${d}" fill="url(#${id})"/>`
  );
}

/** Render a definition to a standalone SVG string. Throws if the definition is invalid. */
export function renderAvatarSvg(definition: AvatarDefinition, options: RenderOptions = {}): string {
  const frame = avatarFrame(definition, options);
  const defsMarkup = frame.paths.map((d) => `<path id="${d.id}" d="${d.d}"${d.evenOdd ? ' fill-rule="evenodd"' : ''}/>`).join('');
  const body = frame.shapes
    .map((s) =>
      s.kind === 'slice' ? `<use href="#${s.path}" transform="${mat(s.matrix)}"/>`
      : s.kind === 'eye' ? `<g transform="${mat(s.matrix)}">${eyeSvg(s.mark, frame.ink)}</g>`
      : `<g transform="${mat(s.matrix)}">${ribbonSvg(s.d, s.gradient)}</g>`,
    )
    .join('');
  const size = Number.isFinite(options.size) && (options.size as number) > 0 ? f(clamp(options.size as number, 8, 4096)) : null;
  const dims = size ? ` width="${size}" height="${size}"` : '';
  const label = esc(frame.name);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims} role="img" aria-label="${label}" overflow="visible">` +
    `<title>${label}</title>` +
    `<defs>${defsMarkup}</defs>` +
    `<g transform="${mat(frame.root)}" fill="${frame.color}">` +
    body +
    `</g></svg>`
  );
}

// ---------------------------------------------------------------------------
// Live CSS 3D scene

/** 1 viewBox unit = 1% of the scene's (square) container width. */
const u = (n: number) => `${f(n)}cqw`;
const eyePlaneCss = ({ z, dzdx, dzdy }: EyePlane) =>
  `translateZ(${u(z + CSS_EYE_LIFT)}) matrix3d(1,0,${r4(dzdx)},0,0,1,${r4(dzdy)},0,0,0,1,0,0,0,0,1)`;
const FILL = 'position:absolute;left:0;top:0;width:100%;height:100%;';

function sliceMarkup(s: VolumeSlice): string {
  const pad = 0.3;
  const x = s.box.x - pad, y = s.box.y - pad, w = s.box.w + 2 * pad, h = s.box.h + 2 * pad;
  const rule = s.evenOdd ? ' fill-rule="evenodd"' : '';
  const place = s.axis === 'z'
    ? `left:${u(x)};top:${u(y)};transform:translateZ(${u(s.at)})`
    : // The side plane's u = 0 line sits at x = s.at; turning it 90° about that line maps u to -z.
      `left:${u(s.at + x)};top:${u(y)};transform-origin:${u(-x)} 50%;transform:rotateY(90deg)`;
  return (
    `<svg viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="position:absolute;width:${u(w)};height:${u(h)};overflow:visible;${place}" aria-hidden="true">` +
    `<path d="${s.d}"${rule} fill="currentColor"/></svg>`
  );
}

const overlay = (side: 'back' | 'front') =>
  `<svg data-fx="${side}" viewBox="0 0 100 100" style="${FILL}overflow:visible;pointer-events:none" fill="currentColor" aria-hidden="true"></svg>`;

/**
 * Static markup of the live scene for a definition and depth. Mount it once,
 * then apply `sceneFrame` every frame. Body color comes from CSS `color` on
 * an ancestor, eye ink from `--avatar-ink`.
 */
export function renderAvatarScene(definition: AvatarDefinition, options: Pick<RenderOptions, 'depth'> = {}): string {
  const p = prepare(definition, depthOption(options));
  const { vol } = p;
  const b = vol.bounds;
  const [cx, cy] = pivotOf(b);
  const ink = `var(--avatar-ink,${DEFAULT_EYE_COLOR})`;
  const stack = (axis: 'z' | 'x') =>
    `<div data-stack="${axis}" style="${FILL}transform-style:preserve-3d">` +
    vol.parts.map((part) => (axis === 'z' ? part.zSlices : part.xSlices).map(sliceMarkup).join('')).join('') +
    `</div>`;
  const eyes = eyeStates(p, poseOf(p, { reducedMotion: true })).map((e, i) => {
    const box = `left:${u(e.x - e.w / 2)};top:${u(e.y - e.h / 2)};width:${u(e.w)};height:${u(e.h)}`;
    return (
      `<div data-eye="${i}" style="position:absolute;${box};backface-visibility:hidden;transform:${eyePlaneCss(vol.eyePlanes[i])}">` +
      `<i style="position:absolute;inset:0;border-radius:999px;background:${ink}"></i>` +
      `<svg viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true">` +
      `<path d="${happyArc(e)}" fill="none" stroke="${ink}" stroke-width="${f(e.w * HAPPY_ARC.stroke)}" stroke-linecap="round"/></svg>` +
      // Every look between the pill and the arc: its outline is written each frame it changes.
      `<svg data-morph viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true">` +
      `<path fill="${ink}"/></svg>` +
      `</div>`
    );
  });
  return (
    `<div data-avatar-scene="${p.id}" style="position:relative;width:100%;height:100%;container-type:size">` +
    // Ribbons behind the body; they and the marks are written each frame they show.
    overlay('back') +
    // will-change pins the slices' raster scale: without it every hop and squash re-rasterizes each slice.
    `<div data-motion style="${FILL}will-change:transform;transform-origin:${u((b.minX + b.maxX) / 2)} ${u(b.maxY)}">` +
    `<div data-view style="${FILL}transform-style:preserve-3d;transform-origin:${u(cx)} ${u(cy)}">` +
    stack('z') + stack('x') + eyes.join('') +
    `</div></div>` +
    overlay('front') +
    `</div>`
  );
}

export interface SceneFrame {
  /** Identifies the static markup this frame belongs to. */
  scene: string;
  /** 2D motion (hop, roll, squash) about the base of the body. */
  motion: string;
  /** 3D view rotation about the body center, scaled down while the body gives way to a mark. */
  view: string;
  /** How much of its size the body keeps, 0..1; at 0 the view needs no layers. */
  body: number;
  /** Markup for the scene's two overlays (`data-fx`): ribbons behind the body; ribbons and marks in front. */
  back: string;
  front: string;
  stack: 'z' | 'x';
  /** Per slice of the active stack, in markup order: whether it shows. Hidden ones need no layer. */
  slices: boolean[];
  /** `d` is set while the eye is between the pill and the arc: it then shows the `data-morph` path alone. */
  eyes: { visible: boolean; happy: boolean; transform: string; pill: string; d: string }[];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Closest on-screen spacing, CSS px, between cross-sections a small live avatar keeps. */
const SLICE_GAP_PX = 0.75;

/**
 * Per slice of a stack, in markup order: whether it is kept at this rendered size. Within each part,
 * slices closer than SLICE_GAP_PX to the last kept one are dropped; the outermost always stay, and
 * so does the core, which sliceCull relies on to cover the inset slices it hides.
 */
function sliceDetail(p: Prepared, stack: 'z' | 'x', size: number | undefined): boolean[] {
  const px = Number.isFinite(size) && (size as number) > 0 ? Math.round(size as number) : 0;
  const key = `${stack}${px}`;
  let keep = p.detail.get(key);
  if (keep) return keep;
  const gap = px ? (SLICE_GAP_PX * 100) / px : 0;
  keep = p.vol.parts.flatMap((part) => {
    const slices = stack === 'z' ? part.zSlices : part.xSlices;
    let last = -Infinity;
    return slices.map((s, j) => {
      const core = s.axis === 'z' && s.at === 0 && s.inset === 0;
      const kept = core || j === 0 || j === slices.length - 1 || s.at - last >= gap;
      if (kept) last = s.at;
      return kept;
    });
  });
  if (p.detail.size >= 32) p.detail.clear();
  p.detail.set(key, keep);
  return keep;
}

/** Per-frame CSS for a mounted scene. Pure and cheap: no geometry is rebuilt. */
export function sceneFrame(definition: AvatarDefinition, options: RenderOptions = {}): SceneFrame {
  const p = prepare(definition, depthOption(options));
  const pose = poseOf(p, options);
  const v = viewBasis(pose.yaw, pose.pitch);
  const states = eyeStates(p, pose);
  const stack = activeStack(v);
  const drawn = sliceCull(v);
  const kept = sliceDetail(p, stack, options.size);
  const fx = effectsOf(p, pose, options);
  const piece = (front: boolean) => fx.ribbons.filter((r) => r.front === front).map((r) => ribbonSvg(r.d, r.gradient)).join('');
  let k = 0;
  return {
    scene: p.id,
    motion: `translate(0,${u(pose.lift)}) rotate(${f(pose.roll)}deg) scale(${r4(pose.sx)},${r4(pose.sy)})`,
    view: (fx.body < 1 ? `scale(${r4(fx.body)}) ` : '') + `rotateX(${r4(pose.pitch)}rad) rotateY(${r4(pose.yaw)}rad)`,
    body: fx.body,
    back: piece(false),
    front: piece(true) + fx.marks.map((mark) => `<path d="${mark.d}" transform="${mat(mark.matrix)}"/>`).join(''),
    stack,
    slices: p.vol.parts.flatMap((part) => (stack === 'z' ? part.zSlices : part.xSlices).map((s) => kept[k++] && drawn(s))),
    eyes: states.map((e, i) => ({
      visible: eyeVisible(v, p.vol.eyePlanes[i]),
      happy: e.plain === 'arc',
      transform: `${eyePlaneCss(p.vol.eyePlanes[i])} translate(${u(e.dx)},${u(e.dy)})`,
      pill: `translateY(${u(e.shift)}) scaleY(${r4(e.open / e.h)})`,
      d: e.plain === null ? eyePath(e.look, eyeSpot(e, false)) : '',
    })),
  };
}
