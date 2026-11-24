/**
 * Distance from points to the nearest edge of a set of polygons.
 *
 * Every answer here is the smallest value of one expression (the squared distance to a segment,
 * `segDist2`) over all edges, then its square root. A minimum does not depend on the order or the
 * number of values it is taken over, as long as the smallest one is among them. So the index may
 * skip any edge it can prove is farther than the nearest, and still return the same bits a pass
 * over every edge would. All the proofs below keep a margin (SLACK) far wider than rounding error
 * and far narrower than anything it could cost.
 */
import type { Bounds, Point } from './path.ts';
import type { EdgeBands } from './path.ts';

/** Margin on every bound that lets an edge be skipped, viewBox units. */
const SLACK = 1e-6;
/** Side of a bucket of the coarse edge grid, viewBox units. */
const CELL = 4;
/** Side, in samples, of the tiles a sample grid is cut into before each is halved down to samples. */
const TILE = 16;

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Scratch for walking a grid, shared by every index and kept between walks.
/** Per edge: the last `collect` that listed it, so an edge in several buckets is listed once. */
let stamp = new Int32Array(0);
let tags = 0;
/** Candidate lists of the tile in hand, one after another (see `narrow`). */
let lists = new Int32Array(0);
/** Per candidate of the last `survey`: squared distance from its point and the vector to the nearest point. */
let d2 = new Float64Array(0), vx = new Float64Array(0), vy = new Float64Array(0);

/** A regular grid of sample points: x0 + i * step, y0 + j * step. */
export interface SampleGrid { x0: number; y0: number; step: number; nx: number; ny: number }

/**
 * Edges bucketed on a coarse grid, for nearest-edge queries that only visit edges that can matter.
 * The grid is dense and CELL units to a bucket: made for outlines in the 0..100 viewBox.
 */
export class EdgeIndex {
  /** ax, ay, dx, dy, dx² + dy² per edge: the terms of segDist2 that do not depend on the point. */
  private readonly e: Float64Array;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly ox: number;
  private readonly oy: number;
  private readonly span: number;
  private readonly count: number;
  /** The last survey's vector to the nearest point of all. */
  private bx = 0;
  private by = 0;
  // The grid being walked.
  private x0 = 0;
  private y0 = 0;
  private step = 0;
  private nx = 0;

  constructor(polys: Point[][], b: Bounds) {
    let count = 0;
    for (const poly of polys) count += poly.length;
    this.count = count;
    const e = this.e = new Float64Array(5 * count);
    this.ox = b.minX - 4; this.oy = b.minY - 4;
    const span = this.span = Math.ceil((Math.max(b.maxX - b.minX, b.maxY - b.minY) + 8) / CELL) + 1;
    // Counting sort of the edges into every bucket they pass through: count, then place.
    const start = this.start = new Int32Array(span * span + 1);
    let items = this.items = new Int32Array(0), next = start;
    for (const place of [false, true]) {
      if (place) {
        for (let q = 0; q < span * span; q++) start[q + 1] += start[q];
        items = this.items = new Int32Array(start[span * span]);
        next = start.slice(0, span * span);
      }
      let k = 0;
      for (const poly of polys) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++, k += 5) {
          const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
          const dx = bx - ax, dy = by - ay;
          e[k] = ax; e[k + 1] = ay; e[k + 2] = dx; e[k + 3] = dy; e[k + 4] = dx * dx + dy * dy;
          const cy0 = this.cy(Math.min(ay, by)), cy1 = this.cy(Math.max(ay, by));
          for (let cy = cy0; cy <= cy1; cy++) {
            // The stretch of the edge inside this row of buckets, a little generously, so a long
            // slanted edge is not listed in every bucket of its box. The outermost rows also hold
            // whatever lies beyond them, so there the whole edge counts.
            let x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
            if (cy0 < cy1 && cy > 0 && cy < span - 1) {
              const t0 = Math.min(1, Math.max(0, (this.oy + cy * CELL - SLACK - ay) / dy));
              const t1 = Math.min(1, Math.max(0, (this.oy + (cy + 1) * CELL + SLACK - ay) / dy));
              x0 = Math.min(ax + t0 * dx, ax + t1 * dx) - SLACK;
              x1 = Math.max(ax + t0 * dx, ax + t1 * dx) + SLACK;
            }
            for (let cx = this.cx(x0), end = this.cx(x1); cx <= end; cx++) {
              if (place) items[next[cy * span + cx]++] = k;
              else start[cy * span + cx + 1]++;
            }
          }
        }
      }
    }
  }

  /** Makes the shared scratch large enough for a walk over this index's edges. */
  private ready(): void {
    if (stamp.length >= this.count) return;
    stamp = new Int32Array(2 * this.count);
    // A tile's own list, then one shorter list per halving on the way down to a sample.
    lists = new Int32Array((2 + Math.ceil(Math.log2(TILE))) * stamp.length);
    d2 = new Float64Array(stamp.length);
    vx = new Float64Array(stamp.length);
    vy = new Float64Array(stamp.length);
  }

  private cx(x: number) { return Math.max(0, Math.min(this.span - 1, Math.floor((x - this.ox) / CELL))); }
  private cy(y: number) { return Math.max(0, Math.min(this.span - 1, Math.floor((y - this.oy) / CELL))); }

  /** Distance to the nearest edge, searching rings of buckets outward until no closer edge can exist. */
  distance(x: number, y: number): number {
    const { e, items, start, span } = this;
    const bx = this.cx(x), by = this.cy(y);
    let best = Infinity;
    for (let r = 0; r < span; r++) {
      for (let cy = by - r; cy <= by + r; cy++) {
        if (cy < 0 || cy >= span) continue;
        const edgeRow = cy === by - r || cy === by + r;
        for (let cx = bx - r; cx <= bx + r; cx += edgeRow ? 1 : 2 * r || 1) {
          if (cx < 0 || cx >= span) continue;
          const b = cy * span + cx;
          for (let q = start[b], end = start[b + 1]; q < end; q++) {
            // segDist2, written out here and in `nearest` and `survey`: all three must stay the same.
            const k = items[q];
            const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
            let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - x, ey = ay + t * dy - y;
            const d = ex * ex + ey * ey;
            if (d < best) best = d;
          }
        }
      }
      // Every edge not seen yet lies in a bucket more than r cells away (best is squared).
      const reach = r * CELL - SLACK;
      if (reach > 0 && best <= reach * reach) break;
    }
    return Math.sqrt(best);
  }

  /** Distance to the nearest edge at every sample of a grid, row-major. */
  distances(g: SampleGrid): Float64Array {
    const out = new Float64Array(g.nx * g.ny);
    this.ready();
    this.x0 = g.x0; this.y0 = g.y0; this.step = g.step; this.nx = g.nx;
    for (let j0 = 0; j0 < g.ny; j0 += TILE) {
      for (let i0 = 0; i0 < g.nx; i0 += TILE) {
        const i1 = Math.min(g.nx, i0 + TILE) - 1, j1 = Math.min(g.ny, j0 + TILE) - 1;
        const im = (i0 + i1) >> 1, jm = (j0 + j1) >> 1;
        const x = g.x0 + im * g.step, y = g.y0 + jm * g.step;
        this.fill(out, i0, i1, j0, j1, 0, this.collect(x, y, this.distance(x, y) + 2 * radiusOf(g.step, i0, i1, j0, j1) + SLACK));
      }
    }
    return out;
  }

  /**
   * The largest distance to the nearest edge over the grid's samples that are inside the fill
   * (`insideRow` of each sample's row), or 0 if none is. Same as the largest inside value of
   * `distances`, but most of the grid is ruled out without being measured.
   */
  widest(g: SampleGrid, rows: EdgeBands): number {
    this.ready();
    this.x0 = g.x0; this.y0 = g.y0; this.step = g.step; this.nx = g.nx;
    const tiles: number[] = [];
    for (let j0 = 0; j0 < g.ny; j0 += TILE) {
      for (let i0 = 0; i0 < g.nx; i0 += TILE) tiles.push(i0, Math.min(g.nx, i0 + TILE) - 1, j0, Math.min(g.ny, j0 + TILE) - 1);
    }
    // Start from the best middle sample of a tile, so most tiles are ruled out before they are opened.
    const middles = new Float64Array(tiles.length / 4);
    let best = 0;
    for (let k = 0; k < tiles.length; k += 4) {
      const x = g.x0 + ((tiles[k] + tiles[k + 1]) >> 1) * g.step, y = g.y0 + ((tiles[k + 2] + tiles[k + 3]) >> 1) * g.step;
      const d = middles[k / 4] = this.distance(x, y);
      if (d > best && rows.insideRowAt(x, y)) best = d;
    }
    for (let k = 0; k < tiles.length; k += 4) {
      const i0 = tiles[k], i1 = tiles[k + 1], j0 = tiles[k + 2], j1 = tiles[k + 3];
      const x = g.x0 + ((i0 + i1) >> 1) * g.step, y = g.y0 + ((j0 + j1) >> 1) * g.step;
      const d = middles[k / 4], radius = radiusOf(g.step, i0, i1, j0, j1);
      // No sample of the tile is farther from the outline than its middle plus its radius.
      if (d + radius + SLACK < best) continue;
      // If the outline does not reach into the tile, it is inside or outside as a whole.
      const whole = d > radius + SLACK;
      if (whole && !rows.insideRowAt(x, y)) continue;
      best = this.peak(rows, best, whole, i0, i1, j0, j1, 0, this.collect(x, y, d + 2 * radius + SLACK));
    }
    return best;
  }

  /** Lists every edge with a point in the square of `reach` around (x, y) at the start of `lists`. */
  private collect(x: number, y: number, reach: number): number {
    const { items, start, span } = this;
    // Stamps are 32-bit: start over long before the count of collections could wrap.
    if (tags >= 0x7fffff00) { stamp.fill(0); tags = 0; }
    const tag = ++tags;
    let n = 0;
    const cx1 = this.cx(x + reach), cy1 = this.cy(y + reach);
    for (let cy = this.cy(y - reach); cy <= cy1; cy++) {
      for (let cx = this.cx(x - reach); cx <= cx1; cx++) {
        const b = cy * span + cx;
        for (let q = start[b], end = start[b + 1]; q < end; q++) {
          const k = items[q];
          if (stamp[k / 5] === tag) continue;
          stamp[k / 5] = tag;
          lists[n++] = k;
        }
      }
    }
    return n;
  }

  /** Squared distance from (x, y) to the nearest of the edges `lists[lo..hi)`. */
  private nearest(lo: number, hi: number, x: number, y: number): number {
    const e = this.e;
    let best = Infinity;
    for (let q = lo; q < hi; q++) {
      const k = lists[q];
      const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
      let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return best;
  }

  /** `nearest`, keeping for `narrow` each edge's squared distance and the vector to its nearest point. */
  private survey(lo: number, hi: number, x: number, y: number): number {
    const e = this.e;
    let best = Infinity;
    for (let q = lo; q < hi; q++) {
      const k = lists[q];
      const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
      let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      d2[q - lo] = d; vx[q - lo] = ex; vy[q - lo] = ey;
      if (d < best) { best = d; this.bx = ex; this.by = ey; }
    }
    return best;
  }

  /**
   * After a survey of `lists[lo..hi)` from a point at distance `d` from the nearest edge: lists,
   * from `hi` on, the edges that can be nearest to some point within `radius` of it. Returns the
   * end of that list.
   *
   * An edge nearest to such a point p is no farther from p than the surveyed point's nearest point
   * n is. With u and w the unit directions from n and from the edge's nearest point to the
   * surveyed point m, and v = p - m, that gives D + w·v ≤ |p - n| ≤ d + u·v + |v|² / 2d. So the
   * edge's distance D from m exceeds d by at most |u - w| r + r² / 2d, and never by more than 2r.
   */
  private narrow(lo: number, hi: number, d: number, radius: number): number {
    const ball = d + 2 * radius + SLACK;
    const bend = d > 0 ? (radius * radius) / (2 * d) : Infinity;
    const ux = d > 0 ? this.bx / d : 0, uy = d > 0 ? this.by / d : 0;
    let end = hi;
    for (let q = lo; q < hi; q++) {
      const far2 = d2[q - lo];
      if (far2 > ball * ball) continue;
      if (bend < 2 * radius) {
        const far = Math.sqrt(far2);
        const wx = vx[q - lo] / far - ux, wy = vy[q - lo] / far - uy;
        if (far - d > Math.sqrt(wx * wx + wy * wy) * radius + bend + SLACK) continue;
      }
      lists[end++] = lists[q];
    }
    return end;
  }

  /**
   * Measures the samples i0..i1 × j0..j1 into `out`. `lists[lo..hi)` holds every edge that is
   * nearest to some point of the block. The block's middle sample is measured against all of
   * them; that rules most of them out for the rest of the block, and each quarter goes on with
   * the shorter list.
   */
  private fill(out: Float64Array, i0: number, i1: number, j0: number, j1: number, lo: number, hi: number): void {
    const { x0, y0, step, nx } = this;
    if ((i1 - i0 < 2 && j1 - j0 < 2) || hi - lo < 2) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) out[j * nx + i] = Math.sqrt(this.nearest(lo, hi, x0 + i * step, y0 + j * step));
      }
      return;
    }
    const im = (i0 + i1) >> 1, jm = (j0 + j1) >> 1;
    const d = out[jm * nx + im] = Math.sqrt(this.survey(lo, hi, x0 + im * step, y0 + jm * step));
    const end = this.narrow(lo, hi, d, radiusOf(step, i0, i1, j0, j1));
    this.fill(out, i0, im, j0, jm, hi, end);
    if (im < i1) this.fill(out, im + 1, i1, j0, jm, hi, end);
    if (jm < j1) {
      this.fill(out, i0, im, jm + 1, j1, hi, end);
      if (im < i1) this.fill(out, im + 1, i1, jm + 1, j1, hi, end);
    }
  }

  /**
   * `fill` for `widest`: returns the larger of `best` and the largest distance of an inside sample
   * of the block, skipping blocks that cannot hold one. `whole`: the block is known to be inside.
   */
  private peak(rows: EdgeBands, best: number, whole: boolean, i0: number, i1: number, j0: number, j1: number, lo: number, hi: number): number {
    const { x0, y0, step } = this;
    if ((i1 - i0 < 2 && j1 - j0 < 2) || hi - lo < 2) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * step, y = y0 + j * step;
          const d = Math.sqrt(this.nearest(lo, hi, x, y));
          if (d > best && (whole || rows.insideRowAt(x, y))) best = d;
        }
      }
      return best;
    }
    const im = (i0 + i1) >> 1, jm = (j0 + j1) >> 1;
    const x = x0 + im * step, y = y0 + jm * step;
    const d = Math.sqrt(this.survey(lo, hi, x, y)), radius = radiusOf(step, i0, i1, j0, j1);
    // The same two ways out as for a tile (see widest).
    if (d + radius + SLACK < best) return best;
    if (!whole && d > radius + SLACK) {
      if (!rows.insideRowAt(x, y)) return best;
      whole = true;
    }
    if (d > best && (whole || rows.insideRowAt(x, y))) best = d;
    const end = this.narrow(lo, hi, d, radius);
    best = this.peak(rows, best, whole, i0, im, j0, jm, hi, end);
    if (im < i1) best = this.peak(rows, best, whole, im + 1, i1, j0, jm, hi, end);
    if (jm < j1) {
      best = this.peak(rows, best, whole, i0, im, jm + 1, j1, hi, end);
      if (im < i1) best = this.peak(rows, best, whole, im + 1, i1, jm + 1, j1, hi, end);
    }
    return best;
  }
}

/** How far the samples i0..i1 × j0..j1 reach from the middle one, (i0 + i1) >> 1 and (j0 + j1) >> 1. */
function radiusOf(step: number, i0: number, i1: number, j0: number, j1: number): number {
  const im = (i0 + i1) >> 1, jm = (j0 + j1) >> 1;
  return step * Math.hypot(Math.max(im - i0, i1 - im), Math.max(jm - j0, j1 - jm));
}
