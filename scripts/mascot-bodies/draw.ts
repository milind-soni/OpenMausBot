/**
 * Drawing toolkit for the Halloween bodies: shapes are signed distance fields built from
 * primitives with soft unions, traced at their zero contour, and fitted with smooth
 * cubics. The output is absolute `M`/`C`/`Z` path data, the subset the phone path
 * parsers accept.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

/** Signed distance: negative inside. */
export type Field = (x: number, y: number) => number
type Point = [number, number]

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t


export const circle = (cx: number, cy: number, r: number): Field => (x, y) => Math.hypot(x - cx, y - cy) - r

/** Approximate ellipse distance; its zero set is exact, which is all the tracer reads. */
export const ellipse = (cx: number, cy: number, rx: number, ry: number): Field => (x, y) => {
  const dx = x - cx
  const dy = y - cy
  const k0 = Math.hypot(dx / rx, dy / ry)
  const k1 = Math.hypot(dx / (rx * rx), dy / (ry * ry))
  return k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1
}

/** Axis-aligned rectangle with corner radius r. */
export const box = (x0: number, y0: number, x1: number, y1: number, r = 0): Field => (x, y) => {
  const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r)
  const qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Exact polygon distance (Quilez). */
export const polygon = (pts: Point[]): Field => (x, y) => {
  let d = (x - pts[0][0]) ** 2 + (y - pts[0][1]) ** 2
  let s = 1
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
    const ex = pts[j][0] - pts[i][0]
    const ey = pts[j][1] - pts[i][1]
    const wx = x - pts[i][0]
    const wy = y - pts[i][1]
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
    d = Math.min(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2)
    const c1 = y >= pts[i][1]
    const c2 = y < pts[j][1]
    const c3 = ex * wy > ey * wx
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
  }
  return s * Math.sqrt(d)
}

/** A round-jointed stroke through `[x, y, radius]` points. */
export const polyStroke = (pts: Array<[number, number, number]>): Field => (x, y) => {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay, ar] = pts[i]
    const [bx, by, br] = pts[i + 1]
    const ex = bx - ax
    const ey = by - ay
    const wx = x - ax
    const wy = y - ay
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0, 1)
    best = Math.min(best, Math.hypot(wx - ex * t, wy - ey * t) - lerp(ar, br, t))
  }
  return best
}

/** A stroke along a cubic Bézier whose radius runs from r0 to r1. */
export function stroke(p0: Point, p1: Point, p2: Point, p3: Point, r0: number, r1 = r0, steps = 40): Field {
  const pts: Array<[number, number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      lerp(r0, r1, t),
    ])
  }
  return polyStroke(pts)
}


export const union = (...fs: Field[]): Field => (x, y) => Math.min(...fs.map((f) => f(x, y)))

/** Polynomial smooth union with blend radius k. */
export const smooth = (k: number, ...fs: Field[]): Field => (x, y) => {
  let a = fs[0](x, y)
  for (let i = 1; i < fs.length; i++) {
    const b = fs[i](x, y)
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1)
    a = lerp(b, a, h) - k * h * (1 - h)
  }
  return a
}

/** `a` minus `b`, softened by k when given. */
export const subtract = (a: Field, b: Field, k = 0): Field => (x, y) => {
  const da = a(x, y)
  const db = -b(x, y)
  if (!k) return Math.max(da, db)
  const h = clamp(0.5 - (0.5 * (db - da)) / k, 0, 1)
  return lerp(db, da, h) + k * h * (1 - h)
}

export const intersect = (...fs: Field[]): Field => (x, y) => Math.max(...fs.map((f) => f(x, y)))
export const grow = (f: Field, r: number): Field => (x, y) => f(x, y) - r
/** The field plus its reflection across x = 120, the centre line of every drawing. */
export const mirror = (f: Field): Field => (x, y) => Math.min(f(x, y), f(240 - x, y))


const X0 = -24
const X1 = 264
const STEP = 0.5

function trace(f: Field): Point[][] {
  const n = Math.round((X1 - X0) / STEP) + 1
  const v = new Float64Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = f(X0 + i * STEP, X0 + j * STEP)
  const value = (i: number, j: number) => v[j * n + i]
  const pos = new Map<string, Point>()
  const next = new Map<string, string>()
  const edge = (i: number, j: number, horizontal: boolean) => {
    const key = `${horizontal ? "h" : "v"}${i},${j}`
    if (!pos.has(key)) {
      const a = value(i, j)
      const b = horizontal ? value(i + 1, j) : value(i, j + 1)
      const t = a / (a - b)
      pos.set(key, horizontal ? [X0 + (i + t) * STEP, X0 + j * STEP] : [X0 + i * STEP, X0 + (j + t) * STEP])
    }
    return key
  }
  // Segments run with the inside on the left; saddles resolve by the cell centre.
  const table: Record<number, Array<[string, string]> | ((centreInside: boolean) => Array<[string, string]>)> = {
    1: [["L", "T"]], 2: [["T", "R"]], 3: [["L", "R"]], 4: [["R", "B"]],
    5: (c) => (c ? [["L", "B"], ["R", "T"]] : [["L", "T"], ["R", "B"]]),
    6: [["T", "B"]], 7: [["L", "B"]], 8: [["B", "L"]], 9: [["B", "T"]],
    10: (c) => (c ? [["T", "L"], ["B", "R"]] : [["T", "R"], ["B", "L"]]),
    11: [["B", "R"]], 12: [["R", "L"]], 13: [["R", "T"]], 14: [["T", "L"]],
  }
  for (let j = 0; j + 1 < n; j++) {
    for (let i = 0; i + 1 < n; i++) {
      const code = (value(i, j) < 0 ? 1 : 0) | (value(i + 1, j) < 0 ? 2 : 0) | (value(i + 1, j + 1) < 0 ? 4 : 0) | (value(i, j + 1) < 0 ? 8 : 0)
      if (code === 0 || code === 15) continue
      const entry = table[code]
      const centre = (value(i, j) + value(i + 1, j) + value(i + 1, j + 1) + value(i, j + 1)) / 4 < 0
      const segments = typeof entry === "function" ? entry(centre) : entry
      const keys: Record<string, () => string> = {
        T: () => edge(i, j, true), R: () => edge(i + 1, j, false), B: () => edge(i, j + 1, true), L: () => edge(i, j, false),
      }
      for (const [from, to] of segments) next.set(keys[from](), keys[to]())
    }
  }
  const loops: Point[][] = []
  const seen = new Set<string>()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop: Point[] = []
    let key: string | undefined = start
    while (key && !seen.has(key)) {
      seen.add(key)
      loop.push(pos.get(key) as Point)
      key = next.get(key)
    }
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}


type Cubic = [Point, Point, Point, Point]
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Point, s: number): Point => [a[0] * s, a[1] * s]
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
const unit = (a: Point): Point => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const at = (q: Cubic, t: number): Point => {
  const u = 1 - t
  return add(add(mul(q[0], u * u * u), mul(q[1], 3 * u * u * t)), add(mul(q[2], 3 * u * t * t), mul(q[3], t * t * t)))
}
const d1 = (q: Cubic, t: number): Point => {
  const u = 1 - t
  return add(add(mul(sub(q[1], q[0]), 3 * u * u), mul(sub(q[2], q[1]), 6 * u * t)), mul(sub(q[3], q[2]), 3 * t * t))
}
const d2 = (q: Cubic, t: number): Point =>
  add(mul(add(sub(q[2], mul(q[1], 2)), q[0]), 6 * (1 - t)), mul(add(sub(q[3], mul(q[2], 2)), q[1]), 6 * t))

function generate(d: Point[], u: number[], t1: Point, t2: Point): Cubic {
  const p0 = d[0]
  const p3 = d[d.length - 1]
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < d.length; i++) {
    const t = u[i]
    const s = 1 - t
    const a0 = mul(t1, 3 * s * s * t)
    const a1 = mul(t2, 3 * s * t * t)
    c00 += dot(a0, a0)
    c01 += dot(a0, a1)
    c11 += dot(a1, a1)
    const tmp = sub(d[i], add(mul(p0, s * s * s + 3 * s * s * t), mul(p3, 3 * s * t * t + t * t * t)))
    x0 += dot(a0, tmp)
    x1 += dot(a1, tmp)
  }
  const det = c00 * c11 - c01 * c01
  const chord = Math.hypot(...sub(p3, p0))
  let left = det ? (x0 * c11 - x1 * c01) / det : 0
  let right = det ? (c00 * x1 - c01 * x0) / det : 0
  if (left < 1e-6 * chord || right < 1e-6 * chord) left = right = chord / 3
  return [p0, add(p0, mul(t1, left)), add(p3, mul(t2, right)), p3]
}

function fitCubic(d: Point[], t1: Point, t2: Point, err: number, out: Cubic[]): void {
  if (d.length === 2) {
    const l = Math.hypot(...sub(d[1], d[0])) / 3
    out.push([d[0], add(d[0], mul(t1, l)), add(d[1], mul(t2, l)), d[1]])
    return
  }
  const lengths = [0]
  for (let i = 1; i < d.length; i++) lengths.push(lengths[i - 1] + Math.hypot(...sub(d[i], d[i - 1])))
  let u = lengths.map((l) => l / lengths[lengths.length - 1])
  let q = generate(d, u, t1, t2)
  let worst = 0
  let split = 1
  const measure = () => {
    worst = 0
    split = Math.floor(d.length / 2)
    for (let i = 1; i < d.length - 1; i++) {
      const e = sub(at(q, u[i]), d[i])
      if (dot(e, e) > worst) {
        worst = dot(e, e)
        split = i
      }
    }
  }
  measure()
  if (worst < err * err) {
    out.push(q)
    return
  }
  if (worst < 16 * err * err) {
    for (let it = 0; it < 12; it++) {
      u = u.map((t, i) => {
        const p = sub(at(q, t), d[i])
        const q1 = d1(q, t)
        const den = dot(q1, q1) + dot(p, d2(q, t))
        return den ? clamp(t - dot(p, q1) / den, 0, 1) : t
      })
      q = generate(d, u, t1, t2)
      measure()
      if (worst < err * err) {
        out.push(q)
        return
      }
    }
  }
  const centre = unit(sub(d[split - 1], d[split + 1]))
  fitCubic(d.slice(0, split + 1), t1, centre, err, out)
  fitCubic(d.slice(split), mul(centre, -1), t2, err, out)
}

const fmt = (n: number) => String(Number(n.toFixed(2)))

/** A field's outline as cubic-only SVG path data, one subpath per closed contour. */
export function toPath(f: Field, err = 0.3): string {
  const out: string[] = []
  for (const loop of trace(f)) {
    const pts: Point[] = []
    let last: Point | null = null
    for (const p of loop) {
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) {
        pts.push(p)
        last = p
      }
    }
    if (pts.length < 6) continue
    const tangent = unit(sub(pts[1], pts[pts.length - 1]))
    const cubics: Cubic[] = []
    fitCubic([...pts, pts[0]], tangent, mul(tangent, -1), err, cubics)
    const body = cubics.map((q) => `C${fmt(q[1][0])} ${fmt(q[1][1])} ${fmt(q[2][0])} ${fmt(q[2][1])} ${fmt(q[3][0])} ${fmt(q[3][1])}`)
    out.push(`M${fmt(cubics[0][0][0])} ${fmt(cubics[0][0][1])} ${body.join(" ")} Z`)
  }
  return out.join(" ")
}
