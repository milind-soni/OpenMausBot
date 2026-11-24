/**
 * What a state draws besides the body: the ribbons that circle a working bot, and the marks a
 * thinking or blocked bot turns into (three dots, an exclamation mark). Pure geometry in viewBox
 * units, from the body's bounds, a seed and the animation clock.
 */
import { noise } from './motion.ts';
import type { Bounds, Point } from './path.ts';

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (u: number) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const f = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

export interface Box { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------------------
// Ribbons

/** One piece of a ribbon: the part of it in front of the body, or the part behind. */
export interface RibbonPiece {
  d: string;
  front: boolean;
  box: Box;
  /**
   * Which ribbon the piece belongs to. In a celebration, 0..8: hoop `ribbon / LANES`, lane
   * `ribbon % LANES` (from the inner ring out). A working turn has one hoop with three to five
   * ribbons, numbered 0..4 from the inner ring out.
   */
  ribbon: number;
  /**
   * The stretch of its ribbon the piece covers, 0 (tail) to 1 (head), and the centre of the
   * ribbon at either end of that stretch, for a gradient along it. A ribbon comes in a few
   * stretches, each a little past the next where they meet so no seam shows.
   */
  along: [number, number];
  from: [number, number];
  to: [number, number];
}

/**
 * The ribbons ride hoops round the body's centre, laid out as measured from a reference
 * animation, at one size for every avatar. Lengths are in design units: the reference's
 * 228.541-unit space, which its bot fills; here that space is a body of the typical size,
 * BODY units across, so one design unit is BODY / DESIGN avatar units whatever the avatar.
 *
 * A hoop is a ring of radius RING tipped HOOP_TILT out of the screen, so it shows as a flat ellipse, and
 * rolled in the picture. Its near side is the top: a ribbon crosses in front of the body along
 * the top and behind it along the bottom. A working bot uses one hoop, rolled HOOP_ROLL; a
 * celebration three, each a third of a half turn further round, so they cross into a cage.
 *
 * Each hoop carries LANES ribbons on rings LADDER units apart in all, outward from its ring.
 * A ribbon starts at the top of its hoop and goes round with the body's turn (`sweep`), each at
 * its own share of it (FOLLOW) plus a drift of its own (DRIFT), so the ribbons on one hoop part
 * as they go; its ring widens as it goes (WIDEN), and its tail trails up to ARC behind its head.
 */
const DESIGN = 228.541;
/** The typical body across its larger side (the median of the starters and gallery). */
const BODY = 80;
const UNIT = BODY / DESIGN;
/**
 * A hoop's inner ring stands this far outside the body along the hoop's own direction: the hoop's
 * sides, where its ribbons pass behind the body, lie just off the outline (the inner ribbon's
 * edge included), whatever the shape. RING is the typical body's (half its widest row, 38.8,
 * the median of the starters and gallery, × 116/114.27), for callers that give no outline.
 */
const RIM_MARGIN = 2;
const RING = 38.8 * (116 / 114.2705);

/**
 * How far `outlines` (the body in each pose it takes) reach from (cx, cy): `at` along a direction
 * (radians), either way, worked out exactly each time it is asked (a hoop asks once a frame, along
 * its own roll); `max` the farthest over all directions, from RIM_STEPS samples over a half turn.
 */
const RIM_STEPS = 180;

/** Directions a half turn is cut into for finding the edges a line through the centre can cross. */
const RIM_FANS = 180;

/**
 * How far `outlines` reach from (cx, cy) along a direction (radians), either way, exactly.
 *
 * A line through the centre only crosses the edges that span its direction as seen from there, so
 * the edges are listed by the directions they span, with a fan to spare on either side, and a
 * line is tested against the edges of its own fan. An edge left out lies a whole fan off the
 * line, far more than the test's rounding, so it would not have counted: the answer is the same
 * as from testing every edge.
 */
function reachFinder(outlines: Point[][][], cx: number, cy: number): (a: number) => number {
  let count = 0;
  for (const outline of outlines) for (const poly of outline) count += poly.length;
  // x1, y1 and the edge vector, per edge.
  const e = new Float64Array(4 * count);
  // The fans each edge spans: first and how many more. Edges at the centre span them all.
  const first = new Int32Array(count), more = new Int32Array(count);
  const start = new Int32Array(RIM_FANS + 1);
  let k = 0;
  for (const outline of outlines) {
    for (const poly of outline) {
      for (let i = 0; i < poly.length; i++, k++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        e[4 * k] = p[0]; e[4 * k + 1] = p[1]; e[4 * k + 2] = q[0] - p[0]; e[4 * k + 3] = q[1] - p[1];
        const px = p[0] - cx, py = p[1] - cy, qx = q[0] - cx, qy = q[1] - cy;
        // The turn from p to q about the centre, the short way round.
        const from = Math.atan2(py, px), turn = Math.atan2(px * qy - py * qx, px * qx + py * qy);
        const near = px * px + py * py < 1e-6 || qx * qx + qy * qy < 1e-6 || Math.abs(turn) > Math.PI - 0.1;
        const lo = Math.floor((Math.min(from, from + turn) / Math.PI) * RIM_FANS) - 1;
        const hi = Math.floor((Math.max(from, from + turn) / Math.PI) * RIM_FANS) + 1;
        first[k] = near ? 0 : ((lo % RIM_FANS) + RIM_FANS) % RIM_FANS;
        more[k] = near || !(hi - lo < RIM_FANS) ? RIM_FANS - 1 : hi - lo;
        for (let f = 0; f <= more[k]; f++) start[((first[k] + f) % RIM_FANS) + 1]++;
      }
    }
  }
  for (let f = 0; f < RIM_FANS; f++) start[f + 1] += start[f];
  const items = new Int32Array(start[RIM_FANS]), next = start.slice(0, RIM_FANS);
  for (k = 0; k < count; k++) for (let f = 0; f <= more[k]; f++) items[next[(first[k] + f) % RIM_FANS]++] = 4 * k;

  return (a) => {
    const ux = Math.cos(a), uy = Math.sin(a);
    // The fan of the direction itself, so an angle of any size lands in the right one.
    const turns = Math.atan2(uy, ux) / Math.PI;
    const fan = Math.floor((turns - Math.floor(turns)) * RIM_FANS);
    // A direction that is in no fan (not a number) is tested against every edge.
    const known = fan >= 0 && fan < RIM_FANS;
    let far = 0;
    for (let n = known ? start[fan] : 0, end = known ? start[fan + 1] : count; n < end; n++) {
      const at = known ? items[n] : 4 * n;
      const x1 = e[at], y1 = e[at + 1], ex = e[at + 2], ey = e[at + 3], den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;
      // Where the line through the centre crosses this edge: t along the line, s along the edge.
      const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den, s = ((x1 - cx) * uy - (y1 - cy) * ux) / den;
      if (s >= 0 && s <= 1) far = Math.max(far, Math.abs(t));
    }
    return far;
  };
}

/** How each hoop is rolled in the picture, for an avatar's seed: hoop 0 is a working turn's. */
function hoopRolls(seed: number): number[] {
  return Array.from({ length: HOOPS }, (_, i) => HOOP_ROLL + (i * Math.PI) / HOOPS + (noise(seed, 450 + i) - 0.5) * HOOP_JITTER);
}

/** Where a body's hoops are centred, and how far the body reaches from there (see rimOf). */
export interface Rim {
  cx: number;
  cy: number;
  at: (angle: number) => number;
  max: number;
}
export function rimOf(outlines: Point[][][], cx: number, cy: number): Rim {
  const at = reachFinder(outlines, cx, cy);
  const steps = Array.from({ length: RIM_STEPS }, (_, k) => at((k * Math.PI) / RIM_STEPS));
  // A spike between two samples can reach a little further than either: allow for a degree's sweep.
  return { cx, cy, at, max: Math.max(...steps) * 1.02 };
}
const HOOP_TILT = 0.386;
const HOOP_ROLL = 0.157;
/** A hoop's roll jitter (full range, radians). */
const HOOP_JITTER = 0.24;
/**
 * A hoop's tilt jitter. The ribbons on one hoop share its roll and tilt exactly: they overlap
 * side by side, and only on one plane do they all pass behind the body along the same line, so
 * which of them lies on top never flips where they do.
 */
const HOOP_TILT_JITTER = 0.08;
const LADDER = 38;
const ARC: [number, number] = [2.2, 3.4];
const FOLLOW: [number, number] = [0.74, 0.94];
/** Radians per second a ribbon drifts on by itself, and design units per second its ring widens. */
const DRIFT: [number, number] = [0.5, 1.1];
const WIDEN = 2.5;
/** How far behind the turn a ribbon starts, at most (radians). */
const START = 0.18;
/**
 * A ribbon's width: a size per ribbon (design units; wider when there are only three, narrower
 * among nine), times BRUSH. It narrows to FAR of that while its head is behind the body, is never
 * wider than a third of its own length on screen, and runs from half that width at its tail to
 * the full width at its head, round at both ends. It grows in over GROW_S and thins as it draws back in.
 */
const SIZE_FEW: [number, number] = [8, 10.5];
const SIZE_FOUR: [number, number] = [6.6, 8.6];
const SIZE_MANY: [number, number] = [5.6, 7.4];
/** A working turn lets out three to five ribbons on its one hoop (per avatar); a celebration three on each. */
const WORK_LANES: [number, number] = [3, 5];
const sizeFor = (count: number) => (count <= 3 ? SIZE_FEW : count === 4 ? SIZE_FOUR : SIZE_MANY);
const BRUSH = 1.7 * 1.98;
const FAR = 0.72;
const GROW_S = 0.34;
/** The ribbons on a turn are let out one after another, this long apart (seconds). */
const STAGGER: [number, number] = [0.055, 0.105];
/**
 * How fast the sweep goes on average (radians per second), working and celebrating: the drift
 * and widening are timed against it, so a ribbon is placed from the sweep alone.
 */
const SWEEP_RATE: [number, number] = [6.3, 15];
/** The longest a sweep lasts, seconds: the widening is bounded by it. */
const SWEEP_LONGEST = 4;
export const LANES = 3;
export const HOOPS = 3;
const SAMPLES = 24;
/** A ribbon is cut into stretches this many samples long, each with a gradient of its own, so its colour follows its length even where it curves round. */
const STRETCH = 6;
/** How far either side of a layer change a ribbon is sampled, radians: the piece behind runs this far on under the piece in front. */
const SLIVER = 0.02;
/** Points on each round end of a ribbon. */
const CAP = 7;

const mix = (range: [number, number], u: number) => range[0] + (range[1] - range[0]) * u;

/**
 * The radius of the farthest ring a ribbon can ride round a body whose outline reaches `rimMax`
 * from its centre at most, the widest a ribbon gets, and how far a ribbon reaches out from its
 * ring (half that). Widths are the same for every avatar; the rings follow its outline.
 */
export function ribbonReach(rimMax?: number): { radius: number; width: number; band: number } {
  const width = SIZE_FEW[1] * BRUSH * UNIT;
  const ring = rimMax === undefined ? RING : rimMax + RIM_MARGIN;
  return { radius: ring + (LADDER + WIDEN * SWEEP_LONGEST) * UNIT, width, band: width / 2 };
}

/**
 * The ribbons at one moment, as filled outlines: round at both ends, a little narrower at the
 * tail than at the head and narrower behind the body, and split where a ribbon passes from
 * behind the body to in front of it. `presence` 0..1 draws them out and back in. `cage` picks
 * the layout: a working turn's 3 to 5 ribbons on one hoop (below 0.5), or a celebration's three
 * on each of three hoops. `sweep` (radians, signed) is how far the body's turn has carried
 * them; between turns they are not drawn. Each ribbon narrows where its hoop curves tighter than
 * half its width, so its outline never folds over itself. `rim` gives the hoops' centre (the
 * middle of the body's mass) and how far the body reaches from it along a direction: a working
 * turn's hoop stands just outside the body along its own direction; a celebration's three share
 * one radius, the largest any of them needs, so the cage stays round. Either way the ribbons pass
 * behind the body only off its outline.
 */
export function ribbonPieces(
  b: Bounds, presence: number, seed: number, _time: number, sweep = 0, cage = 0, rim?: Rim,
): RibbonPiece[] {
  const k = clamp(presence, 0, 1), more = cage >= 0.5 ? 1 : 0;
  if (k <= 0.01) return [];
  const cx = rim ? rim.cx : (b.minX + b.maxX) / 2, cy = rim ? rim.cy : (b.minY + b.maxY) / 2;
  const rolls = hoopRolls(seed), rollOf = (i: number) => rolls[i];
  const cageRing = rim ? Math.max(...[0, 1, 2].map((i) => rim.at(rollOf(i)))) + RIM_MARGIN : RING;
  const unit = UNIT;
  const dir = sweep < 0 ? -1 : 1;
  // How long the sweep has been going, from how far it has got.
  const since = Math.abs(sweep) / mix(SWEEP_RATE, more);
  const pieces: RibbonPiece[] = [];
  for (let i = 0; i < (more ? HOOPS : 1); i++) {
    const hoopRoll = rollOf(i);
    const hoopTilt = HOOP_TILT + (noise(seed, 460 + i) - 0.5) * HOOP_TILT_JITTER;
    const ring = more ? cageRing : rim ? rim.at(hoopRoll) + RIM_MARGIN : RING;
    const lanes = i || more > 0 ? LANES : Math.round(mix(WORK_LANES, noise(seed, 47)));
    for (let l = 0; l < lanes; l++) {
      const n = (m: number) => noise(seed, 500 + (i * LANES + l) * 11 + m);
      // Let out in turn, lane by lane across the hoops: how long ago this one was, and how far
      // the turn had got by then.
      const order = more > 0 ? l * HOOPS + i : l;
      const at = order * mix(STAGGER, n(7));
      const life = since - at;
      if (life <= 0) continue;
      const before = since > 0 ? Math.abs(sweep) * (at / since) : 0;
      const roll = hoopRoll;
      const tilt = hoopTilt;
      const flat = Math.sin(tilt), depth = Math.cos(tilt);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const r = ring + (l * LADDER * unit) / (lanes - 1) + mix([0, WIDEN], n(2)) * unit * life;
      // The orbit angle (0 = the top of the hoop) of the head: it starts where the turn was when
      // it was let out, a little behind, and goes its own share of the rest. Its tail trails it by
      // as far as it has gone, up to its arc; drawing back in shortens and thins it.
      const travel = (Math.abs(sweep) - before) * mix(FOLLOW, n(3)) + mix(DRIFT, n(4)) * life;
      const head = dir * (before + travel - START * n(5));
      const ret = 1 - clamp(k * 1.25, 0, 1);
      const length = Math.min(mix(ARC, n(6)), travel) * (1 - ret * ret * (3 - 2 * ret));
      if (length <= 0.02) continue;
      const size = mix(sizeFor(lanes), n(8)) * (1 - more) + mix(SIZE_MANY, n(8)) * more;
      const nearHead = clamp(Math.cos(head) * depth, 0, 1);
      let full = size * BRUSH * unit * (FAR + (1 - FAR) * nearHead) * smooth(life / GROW_S) * (1 - 0.72 * ret * ret);
      // A point of the ribbon is in front of the body on the near half of its hoop (depth above 0).
      const lamAt = (u: number) => head - dir * length * (1 - u);
      const point = (lam: number): [number, number] => {
        const a = Math.sin(lam), y = -Math.cos(lam) * flat;
        return [cx + r * (a * cr - y * sr), cy + r * (a * sr + y * cr)];
      };
      // Where along the ribbon (0 tail .. 1 head) to sample it: evenly, plus exactly where it
      // passes from one layer to the other (the hoop's sides, where its depth is 0) and a sliver
      // either side, so every ribbon on a hoop changes layer along the same line.
      const along = (lam: number) => 1 - (head - lam) / (dir * length);
      const sliver = SLIVER / length;
      const ss: number[] = [];
      for (let j = 0; j <= SAMPLES; j++) ss.push(j / SAMPLES);
      const lo = Math.min(head, head - dir * length), hi = Math.max(head, head - dir * length);
      for (let side = Math.ceil((lo - Math.PI / 2) / Math.PI); Math.PI / 2 + side * Math.PI < hi; side++) {
        const u = along(Math.PI / 2 + side * Math.PI);
        for (const d of [-sliver, 0, sliver]) if (u + d > 0 && u + d < 1) ss.push(u + d);
      }
      ss.sort((x, y) => x - y);
      // A sample exactly on a side belongs with the stretch after it.
      const near = ss.map((u) => Math.cos(lamAt(u) + dir * 1e-6) > 0);
      // Centre, half width, unit normal (on screen) at each sample, tail to head.
      const mid: [number, number][] = [], halfs: number[] = [], norm: [number, number][] = [], bend: number[] = [];
      for (const u of ss) {
        const lam = lamAt(u);
        // On the hoop before its roll: the ellipse's normal.
        const nx = Math.sin(lam) * flat, ny = -Math.cos(lam);
        const nl = Math.hypot(nx, ny) || 1;
        const ux = nx / nl, uy = ny / nl;
        mid.push(point(lam));
        norm.push([ux * cr - uy * sr, ux * sr + uy * cr]);
        halfs.push(0.5 + 0.5 * u);
        // How tightly the hoop curves here, as a radius: a ribbon wider than it would fold.
        const c = Math.cos(lam), sn = Math.sin(lam);
        bend.push((r * (c * c + flat * flat * sn * sn) ** 1.5) / flat);
      }
      const last = ss.length - 1;
      // Never wider than a third of its own length on screen.
      let onScreen = 0;
      for (let j = 1; j <= last; j++) onScreen += Math.hypot(mid[j][0] - mid[j - 1][0], mid[j][1] - mid[j - 1][1]);
      full = Math.min(full, 0.34 * onScreen);
      for (let j = 0; j <= last; j++) halfs[j] = Math.min(halfs[j] * (full / 2), 0.9 * bend[j]);
      const side = (j: number, sign: number): [number, number] => [mid[j][0] + sign * norm[j][0] * halfs[j], mid[j][1] + sign * norm[j][1] * halfs[j]];
      // A half circle round an end, from one edge to the other through the point ahead of it (or behind).
      const cap = (j: number, ahead: boolean): [number, number][] => {
        const o = ahead ? mid[j - 1] : mid[j + 1];
        let tx = ahead ? mid[j][0] - o[0] : o[0] - mid[j][0], ty = ahead ? mid[j][1] - o[1] : o[1] - mid[j][1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        const [nx, ny] = norm[j], h = halfs[j], out: [number, number][] = [];
        for (let c = 1; c < CAP; c++) {
          const t = (Math.PI * c) / CAP;
          // Ahead: from the + edge forward round to the - edge; behind: from the - edge back to the +.
          const e = ahead ? Math.cos(t) : -Math.cos(t), g = ahead ? Math.sin(t) : -Math.sin(t);
          out.push([mid[j][0] + (nx * e + tx * g) * h, mid[j][1] + (ny * e + ty * g) * h]);
        }
        return out;
      };
      // Runs of samples on one side, and at most a stretch long, each become a piece. Pieces overlap
      // by a sample where they meet, the one drawn first running on under the other, so no seam
      // shows: within a side the earlier piece runs on under the later; between sides the piece
      // behind the body (drawn before every piece in front) runs a sliver on under the piece in front.
      let from = 0;
      for (let j = 1; j <= last; j++) {
        const turns = j < last && near[j] !== near[from];
        if (j < last && !turns && j - from < STRETCH) continue;
        const to = j;
        const behind = !near[from];
        const end = to < last && (!turns || behind) ? to + 1 : to;
        const start = from > 0 && behind && near[from - 1] ? from - 1 : from;
        const pts: [number, number][] = [];
        for (let q = start; q <= end; q++) pts.push(side(q, 1));
        if (end === last) pts.push(...cap(last, true));
        for (let q = end; q >= start; q--) pts.push(side(q, -1));
        if (start === 0) pts.push(...cap(0, false));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        pieces.push({
          d: `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`,
          front: near[from],
          box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
          ribbon: i * LANES + l,
          along: [ss[from], ss[to]],
          from: mid[from],
          to: mid[to],
        });
        from = j;
      }
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Marks

/** One part of a mark: a fixed outline about its own centre, and where that centre is this frame. */
export interface MarkPart {
  /** Stable name of the outline, e.g. "dot". */
  shape: string;
  d: string;
  box: Box;
  /** Centre, viewBox units, then a rotation about the mark's centre (radians) and a scale about the part's own. */
  x: number;
  y: number;
  turn: number;
  scale: number;
}

const circle = (r: number) => `M${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0Z`;
const capsule = (w: number, h: number) => {
  const r = w / 2, y = h / 2 - r;
  return `M${f(-r)} ${f(-y)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-y)}L${f(r)} ${f(y)}A${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(y)}Z`;
};

/** The unit every mark is sized in: a share of the body's smaller side, within limits that read at any size. */
function markUnit(b: Bounds): number {
  return clamp(Math.min(b.maxX - b.minX, b.maxY - b.minY), 34, 78);
}

/**
 * The parts of the marks at one moment. `bang` and `dots` 0..1 are how far the body has given
 * way to each (see Pose): a mark grows in as the body goes, from the body's centre.
 * The dots take turns hopping; the exclamation mark jumps and shakes every couple of seconds.
 */
export function markParts(b: Bounds, bang: number, dots: number, seed: number, time: number, still: boolean): MarkPart[] {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const u = markUnit(b);
  const t = still ? 0 : time + noise(seed, 9) * 10;
  const parts: MarkPart[] = [];
  // A mark starts to grow just before the body is gone, so something is always on screen.
  const grown = (weight: number) => smooth((clamp(weight, 0, 1) - 0.45) / 0.55);

  const gb = grown(bang);
  if (gb > 0) {
    const barW = 0.21 * u, barH = 0.5 * u, dot = 0.115 * u, gap = 0.1 * u;
    const total = barH + gap + 2 * dot;
    // One alarm every 2.6 s: a jump, with a shake that dies away as it lands.
    const p = still ? 1 : ((t % 2.6) + 2.6) % 2.6 / 2.6;
    const alarm = p < 0.3 ? p / 0.3 : 1;
    const jump = still ? 0 : Math.sin(Math.PI * alarm);
    const turn = still ? 0 : 0.2 * Math.sin(TAU * 3 * alarm) * (1 - alarm);
    const lift = -0.09 * u * jump;
    const barY = -total / 2 + barH / 2, dotY = total / 2 - dot;
    // The dot lags the bar on the way up, so the mark stretches as it jumps.
    parts.push(
      { shape: 'bar', d: capsule(barW, barH), box: { x: -barW / 2, y: -barH / 2, w: barW, h: barH }, x: cx, y: cy + (barY + lift) * gb, turn, scale: gb },
      { shape: 'dot', d: circle(dot), box: { x: -dot, y: -dot, w: 2 * dot, h: 2 * dot }, x: cx, y: cy + (dotY + lift * 0.45) * gb, turn, scale: gb },
    );
  }

  const gd = grown(dots);
  if (gd > 0) {
    const r = 0.1 * u, step = 0.31 * u;
    for (let i = 0; i < 3; i++) {
      // Each dot hops in turn, a beat after the one before it.
      const p = still ? 0 : (((t - i * 0.17) % 1.25) + 1.25) % 1.25 / 1.25;
      const hop = p < 0.4 ? Math.sin(Math.PI * (p / 0.4)) : 0;
      parts.push({
        shape: 'dot3', d: circle(r), box: { x: -r, y: -r, w: 2 * r, h: 2 * r },
        x: cx + (i - 1) * step * gd, y: cy - 0.16 * u * hop * gd, turn: 0, scale: gd * (1 + 0.12 * hop),
      });
    }
  }
  return parts;
}

/** How much of its size the body keeps while it gives way to a mark: gone a little past half way. */
export function bodyScale(bang: number, dots: number): number {
  return 1 - smooth(clamp(bang + dots, 0, 1) / 0.55);
}
