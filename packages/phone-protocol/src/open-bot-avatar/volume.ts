/**
 * Implied volume for a flat silhouette.
 *
 * The definition stays a 2D path. Here every filled subpath becomes a "part"
 * with a front-surface height field h(x, y) (the back mirrors it about z = 0):
 *
 * - inflate: a rounded slab. Height follows an elliptical edge fillet of the
 *   distance to the outline, so sides curve and the face is flat.
 * - revolve-y: a solid of revolution about the part's vertical center line
 *   (mug body, pot, bulb), taken from exact scanline widths.
 * - revolve-x: a solid of revolution about a horizontal axis shared by the
 *   whole body (barbell: bar → cylinder, plates → discs).
 *
 * From the height field the part is cut, once, into two stacks of plain
 * cross-section paths: z-slices (planes facing the viewer, level sets of h)
 * and x-slices (planes facing sideways, column profiles of h). Rendered in a
 * single flat color, the union of a stack is the silhouette of the solid;
 * the renderer shows whichever stack faces the viewer more, so no plane is
 * ever seen edge-on. Everything here is pure and cached by the renderer.
 */
import { contourLoops, loopsToPath, simplifyLoop } from './contour.ts';
import { bounds, insideRow, isInside } from './path.ts';
import type { Bounds, Point } from './path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, analyzeBody, drawnEyesFit, eyeCenters, eyeClearance, gazeRange } from './validate.ts';
import type { BodyAnalysis, GazeRange } from './validate.ts';
import type { AvatarDefinition, AvatarEyes } from './types.ts';

export type PartKind = 'inflate' | 'revolve-x' | 'revolve-y';

export interface VolumeSlice {
  /** 'z': the plane z = at, path in (x, y). 'x': the plane x = at, path in (u = -z, y). */
  axis: 'z' | 'x';
  at: number;
  d: string;
  /** The same cross-section as polygons in its plane's coordinates (`d` is a rounded serialization of them). */
  loops: Point[][];
  /** Contour paths use evenodd; the core slice reuses the original nonzero outline. */
  evenOdd: boolean;
  /** Path bounds in its plane's coordinates. */
  box: { x: number; y: number; w: number; h: number };
  /** z-slices: smallest distance from this cross-section to the outline (0 for the core and walls). */
  inset: number;
}

export interface VolumePart {
  kind: PartKind;
  /** Outline plus the holes that cut it, serialized. */
  d: string;
  polys: Point[][];
  bounds: Bounds;
  center: Point;
  /** Twice the largest inscribed radius (inflate) or the largest diameter (revolved). */
  thickness: number;
  /** Front-to-back extent, centered on z = 0. */
  depth: number;
  /** Inflate only: elliptical edge fillet radii (in-plane and in depth). */
  rxy: number;
  rz: number;
  /** Revolved parts: the axis (y for revolve-x, x for revolve-y). */
  axis?: number;
  zSlices: VolumeSlice[];
  xSlices: VolumeSlice[];
  /** Front surface height at a point, 0 outside the part. */
  height: (x: number, y: number) => number;
}

export interface Volume {
  parts: VolumePart[];
  bounds: Bounds;
  /** Index of the part carrying the eyes. */
  eyePart: number;
  /** Depth of each eye's plane: the highest surface under the eye and its gaze travel. */
  eyeZ: [number, number];
  /** Drawn eye scale: the definition's scale enlarged as far as the body allows (see EYE_BOOST). */
  eyeScale: number;
  /**
   * Host surface normals under each eye (left edge, center, right edge). On a
   * curved host an eye is hidden once any of them turns away, so a flat eye
   * never hangs past the curved silhouette.
   */
  eyeNormals: [Vec3[], Vec3[]];
}

export type Vec3 = [number, number, number];

/** Largest depth an inflated part may take, viewBox units. */
export const MAX_PART_DEPTH = 30;
/** Drawn eyes are up to this much larger than the contract's 4 × 11 pill when the body has room. */
export const EYE_BOOST = 1.45;
/**
 * Gap every drawn eye shape (pill and happy arc) keeps from the outline at rest
 * before the renderer enlarges it, viewBox units. Below this the eyes stay at
 * the definition's own scale.
 */
export const EYE_BOOST_PAD = 3;
/**
 * Design target for generated avatars: the enlarged eyes keep this much
 * clearance at rest, which also leaves full gaze travel with EYE_CLEARANCE.
 * Advisory (validate.sh --strict); v1 imports below it still render.
 */
export const FACE_ROOM_TARGET = 4.5;
const MAX_X_SLICES = 40;
/**
 * Thin regions get refinement slices (see thinBoxes): where no inscribed circle
 * within THIN_REACH units has a radius of THIN or more. A thin, deep protrusion
 * seen at an angle shifts more between neighboring slices than it is wide, so
 * without them it fans out into separate copies.
 */
const THIN = 4;
const THIN_REACH = 5;
/** How far a refinement box reaches past its thin region into the body, units. */
const THIN_MARGIN = 2;
/** Depth spacing of refinement slices, units. */
const FINE_Z = 0.6;

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(segDist2(px, py, ax, ay, bx, by));
}

/** Distance from a point to the nearest edge of the polygons. */
export function edgeDistance(polys: Point[][], x: number, y: number): number {
  let best = Infinity;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const d = segDist(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Inward distance to the outline, or 0 outside the fill. */
export function insideDistance(polys: Point[][], x: number, y: number): number {
  return isInside(polys, x, y) ? edgeDistance(polys, x, y) : 0;
}

/** Outline erosion of an inflated part at depth z (elliptical fillet). */
export function erosionAt(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, z: number): number {
  const half = part.depth / 2;
  if (part.rz <= 0) return 0;
  const u = (Math.abs(z) - (half - part.rz)) / part.rz;
  if (u <= 0) return 0;
  return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, u) ** 2)));
}

/** How far inside the outline an inflated part's surface reaches `level` (inverse of surfaceZ). */
export function insetAt(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, level: number): number {
  const half = part.depth / 2;
  if (part.rxy <= 0 || part.rz <= 0 || level <= half - part.rz) return 0;
  if (level >= half) return part.rxy;
  const s = (level - (half - part.rz)) / part.rz;
  return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
}

/** Front surface depth of an inflated part at a point `dist` units inside the outline. */
export function surfaceZ(part: Pick<VolumePart, 'depth' | 'rxy' | 'rz'>, dist: number): number {
  const half = part.depth / 2;
  if (part.rxy <= 0 || dist >= part.rxy) return half;
  const k = 1 - Math.max(0, dist) / part.rxy;
  return half - part.rz + Math.sqrt(Math.max(0, 1 - k * k)) * part.rz;
}

/**
 * Depth heuristic for inflated parts: as deep as the part is thick, but tall
 * slender parts get up to 2.4x their thickness so they read as discs.
 */
export function partDepth(thickness: number, b: Bounds, volume: number): number {
  const long = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const raw = 0.8 * Math.max(thickness, Math.min(0.4 * long, 2.4 * thickness));
  return Math.min(MAX_PART_DEPTH, Math.max(3, raw)) * volume;
}

/** Sorted crossings of the line (y = s if `rows`, else x = s) with the polygons. */
function crossings(polys: Point[][], rows: boolean, s: number): number[] {
  const out: number[] = [];
  const a = rows ? 1 : 0, b = rows ? 0 : 1;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[j], q = poly[i];
      if ((p[a] <= s && q[a] > s) || (q[a] <= s && p[a] > s)) out.push(p[b] + ((s - p[a]) * (q[b] - p[b])) / (q[a] - p[a]));
    }
  }
  return out.sort((m, n) => m - n);
}

interface Profile { start: number; step: number; r: Float64Array }

/**
 * Half-widths about `center` along rows (or columns) if every line crosses the
 * part as one interval centered on it; otherwise null (not a solid of revolution).
 */
function revolveProfile(polys: Point[][], rows: boolean, lo: number, hi: number, center: number): Profile | null {
  const step = 0.2;
  const n = Math.max(2, Math.ceil((hi - lo) / step) + 1);
  const r = new Float64Array(n);
  let span = 0;
  const mids: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = Math.min(hi - 0.01, Math.max(lo + 0.01, lo + k * step));
    const xs = crossings(polys, rows, s);
    if (xs.length === 0) continue;
    if (xs.length !== 2) return null;
    r[k] = (xs[1] - xs[0]) / 2;
    span = Math.max(span, xs[1] - xs[0]);
    mids.push((xs[0] + xs[1]) / 2);
  }
  const tol = Math.max(0.8, 0.04 * span);
  if (!mids.length || mids.some((m) => Math.abs(m - center) > tol)) return null;
  return { start: lo, step, r };
}

function radiusAt(p: Profile, s: number): number {
  const t = (s - p.start) / p.step;
  if (t < 0 || t > p.r.length - 1) return 0;
  const k = Math.min(p.r.length - 2, Math.floor(t));
  return p.r[k] + (p.r[k + 1] - p.r[k]) * (t - k);
}

/**
 * Horizontal axis of revolution, if the body looks like a turned object seen
 * from the side: at least two parts, wider than tall, mirror-symmetric about
 * y = axis and with every part centered on it.
 */
export function revolveAxis(body: BodyAnalysis): number | null {
  const b = body.bounds;
  const outlines = body.subpaths.filter((s) => !s.hole);
  if (outlines.length < 2 || b.maxX - b.minX < 1.1 * (b.maxY - b.minY)) return null;
  const axis = (b.minY + b.maxY) / 2;
  for (const o of outlines) {
    const ob = bounds(o.polys);
    if (Math.abs((ob.minY + ob.maxY) / 2 - axis) > 1.5) return null;
  }
  let filled = 0, off = 0;
  const xs: number[] = [];
  for (let x = b.minX + 0.5; x < b.maxX; x += 1) xs.push(x);
  const top = new Uint8Array(xs.length), bottom = new Uint8Array(xs.length);
  for (let y = b.minY + 0.5; y < axis; y += 1) {
    insideRow(body.polys, y, xs, top);
    insideRow(body.polys, 2 * axis - y, xs, bottom);
    for (let k = 0; k < xs.length; k++) {
      if (top[k] || bottom[k]) filled++;
      if (top[k] !== bottom[k]) off++;
    }
  }
  return filled > 0 && off / filled < 0.02 ? axis : null;
}

/** Sampled signed distance (positive inside) and height over a part's bounds. */
interface Grid { x0: number; y0: number; step: number; nx: number; ny: number; sd: Float64Array; h: Float64Array }

/** Edges bucketed on a coarse grid, for nearest-edge queries that only visit nearby buckets. */
class EdgeIndex {
  private readonly cell = 6;
  private readonly buckets = new Map<number, number[]>();
  private readonly e: number[] = [];
  private readonly ox: number;
  private readonly oy: number;
  private readonly span: number;

  constructor(polys: Point[][], b: Bounds) {
    this.ox = b.minX - 4; this.oy = b.minY - 4;
    this.span = Math.ceil((Math.max(b.maxX - b.minX, b.maxY - b.minY) + 8) / this.cell) + 1;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const k = this.e.length;
        this.e.push(poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
        const [x0, x1] = [Math.min(poly[j][0], poly[i][0]), Math.max(poly[j][0], poly[i][0])];
        const [y0, y1] = [Math.min(poly[j][1], poly[i][1]), Math.max(poly[j][1], poly[i][1])];
        for (let cy = this.cy(y0); cy <= this.cy(y1); cy++) {
          for (let cx = this.cx(x0); cx <= this.cx(x1); cx++) {
            const key = cy * this.span + cx;
            (this.buckets.get(key) ?? this.buckets.set(key, []).get(key)!).push(k);
          }
        }
      }
    }
  }

  private cx(x: number) { return Math.max(0, Math.min(this.span - 1, Math.floor((x - this.ox) / this.cell))); }
  private cy(y: number) { return Math.max(0, Math.min(this.span - 1, Math.floor((y - this.oy) / this.cell))); }

  /** Distance to the nearest edge, searching rings of buckets outward until no closer edge can exist. */
  distance(x: number, y: number): number {
    const bx = this.cx(x), by = this.cy(y);
    let best = Infinity;
    const e = this.e;
    for (let r = 0; r < this.span; r++) {
      for (let cy = by - r; cy <= by + r; cy++) {
        if (cy < 0 || cy >= this.span) continue;
        const edgeRow = cy === by - r || cy === by + r;
        for (let cx = bx - r; cx <= bx + r; cx += edgeRow ? 1 : 2 * r || 1) {
          if (cx < 0 || cx >= this.span) continue;
          const list = this.buckets.get(cy * this.span + cx);
          if (!list) continue;
          for (const k of list) {
            const d = segDist2(x, y, e[k], e[k + 1], e[k + 2], e[k + 3]);
            if (d < best) best = d;
          }
        }
      }
      // Every bucket outside ring r is at least r cells away (best is squared).
      if (best <= (r * this.cell) ** 2) break;
    }
    return Math.sqrt(best);
  }
}

function sampleGrid(polys: Point[][], b: Bounds, step: number, height: (x: number, y: number, sd: number) => number): Grid {
  const pad = 1;
  const x0 = b.minX - pad, y0 = b.minY - pad;
  const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / step) + 1;
  const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / step) + 1;
  const sd = new Float64Array(nx * ny), h = new Float64Array(nx * ny);
  const index = new EdgeIndex(polys, b);
  const xs = Array.from({ length: nx }, (_, i) => x0 + i * step);
  const inside = new Uint8Array(nx);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * step;
    insideRow(polys, y, xs, inside);
    for (let i = 0; i < nx; i++) {
      const d = index.distance(xs[i], y);
      sd[j * nx + i] = inside[i] ? d : -d;
      h[j * nx + i] = inside[i] ? height(xs[i], y, d) : 0;
    }
  }
  return { x0, y0, step, nx, ny, sd, h };
}

function loopBox(loops: Point[][]): VolumeSlice['box'] {
  const b = bounds(loops);
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** A rectangle of grid samples, inclusive. */
interface CellBox { i0: number; i1: number; j0: number; j1: number }

/** A thin region's box, and the highest surface over the thin samples themselves. */
interface ThinBox extends CellBox { top: number }

/**
 * A part's cross-section at `level` as a field that is positive inside it, zero on its edge and
 * roughly a distance in viewBox units: smooth across the rim, so contours interpolated between grid
 * samples follow the real edge instead of the grid. (Height itself is steep at the rim and zero
 * outside, and contouring it left the outline faceted and stair-stepped.)
 */
type LevelField = (x: number, y: number, sd: number, level: number) => number;

/** Cross-section at `level` clipped to the outline (and to `box`, if given), as loops. */
function levelLoops(g: Grid, level: number, field: LevelField, box?: CellBox): Point[][] {
  // A box is contoured on its own samples plus one ring outside it, where the clip is negative.
  const i0 = box ? Math.max(0, box.i0 - 1) : 0, i1 = box ? Math.min(g.nx - 1, box.i1 + 1) : g.nx - 1;
  const j0 = box ? Math.max(0, box.j0 - 1) : 0, j1 = box ? Math.min(g.ny - 1, box.j1 + 1) : g.ny - 1;
  const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
  const values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j + j0) * g.nx + i + i0;
      const sd = g.sd[k];
      // Both terms are continuous across the outline, so the min is too.
      let v = Math.min(field(g.x0 + (i + i0) * g.step, g.y0 + (j + j0) * g.step, sd, level), sd);
      if (box) v = Math.min(v, g.step * Math.min(i + i0 - box.i0, box.i1 - i - i0, j + j0 - box.j0, box.j1 - j - j0));
      values[j * nx + i] = v;
    }
  }
  return contourLoops({ values, nx, ny, x0: g.x0 + i0 * g.step, y0: g.y0 + j0 * g.step, step: g.step }, 0)
    .map((l) => simplifyLoop(l, 0.04))
    .filter((l) => l.length >= 3);
}

/**
 * Boxes around the thin parts of a part's outline, grown by THIN_MARGIN and
 * merged where they overlap, in grid samples. Thin means the widest inscribed
 * circle within THIN_REACH has a radius under THIN (a speech bubble's tail, a
 * leaf, a handle ring).
 */
function thinBoxes(g: Grid): ThinBox[] {
  const { nx, ny } = g;
  const reach = Math.ceil(THIN_REACH / g.step);
  // Largest inward distance within `reach` samples (a square window, rows then columns).
  const rows = new Float64Array(nx * ny), widest = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let m = 0;
      for (let k = Math.max(0, i - reach), e = Math.min(nx - 1, i + reach); k <= e; k++) m = Math.max(m, g.sd[j * nx + k]);
      rows[j * nx + i] = m;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      let m = 0;
      for (let k = Math.max(0, j - reach), e = Math.min(ny - 1, j + reach); k <= e; k++) m = Math.max(m, rows[k * nx + i]);
      widest[j * nx + i] = m;
    }
  }
  const thin = (k: number) => g.sd[k] > 0 && widest[k] < THIN;
  const seen = new Uint8Array(nx * ny);
  const grow = Math.ceil(THIN_MARGIN / g.step);
  const boxes: ThinBox[] = [];
  for (let start = 0; start < nx * ny; start++) {
    if (seen[start] || !thin(start)) continue;
    const box = { i0: nx, i1: -1, j0: ny, j1: -1, top: 0 };
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % nx, j = (k - i) / nx;
      cells++;
      box.top = Math.max(box.top, g.h[k]);
      box.i0 = Math.min(box.i0, i); box.i1 = Math.max(box.i1, i);
      box.j0 = Math.min(box.j0, j); box.j1 = Math.max(box.j1, j);
      for (const n of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
        if (n >= 0 && !seen[n] && thin(n)) { seen[n] = 1; stack.push(n); }
      }
    }
    // Specks are not worth a slice.
    if (cells * g.step * g.step < 2) continue;
    boxes.push({
      i0: Math.max(0, box.i0 - grow), i1: Math.min(nx - 1, box.i1 + grow),
      j0: Math.max(0, box.j0 - grow), j1: Math.min(ny - 1, box.j1 + grow), top: box.top,
    });
  }
  // Overlapping boxes become one, so no cross-section is drawn twice.
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b];
      if (p.i0 > q.i1 || q.i0 > p.i1 || p.j0 > q.j1 || q.j0 > p.j1) continue;
      boxes[a] = { i0: Math.min(p.i0, q.i0), i1: Math.max(p.i1, q.i1), j0: Math.min(p.j0, q.j0), j1: Math.max(p.j1, q.j1), top: Math.max(p.top, q.top) };
      boxes.splice(b, 1);
      b = a;
    }
  }
  return boxes;
}

/**
 * Side profile for the slab of grid columns c0..c1, drawn as the plane at its
 * column `at`: loops in (u = -z, y), symmetric in u. Each row takes the largest
 * height across the slab, so a stack of these seen side-on adds up to the
 * solid's side silhouette instead of one tooth per column where the outline
 * slopes. Where a row run meets the outline the profile ends at the surface
 * height right there (`edgeHeight`: the wall of an inflated part, the rim of a
 * revolved one), not at the last sample's.
 */
function columnLoops(g: Grid, c0: number, c1: number, edgeHeight: (x: number, y: number) => number): Point[][] {
  const loops: Point[][] = [];
  const sd = new Float64Array(g.ny).fill(-Infinity), h = new Float64Array(g.ny);
  for (let j = 0; j < g.ny; j++) {
    for (let c = c0; c <= c1; c++) {
      const k = j * g.nx + c;
      if (g.sd[k] > sd[j]) sd[j] = g.sd[k];
      if (g.sd[k] > 0 && g.h[k] > h[j]) h[j] = g.h[k];
    }
  }
  const yAt = (jj: number) => g.y0 + jj * g.step;
  // Where the outline crosses between an inside and an outside sample, and the surface height there.
  const edge = (inside: number, outside: number) => yAt(inside) + ((yAt(outside) - yAt(inside)) * sd[inside]) / (sd[inside] - sd[outside]);
  const rim = (y: number, j: number) => {
    let top = 0;
    for (let c = c0; c <= c1; c++) top = Math.max(top, edgeHeight(g.x0 + c * g.step, y));
    return Math.min(h[j], top);
  };
  let j = 0;
  while (j < g.ny) {
    if (sd[j] <= 0) { j++; continue; }
    const j0 = j;
    while (j < g.ny && sd[j] > 0) j++;
    const j1 = j - 1;
    const yTop = j0 > 0 ? edge(j0, j0 - 1) : yAt(j0);
    const yBot = j1 < g.ny - 1 ? edge(j1, j1 + 1) : yAt(j1);
    const right: Point[] = [[j0 > 0 ? rim(yTop, j0) : h[j0], yTop]];
    for (let k = j0; k <= j1; k++) right.push([h[k], yAt(k)]);
    right.push([j1 < g.ny - 1 ? rim(yBot, j1) : h[j1], yBot]);
    if (Math.max(...right.map((p) => p[0])) < 0.05) continue;
    const left = right.map(([u, y]) => [-u, y] as Point).reverse();
    loops.push(simplifyLoop([...right, ...left], 0.04));
  }
  return loops;
}

/** Depth levels in (flat, flat + round): even in angle over the rounded part of the profile. */
function levels(flat: number, round: number, steps: number): number[] {
  const out: number[] = [];
  for (let k = 1; k < steps; k++) out.push(flat + round * Math.sin((k / steps) * (Math.PI / 2)));
  return out;
}

/** Build the implied volume. `volume` scales every depth (0 = flat). Pass `body` to reuse an analysis. */
export function buildVolume(def: AvatarDefinition, volume = 1, body: BodyAnalysis = analyzeBody(def.body.path)): Volume {
  const outlines = body.subpaths.filter((s) => !s.hole);
  const holes = body.subpaths.filter((s) => s.hole);
  const v = Number.isFinite(volume) ? Math.max(0, volume) : 1;
  const xAxis = revolveAxis(body);

  const parts: VolumePart[] = outlines.map((o) => {
    const cuts = holes.filter((h) => h.probe && isInside(o.polys, h.probe[0], h.probe[1]));
    const polys = [...o.polys, ...cuts.flatMap((h) => h.polys)];
    const b = bounds(o.polys);
    const center: Point = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY);
    const step = Math.max(0.25, Math.min(0.45, minDim / 24));

    // Classify: shared horizontal axis, own vertical axis (multi-part bodies only), or inflated.
    let kind: PartKind = 'inflate';
    let profile: Profile | null = null;
    if (xAxis !== null) {
      profile = revolveProfile(polys, false, b.minX, b.maxX, xAxis);
      if (profile) kind = 'revolve-x';
    } else if (outlines.length > 1 && cuts.length === 0) {
      profile = revolveProfile(polys, true, b.minY, b.maxY, center[0]);
      if (profile) kind = 'revolve-y';
    }

    let thickness: number, depth: number, rxy = 0, rz = 0;
    let heightOf: (x: number, y: number, sd: number) => number;
    let levelField: LevelField;
    if (kind === 'inflate' || !profile) {
      const coarse = sampleGrid(polys, b, Math.max(step, 0.6), () => 0);
      thickness = 2 * coarse.sd.reduce((m, d) => Math.max(m, d), 0);
      depth = partDepth(thickness, b, v);
      rxy = Math.min(thickness / 2, depth / 2) * 0.9;
      rz = (depth / 2) * 0.85;
      const shape = { depth, rxy, rz };
      heightOf = (_x, _y, sd) => surfaceZ(shape, sd);
      // Height grows with distance from the outline, so a level is reached at a fixed inset.
      levelField = (_x, _y, sd, level) => sd - insetAt(shape, level);
    } else {
      const p = profile;
      const axis = kind === 'revolve-x' ? (xAxis as number) : center[0];
      const radius = Math.max(...p.r);
      thickness = 2 * radius;
      depth = 2 * radius * v;
      heightOf = kind === 'revolve-x'
        ? (x, y) => v * Math.sqrt(Math.max(0, radiusAt(p, x) ** 2 - (y - axis) ** 2))
        : (x, y) => v * Math.sqrt(Math.max(0, radiusAt(p, y) ** 2 - (x - axis) ** 2));
      // Height ≥ level where t² ≤ R² - (level / v)²: that difference over 2R is about a distance.
      levelField = (x, y, _sd, level) => {
        const r = radiusAt(p, kind === 'revolve-x' ? x : y), t = kind === 'revolve-x' ? y - axis : x - axis;
        return (r * r - t * t - (level / Math.max(v, 1e-6)) ** 2) / (2 * Math.max(r, 0.5));
      };
    }
    const height = (x: number, y: number) =>
      isInside(polys, x, y) ? heightOf(x, y, kind === 'inflate' ? edgeDistance(polys, x, y) : 0) : 0;

    const core: VolumeSlice = {
      axis: 'z', at: 0, d: o.d + cuts.map((h) => h.d).join(''), loops: polys, evenOdd: false,
      box: { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }, inset: 0,
    };
    const zSlices: VolumeSlice[] = [core];
    const xSlices: VolumeSlice[] = [];
    const half = depth / 2;
    if (half > 0.05) {
      const g = sampleGrid(polys, b, step, heightOf);
      const steps = kind === 'inflate'
        ? Math.max(4, Math.min(14, Math.round(rz / 0.8)))
        : Math.max(5, Math.min(18, Math.round(half / 1.1)));
      // Inflated parts keep a straight wall up to half - rz; one slice at its end carries it.
      const ls = kind === 'inflate' ? [half - rz, ...levels(half - rz, rz, steps)] : levels(0, half, steps);
      const addLevel = (level: number, box?: CellBox) => {
        const loops = levelLoops(g, level, levelField, box);
        if (!loops.length) return false;
        const sample = loops.flat().filter((_, k) => k % 3 === 0);
        const inset = Math.min(...sample.map(([x, y]) => edgeDistance(polys, x, y)));
        const slice = { axis: 'z' as const, d: loopsToPath(loops), loops, evenOdd: true, box: loopBox(loops), inset };
        zSlices.push({ ...slice, at: level }, { ...slice, at: -level });
        return true;
      };
      const used = [0];
      for (const level of ls) if (level >= 0.02 && addLevel(level)) used.push(level);
      // Thin parts of an inflated outline (deep, narrow fins): more cross-sections between the levels,
      // the straight wall included, each clipped to its box. Revolved parts' slices span their thin side.
      const thin = kind === 'inflate' ? thinBoxes(g) : [];
      for (const box of thin) {
        for (let k = 1; k < used.length && used[k - 1] < box.top; k++) {
          const a = used[k - 1], gap = used[k] - a, m = Math.ceil(gap / FINE_Z - 1e-9);
          for (let q = 1; q < m && a + (gap * q) / m < box.top; q++) addLevel(a + (gap * q) / m, box);
        }
      }
      zSlices.sort((m, n) => m.at - n.at);

      const width = b.maxX - b.minX;
      const every = Math.max(1, Math.round(Math.max(1.1, width / MAX_X_SLICES) / g.step));
      const edgeHeight = (x: number, y: number) => heightOf(x, y, 0);
      // One plane per `every` grid columns, standing for the whole slab around it.
      const before = Math.floor((every - 1) / 2);
      for (let i = 1; i < g.nx - 1; i += every) {
        const loops = columnLoops(g, Math.max(0, i - before), Math.min(g.nx - 1, i - before + every - 1), edgeHeight);
        if (loops.length) xSlices.push({ axis: 'x', at: g.x0 + i * g.step, d: loopsToPath(loops), loops, evenOdd: true, box: loopBox(loops), inset: 0 });
      }
    }

    return {
      kind, d: core.d, polys, bounds: b, center, thickness, depth, rxy, rz,
      axis: kind === 'revolve-x' ? (xAxis as number) : kind === 'revolve-y' ? center[0] : undefined,
      zSlices, xSlices, height,
    };
  });

  const eyeScale = boostedEyeScale(body, def.eyes);
  // The eyes ride on whichever part is highest under their centers.
  const centers = eyeCenters(def.eyes);
  let eyePart = 0, bestZ = -Infinity;
  parts.forEach((part, i) => {
    const zs = centers.map(([x, y]) => part.height(x, y));
    if (zs.some((z) => z <= 0)) return;
    const z = Math.min(...zs);
    if (z > bestZ) { bestZ = z; eyePart = i; }
  });
  const host = parts[eyePart];
  // Flat eye planes sit at the highest surface under the eye and its gaze travel, so the body never cuts them.
  const w = (EYE_W * eyeScale) / 2 + GAZE_X * eyeScale, hh = (EYE_H * eyeScale) / 2 + GAZE_Y * eyeScale;
  const eyeZ = centers.map(([x, y]) => {
    let top = 0;
    for (const fx of [-1, -0.5, 0, 0.5, 1]) for (const fy of [-1, -0.5, 0, 0.5, 1]) top = Math.max(top, host ? host.height(x + fx * w, y + fy * hh) : 0);
    return top;
  }) as [number, number];

  const normal = (x: number, y: number): Vec3 => {
    if (!host) return [0, 0, 1];
    const e = 0.75;
    const gx = (host.height(x + e, y) - host.height(x - e, y)) / (2 * e);
    const gy = (host.height(x, y + e) - host.height(x, y - e)) / (2 * e);
    const n = Math.hypot(gx, gy, 1);
    return [-gx / n, -gy / n, 1 / n];
  };
  const half = (EYE_W * eyeScale) / 2;
  const eyeNormals = centers.map(([x, y]) => [normal(x - half, y), normal(x, y), normal(x + half, y)]) as [Vec3[], Vec3[]];

  return { parts, bounds: body.bounds, eyePart, eyeZ, eyeScale, eyeNormals };
}

/** Largest eye scale up to EYE_BOOST × the definition's whose drawn eyes keep EYE_BOOST_PAD from the outline. */
export function boostedEyeScale(body: BodyAnalysis, eyes: AvatarEyes): number {
  for (const k of [EYE_BOOST, 1.38, 1.3, 1.22, 1.15, 1.08]) {
    if (!drawnEyesFit(body.polys, { ...eyes, scale: eyes.scale * k }, 0, 0, EYE_BOOST_PAD)) return eyes.scale * k;
  }
  return eyes.scale;
}

export interface FaceRoom {
  /** Drawn eye size relative to the definition's (1..EYE_BOOST). */
  boost: number;
  /** Gap between the drawn eyes at rest (pill and happy arc) and the outline, viewBox units. */
  clearance: number;
  /** Gaze travel left at the drawn size (see gazeRange). */
  gaze: GazeRange;
  /** True when the face meets the design target: full boost, FACE_ROOM_TARGET clearance, full gaze. */
  ok: boolean;
}

/** How much room the face has as the renderer will actually draw it. */
export function faceRoom(def: AvatarDefinition, body: BodyAnalysis = analyzeBody(def.body.path)): FaceRoom {
  const scale = boostedEyeScale(body, def.eyes);
  const eyes = { ...def.eyes, scale };
  const clearance = eyeClearance(body.polys, eyes);
  const gaze = gazeRange(body.polys, eyes);
  const boost = Math.round((scale / def.eyes.scale) * 100) / 100;
  const ok = boost >= EYE_BOOST - 1e-9 && clearance >= FACE_ROOM_TARGET && Math.min(gaze.left, gaze.right, gaze.up, gaze.down) === 1;
  return { boost, clearance, gaze, ok };
}
