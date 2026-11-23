/**
 * Restricted SVG path geometry: parser, normalizer and flattener.
 *
 * Accepts the path command set M L H V C S Q T A Z (absolute and relative)
 * and nothing else. The parsed result is re-serialized from numbers, so the
 * renderer never echoes model-written text into markup.
 */

export type Segment =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; rot: number; large: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { c: 'Z' };

export type Point = [number, number];

export const PATH_LIMITS = {
  maxChars: 6000,
  maxSegments: 400,
  maxSubpaths: 16,
  coordMin: -20,
  coordMax: 120,
} as const;

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export class PathError extends Error {}

function tokenize(d: string): (string | number)[] {
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/.test(d)) {
    const bad = d.match(/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/)![0];
    throw new PathError(`unsupported character ${JSON.stringify(bad)} (allowed commands: M L H V C S Q T A Z)`);
  }
  const tokens: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) throw new PathError(`cannot parse path near ${JSON.stringify(d.slice(i, i + 12))}`);
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
    i = re.lastIndex;
  }
  return tokens;
}

/** Parse and convert to absolute M/L/C/Q/A/Z segments. Throws PathError. */
export function parsePath(d: string): Segment[] {
  if (typeof d !== 'string' || d.trim() === '') throw new PathError('path is empty');
  if (d.length > PATH_LIMITS.maxChars) throw new PathError(`path longer than ${PATH_LIMITS.maxChars} characters`);
  const tokens = tokenize(d);
  const out: Segment[] = [];
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevC: [number, number] | null = null;
  let prevQ: [number, number] | null = null;
  let cmd = '';
  let subpaths = 0;
  let open = false;

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (!open) throw new PathError('Z without an open subpath');
        out.push({ c: 'Z' });
        cx = sx; cy = sy; prevC = prevQ = null; open = false;
        continue;
      }
    } else if (!cmd) {
      throw new PathError('path must start with M');
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathError('numbers after Z');
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (out.length === 0 && up !== 'M') throw new PathError('path must start with M');
    const n = ARG_COUNT[up];
    const args: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = tokens[i + k];
      if (typeof v !== 'number') throw new PathError(`command ${cmd} expects ${n} numbers`);
      if (!Number.isFinite(v)) throw new PathError('non-finite number');
      args.push(v);
    }
    i += n;
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    switch (up) {
      case 'M': {
        if (open) out.push({ c: 'Z' }); // implicit close keeps fill semantics explicit
        cx = args[0] + ox; cy = args[1] + oy; sx = cx; sy = cy;
        out.push({ c: 'M', x: cx, y: cy });
        subpaths++; open = true;
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit lineto
        break;
      }
      case 'L': cx = args[0] + ox; cy = args[1] + oy; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'H': cx = args[0] + ox; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'V': cy = args[0] + oy; out.push({ c: 'L', x: cx, y: cy }); break;
      case 'C': {
        const s: Segment = { c: 'C', x1: args[0] + ox, y1: args[1] + oy, x2: args[2] + ox, y2: args[3] + oy, x: args[4] + ox, y: args[5] + oy };
        out.push(s); nextC = [s.x2, s.y2]; cx = s.x; cy = s.y; break;
      }
      case 'S': {
        const x1: number = prevC ? 2 * cx - prevC[0] : cx, y1: number = prevC ? 2 * cy - prevC[1] : cy;
        const s: Segment = { c: 'C', x1, y1, x2: args[0] + ox, y2: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
        out.push(s); nextC = [s.x2, s.y2]; cx = s.x; cy = s.y; break;
      }
      case 'Q': {
        const s: Segment = { c: 'Q', x1: args[0] + ox, y1: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
        out.push(s); nextQ = [s.x1, s.y1]; cx = s.x; cy = s.y; break;
      }
      case 'T': {
        const x1: number = prevQ ? 2 * cx - prevQ[0] : cx, y1: number = prevQ ? 2 * cy - prevQ[1] : cy;
        const s: Segment = { c: 'Q', x1, y1, x: args[0] + ox, y: args[1] + oy };
        out.push(s); nextQ = [x1, y1]; cx = s.x; cy = s.y; break;
      }
      case 'A': {
        const [rx, ry, rot, la, sw] = args;
        if (rx < 0 || ry < 0) throw new PathError('arc radii must be non-negative');
        if ((la !== 0 && la !== 1) || (sw !== 0 && sw !== 1)) throw new PathError('arc flags must be 0 or 1, written as separate numbers');
        cx = args[5] + ox; cy = args[6] + oy;
        out.push({ c: 'A', rx, ry, rot, large: la as 0 | 1, sweep: sw as 0 | 1, x: cx, y: cy });
        break;
      }
      default:
        throw new PathError(`unsupported command ${cmd}`);
    }
    prevC = nextC; prevQ = nextQ;
    if (out.length > PATH_LIMITS.maxSegments) throw new PathError(`more than ${PATH_LIMITS.maxSegments} segments`);
  }
  if (open) out.push({ c: 'Z' });
  if (subpaths > PATH_LIMITS.maxSubpaths) throw new PathError(`more than ${PATH_LIMITS.maxSubpaths} subpaths`);
  for (const s of out) {
    for (const [k, v] of Object.entries(s)) {
      if (k === 'c' || typeof v !== 'number') continue;
      if (k === 'rot' || k === 'large' || k === 'sweep') continue;
      if (v < PATH_LIMITS.coordMin || v > PATH_LIMITS.coordMax) throw new PathError(`coordinate ${v} far outside the 0..100 viewBox`);
    }
  }
  return out;
}


function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
}

/** Compact absolute serialization built only from parsed numbers. */
export function serializePath(segs: Segment[]): string {
  const parts: string[] = [];
  for (const s of segs) {
    switch (s.c) {
      case 'M': parts.push(`M${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'L': parts.push(`L${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'C': parts.push(`C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'Q': parts.push(`Q${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'A': parts.push(`A${fmt(s.rx)} ${fmt(s.ry)} ${fmt(s.rot)} ${s.large} ${s.sweep} ${fmt(s.x)} ${fmt(s.y)}`); break;
      case 'Z': parts.push('Z'); break;
    }
  }
  return parts.join('');
}

/** Endpoint arc → sampled points (SVG implementation notes, F.6.5). */
function sampleArc(x0: number, y0: number, s: Extract<Segment, { c: 'A' }>, out: Point[]): void {
  let { rx, ry } = s;
  const { x, y } = s;
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) { out.push([x, y]); return; }
  const phi = (s.rot * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (s.large === s.sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!s.sweep && dt > 0) dt -= 2 * Math.PI;
  if (s.sweep && dt < 0) dt += 2 * Math.PI;
  // Chords within FLATNESS of the arc: a chord over angle θ sags r(1 - cos(θ/2)).
  const step = 2 * Math.acos(Math.max(-1, 1 - FLATNESS / Math.max(rx, ry)));
  const steps = Math.min(256, Math.max(4, Math.ceil(Math.abs(dt) / step)));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/**
 * Largest gap, viewBox units, between a curve and the polygon that stands for it. Volume slices
 * follow that polygon while the flat core draws the real curve, so coarser chords show as facets
 * and teeth along the rim of large avatars.
 */
export const FLATNESS = 0.02;

/** Flatten into closed polygons, one per subpath. */
export function flattenPath(segs: Segment[]): Point[][] {
  const polys: Point[][] = [];
  let cur: Point[] = [];
  let px = 0, py = 0;
  for (const s of segs) {
    switch (s.c) {
      case 'M':
        if (cur.length) polys.push(cur);
        cur = [[s.x, s.y]]; px = s.x; py = s.y; break;
      case 'L': cur.push([s.x, s.y]); px = s.x; py = s.y; break;
      case 'C': {
        // Wang's bound: this many chords keep within FLATNESS of the curve.
        const m = Math.max(Math.hypot(px - 2 * s.x1 + s.x2, py - 2 * s.y1 + s.y2), Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y));
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          cur.push([
            u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
            u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
          ]);
        }
        px = s.x; py = s.y; break;
      }
      case 'Q': {
        const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt((0.25 * Math.hypot(px - 2 * s.x1 + s.x, py - 2 * s.y1 + s.y)) / FLATNESS))));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          cur.push([u * u * px + 2 * u * t * s.x1 + t * t * s.x, u * u * py + 2 * u * t * s.y1 + t * t * s.y]);
        }
        px = s.x; py = s.y; break;
      }
      case 'A': sampleArc(px, py, s, cur); px = s.x; py = s.y; break;
      case 'Z':
        if (cur.length) { polys.push(cur); px = cur[0][0]; py = cur[0][1]; }
        cur = []; break;
    }
  }
  if (cur.length) polys.push(cur);
  return polys.filter((p) => p.length >= 3);
}

/** Nonzero winding number of a point against all subpaths (SVG default fill rule). */
export function winding(polys: Point[][], x: number, y: number): number {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
    }
  }
  return w;
}

export function isInside(polys: Point[][], x: number, y: number): boolean {
  return winding(polys, x, y) !== 0;
}

/**
 * Nonzero inside flags for many points on one row (xs ascending), from a
 * single pass over the edges instead of one winding test per point.
 */
export function insideRow(polys: Point[][], y: number, xs: number[], out: Uint8Array): void {
  const hits: [number, number][] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xj, yj] = poly[j], [xi, yi] = poly[i];
      if (yj <= y && yi > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), 1]);
      else if (yi <= y && yj > y) hits.push([xj + ((y - yj) * (xi - xj)) / (yi - yj), -1]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  let w = 0, h = 0;
  for (let k = 0; k < xs.length; k++) {
    while (h < hits.length && hits[h][0] < xs[k]) w += hits[h++][1];
    out[k] = w !== 0 ? 1 : 0;
  }
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function bounds(polys: Point[][]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of polys) for (const [x, y] of p) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

/** Filled area estimated on a 1-unit sample grid (nonzero rule). */
export function filledArea(polys: Point[][], b: Bounds = bounds(polys)): number {
  let n = 0;
  const xs: number[] = [];
  for (let x = Math.floor(b.minX) + 0.5; x < b.maxX; x += 1) xs.push(x);
  const row = new Uint8Array(xs.length);
  for (let y = Math.floor(b.minY) + 0.5; y < b.maxY; y += 1) {
    insideRow(polys, y, xs, row);
    for (const v of row) n += v;
  }
  return n;
}

/** Split normalized segments into one segment list per subpath. */
export function splitSubpaths(segs: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  for (const s of segs) {
    if (s.c === 'M') out.push([]);
    out[out.length - 1]?.push(s);
  }
  return out;
}
