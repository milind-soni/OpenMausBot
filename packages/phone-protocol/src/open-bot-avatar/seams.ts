/**
 * Silhouette seams: small accidental steps where parts meet.
 *
 * The outer profile of the whole body (its left, right, top and bottom
 * extent, scanned every 0.1 units) should change either gradually (a smooth,
 * blended join) or by a clearly readable step. A sudden change of only a
 * fraction of a unit up to ~2.5 units is the in-between case: two parts whose
 * edges nearly line up leave a thin ledge or a notch at the join, which reads
 * as a flaw (and, magnified on a large stage, as a chip in the outline).
 *
 * A step's size is its whole same-direction change around the sudden part, so
 * a deliberate step with rounded corners still counts at its full height.
 * Changes touching the start or end of a profile run (a part's own rounded
 * top, say) are not joins and are skipped.
 */
import { bounds } from './path.ts';
import type { Point } from './path.ts';

export type SeamSide = 'left' | 'right' | 'top' | 'bottom';

export interface Seam {
  side: SeamSide;
  /** Where along the side the step sits (y for left/right, x for top/bottom). */
  at: number;
  /** Step height, viewBox units: positive steps outward, negative inward (walking down or right). */
  size: number;
}

/** Steps below this are invisible; from this up to SEAM_MAX they read as accidental. */
export const SEAM_MIN = 0.3;
/** Steps at least this tall read as a deliberate, structural step. */
export const SEAM_MAX = 2.5;

const STEP = 0.1;
/** Slope (profile change per unit along the side) that counts as sudden, and that still continues a step. */
const SUDDEN = 2.5;
const CONTINUES = 0.6;
/** Changes this close to the ends of a profile run belong to a part's own outline, not to a join. */
const END_SKIP = 1;

/** Filled intervals of the line `y = s` (rows) under the nonzero rule. */
function spans(polys: Point[][], s: number): [number, number][] {
  const xs: [number, number][] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i];
      if ((ay <= s && by > s) || (by <= s && ay > s)) xs.push([ax + ((s - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
    }
  }
  xs.sort((m, n) => m[0] - n[0]);
  const out: [number, number][] = [];
  let w = 0, start = 0;
  for (const [x, d] of xs) {
    const was = w;
    w += d;
    if (was === 0 && w !== 0) start = x;
    else if (was !== 0 && w === 0) out.push([start, x]);
  }
  return out;
}

/** Outward extent of one side along a scan; NaN where the line misses the body. */
function profile(polys: Point[][], lo: number, hi: number, side: 'low' | 'high'): { at: number[]; e: number[] } {
  const at: number[] = [], e: number[] = [];
  for (let s = lo + STEP / 2; s < hi; s += STEP) {
    const sp = spans(polys, s);
    at.push(s);
    e.push(sp.length ? (side === 'low' ? -sp[0][0] : sp[sp.length - 1][1]) : NaN);
  }
  return { at, e };
}

function stepsIn(at: number[], e: number[]): { at: number; size: number }[] {
  const out: { at: number; size: number }[] = [];
  let k = 0;
  while (k < e.length) {
    if (Number.isNaN(e[k])) { k++; continue; }
    const a = k;
    while (k < e.length && !Number.isNaN(e[k])) k++;
    const b = k - 1; // one contiguous run of samples: a..b
    const d = (i: number) => e[i + 1] - e[i];
    let i = a;
    while (i < b) {
      if (Math.abs(d(i)) <= SUDDEN * STEP) { i++; continue; }
      const sign = Math.sign(d(i));
      let lo = i, hi = i;
      while (lo > a && Math.sign(d(lo - 1)) === sign && Math.abs(d(lo - 1)) > CONTINUES * STEP) lo--;
      while (hi + 1 < b && Math.sign(d(hi + 1)) === sign && Math.abs(d(hi + 1)) > CONTINUES * STEP) hi++;
      const size = e[hi + 1] - e[lo];
      const touchesEnd = (lo - a) * STEP < END_SKIP || (b - hi - 1) * STEP < END_SKIP;
      if (!touchesEnd && Math.abs(size) >= SEAM_MIN && Math.abs(size) < SEAM_MAX) out.push({ at: at[i], size: Math.round(size * 100) / 100 });
      i = hi + 1;
    }
  }
  return out;
}

/** Accidental steps in the body's outer silhouette (see the module comment). */
export function silhouetteSeams(polys: Point[][]): Seam[] {
  const b = bounds(polys);
  const cols = polys.map((p) => p.map(([x, y]) => [y, x] as Point));
  const seams: Seam[] = [];
  const add = (side: SeamSide, p: { at: number[]; e: number[] }) => {
    for (const s of stepsIn(p.at, p.e)) seams.push({ side, ...s });
  };
  add('left', profile(polys, b.minY, b.maxY, 'low'));
  add('right', profile(polys, b.minY, b.maxY, 'high'));
  add('top', profile(cols, b.minX, b.maxX, 'low'));
  add('bottom', profile(cols, b.minX, b.maxX, 'high'));
  return seams;
}
