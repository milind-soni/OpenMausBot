/**
 * Iso-contours of a sampled scalar field (marching squares), assembled into
 * closed loops and simplified. Used once per definition to turn a part's
 * depth field into plain cross-section paths, so slices need no SVG masks.
 */
import type { Point } from './path.ts';

export interface Field {
  /** Row-major samples, nx * ny. The outermost ring should be below every level. */
  values: Float64Array;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  step: number;
}

/** Closed loops where the field crosses `level` (inside = value ≥ level). */
export function contourLoops(field: Field, level: number): Point[][] {
  const { values, nx, ny, x0, y0, step } = field;
  const at = (i: number, j: number) => values[j * nx + i] - level;
  // Edge keys: horizontal edge (i,j)-(i+1,j) = 2*(j*nx+i), vertical (i,j)-(i,j+1) = 2*(j*nx+i)+1.
  const points = new Map<number, Point>();
  const links = new Map<number, number[]>();
  const point = (key: number): void => {
    if (points.has(key)) return;
    const idx = key >> 1, i = idx % nx, j = (idx - i) / nx;
    const a = at(i, j);
    if (key & 1) {
      const b = at(i, j + 1), t = a / (a - b);
      points.set(key, [x0 + i * step, y0 + (j + t) * step]);
    } else {
      const b = at(i + 1, j), t = a / (a - b);
      points.set(key, [x0 + (i + t) * step, y0 + j * step]);
    }
  };
  const link = (p: number, q: number) => {
    point(p); point(q);
    (links.get(p) ?? links.set(p, []).get(p)!).push(q);
    (links.get(q) ?? links.set(q, []).get(q)!).push(p);
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = at(i, j) >= 0, tr = at(i + 1, j) >= 0, br = at(i + 1, j + 1) >= 0, bl = at(i, j + 1) >= 0;
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = 2 * (j * nx + i), bottom = 2 * ((j + 1) * nx + i);
      const left = 2 * (j * nx + i) + 1, right = 2 * (j * nx + i + 1) + 1;
      if (code === 10 || code === 5) {
        const center = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 >= 0;
        // Diagonal corners: the center decides whether they connect through the cell.
        if ((code === 10) === center) { link(top, right); link(bottom, left); }
        else { link(left, top); link(right, bottom); }
        continue;
      }
      const crossed: number[] = [];
      if (tl !== tr) crossed.push(top);
      if (tr !== br) crossed.push(right);
      if (br !== bl) crossed.push(bottom);
      if (bl !== tl) crossed.push(left);
      link(crossed[0], crossed[1]);
    }
  }

  const loops: Point[][] = [];
  const seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Point[] = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(points.get(cur)!);
      const next = links.get(cur)!.find((n) => n !== prev && !seen.has(n));
      if (next === undefined) break;
      prev = cur; cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function perpendicular(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

/** Ramer-Douglas-Peucker on a closed loop. */
export function simplifyLoop(loop: Point[], tolerance: number): Point[] {
  if (loop.length <= 8) return loop;
  // Split at the point farthest from the first so the closed loop becomes two open chains.
  let far = 0, best = -1;
  for (let k = 1; k < loop.length; k++) {
    const d = Math.hypot(loop[k][0] - loop[0][0], loop[k][1] - loop[0][1]);
    if (d > best) { best = d; far = k; }
  }
  const keep = new Uint8Array(loop.length);
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, loop.length]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const end = loop[e % loop.length];
    let idx = -1, max = tolerance;
    for (let k = s + 1; k < e; k++) {
      const d = perpendicular(loop[k], loop[s], end);
      if (d > max) { max = d; idx = k; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return loop.filter((_, k) => keep[k]);
}

/** Path numbers are hundredths; vertices snap to even ones so edge midpoints land exactly on the grid. */
const UNIT = 100;

/** A grid value as a path number, as short as SVG allows: no leading zero, no `-0`. */
const num = (k: number) => {
  const a = Math.abs(k), whole = Math.floor(a / UNIT), frac = a % UNIT;
  const f = frac === 0 ? '' : frac % 10 === 0 ? `.${frac / 10}` : frac < 10 ? `.0${frac}` : `.${frac}`;
  return (k < 0 ? '-' : '') + (whole || !f ? whole : '') + f;
};

/** Turns sharper than this (radians) stay corners; gentler ones are drawn as curves. */
const CORNER = 0.6;

/**
 * A gentle turn between long edges is a corner of the outline too, not a facet of a traced curve:
 * it stays sharp once its curve would leave the traced loop by more than this (viewBox units).
 */
const SAG = 0.1;

/**
 * Compact closed path from loops (draw with fill-rule evenodd). Traced loops are polylines, so
 * gentle turns are drawn as quadratics between edge midpoints, which hides their facets at large
 * sizes; real corners stay sharp. Relative commands, smooth t segments and implicit repeats keep
 * the string short.
 */
export function loopsToPath(loops: Point[][]): string {
  let d = '', cmd = '', last = '';
  const emit = (c: string, ...ks: number[]) => {
    if (c !== cmd) { d += c; cmd = c; last = ''; }
    for (const k of ks) {
      const t = num(k);
      // A separator is only needed where the next number could be read as part of the last one.
      if (last && t[0] !== '-' && !(t[0] === '.' && last.includes('.'))) d += ' ';
      d += t;
      last = t;
    }
  };
  for (const loop of loops) {
    const n = loop.length;
    const v = loop.map(([x, y]) => [2 * Math.round(x * UNIT / 2), 2 * Math.round(y * UNIT / 2)]);
    const corner = loop.map((p, k) => {
      const a = loop[(k + n - 1) % n], b = loop[(k + 1) % n];
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      // The curve passes a quarter of p's height over the chord a-b away from p.
      return Math.abs(Math.atan2(cross, (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]))) > CORNER
        || Math.abs(cross) > 4 * SAG * Math.hypot(b[0] - a[0], b[1] - a[1]);
    });
    const mid = (k: number) => [(v[k % n][0] + v[(k + 1) % n][0]) / 2, (v[k % n][1] + v[(k + 1) % n][1]) / 2];
    let [cx, cy] = mid(0);
    emit('M', cx, cy);
    let smooth = false;
    for (let k = 1; k <= n; k++) {
      const [px, py] = v[k % n];
      if (corner[k % n]) {
        // A midpoint between two corners lies on their straight edge, so it is only kept to start a curve.
        emit('l', px - cx, py - cy);
        cx = px; cy = py;
        if (k < n && !corner[(k + 1) % n]) {
          const [mx, my] = mid(k);
          emit('l', mx - cx, my - cy);
          cx = mx; cy = my;
        }
        smooth = false;
      } else {
        const [mx, my] = mid(k);
        // After a curve, the reflected control point is exactly this vertex (it mirrors the last one
        // across their shared midpoint), so t needs only the end point.
        if (smooth) emit('t', mx - cx, my - cy);
        else emit('q', px - cx, py - cy, mx - cx, my - cy);
        cx = mx; cy = my;
        smooth = true;
      }
    }
    d += 'Z';
    cmd = 'Z'; last = '';
  }
  return d;
}
