/**
 * The ten catalog outlines, as absolute cubic path data. Adapted from Blob
 * Studio's studio/src/shapes/builtin.ts at fixed parameters. Cubics only: the
 * phone's path parser understands `M`, `C` and `Z` and nothing else.
 */

export interface BodyDef {
  id: string
  name: string
  /** Absolute cubic path data: `M`, `C` and `Z` only. */
  d: string
  /** `[minX, minY, width, height]` of the nominal canvas, advisory only:
   * `blob`'s is padded, so
   * bounds come from flattening the path. */
  viewBox: [number, number, number, number]
}

type Sextet = [number, number, number, number, number, number]

/** Quadratic control point to its exact cubic pair. */
function quadToCubic(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number
): Sextet {
  return [
    x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0),
    x1 + (2 / 3) * (cx - x1), y1 + (2 / 3) * (cy - y1),
    x1, y1,
  ]
}

/** A straight run as a degenerate cubic, so the emitted path stays cubics-only. */
function lineToCubic(x0: number, y0: number, x1: number, y1: number): Sextet {
  return [
    x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3,
    x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3,
    x1, y1,
  ]
}

/** Circular-arc magic number: four cubics approximate a circle to ~0.02%. */
const KAPPA = 0.5522847498307936

/** Fixed-point, never exponent notation: the iOS parser reads every letter as a
 * command, so a stray `e` would corrupt the outline. */
function fmt(n: number): string {
  let s = n.toFixed(5)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  return s === "-0" ? "0" : s
}

/** Accumulates `M`/`C`/`Z`, closing the ring with a real cubic rather than leaning on `Z`. */
class Path {
  private parts: string[] = []
  private origin: [number, number] = [0, 0]
  private at: [number, number] = [0, 0]

  moveTo(x: number, y: number): Path {
    this.parts.push("M" + fmt(x) + " " + fmt(y))
    this.origin = [x, y]
    this.at = [x, y]
    return this
  }

  curveTo(c: Sextet): Path {
    this.parts.push("C" + c.map(fmt).join(" "))
    this.at = [c[4], c[5]]
    return this
  }

  lineTo(x: number, y: number): Path {
    return this.curveTo(lineToCubic(this.at[0], this.at[1], x, y))
  }

  quadTo(cx: number, cy: number, x: number, y: number): Path {
    return this.curveTo(quadToCubic(this.at[0], this.at[1], cx, cy, x, y))
  }

  /** A quarter ellipse to (x, y), bulging towards the box corner (kx, ky). Control
   * points go KAPPA of the way to the corner, not 2/3: a circle, not a parabola. */
  quarterTo(kx: number, ky: number, x: number, y: number): Path {
    const [x0, y0] = this.at
    return this.curveTo([
      x0 + (kx - x0) * KAPPA, y0 + (ky - y0) * KAPPA,
      x + (kx - x) * KAPPA, y + (ky - y) * KAPPA,
      x, y,
    ])
  }

  close(): string {
    const [x, y] = this.at
    const [sx, sy] = this.origin
    if (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9) this.lineTo(sx, sy)
    return this.parts.join("") + "Z"
  }
}


/** Blob Studio's `circle`, as four KAPPA quarters instead of two `A` halves. */
function buildEllipse(w: number, h: number): string {
  const rx = w / 2
  const ry = h / 2
  return new Path()
    .moveTo(100 + rx, 100)
    .quarterTo(100 + rx, 100 + ry, 100, 100 + ry)
    .quarterTo(100 - rx, 100 + ry, 100 - rx, 100)
    .quarterTo(100 - rx, 100 - ry, 100, 100 - ry)
    .quarterTo(100 + rx, 100 - ry, 100 + rx, 100)
    .close()
}

/** Blob Studio's `roundedBox`, with its quadratic corners promoted to KAPPA arcs:
 * quadratics bulge visibly at a 75-unit radius. */
function buildRoundedBox(w: number, h: number, radius: number): string {
  const x = 100 - w / 2
  const y = 100 - h / 2
  const k = Math.min(radius, w / 2, h / 2)
  // A cap that eats the whole side leaves a zero-length run: skip it.
  const wide = w - 2 * k > 1e-9
  const tall = h - 2 * k > 1e-9
  const p = new Path().moveTo(x + k, y)
  if (wide) p.lineTo(x + w - k, y)
  p.quarterTo(x + w, y, x + w, y + k)
  if (tall) p.lineTo(x + w, y + h - k)
  p.quarterTo(x + w, y + h, x + w - k, y + h)
  if (wide) p.lineTo(x + k, y + h)
  p.quarterTo(x, y + h, x, y + h - k)
  if (tall) p.lineTo(x, y + k)
  p.quarterTo(x, y, x + k, y)
  return p.close()
}

/**
 * Blob Studio's `blob`: a circle whose radius breathes around the turn, drawn as
 * quadratics through the midpoints between successive samples. Each quadratic
 * becomes its exact cubic, so the curve is unchanged, not re-fitted.
 */
function buildBlob(w: number, h: number, wobble: number): string {
  const STEPS = 24
  const pts: [number, number][] = []
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2
    const r = 1 + Math.sin(a * 3 + 0.6) * 0.07 * wobble + Math.sin(a * 2 - 1.1) * 0.05 * wobble
    pts.push([100 + Math.cos(a) * (w / 2) * r, 100 + Math.sin(a) * (h / 2) * r])
  }
  const mid = (i: number): [number, number] => {
    const c = pts[i]
    const n = pts[(i + 1) % STEPS]
    return [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2]
  }
  const p = new Path().moveTo(mid(0)[0], mid(0)[1])
  for (let i = 1; i < STEPS; i++) {
    const m = mid(i)
    p.quadTo(pts[i][0], pts[i][1], m[0], m[1])
  }
  const first = mid(0)
  p.quadTo(pts[0][0], pts[0][1], first[0], first[1])
  return p.close()
}

/**
 * Blob Studio's `drop`. Its two `C` segments carry over untouched; its one `A`
 * — a semicircle of radius `hw` across the bottom — becomes two KAPPA quarters.
 */
function buildDrop(w: number, h: number, belly: number): string {
  const hw = w / 2
  const top = 100 - h / 2
  const b = h * (0.3 + belly * 0.35)
  const waist = 100 + h / 2 - hw
  return new Path()
    .moveTo(100, top)
    .curveTo([100 + hw * 0.78, top + b * 0.75, 100 + hw, top + b, 100 + hw, waist])
    .quarterTo(100 + hw, waist + hw, 100, waist + hw)
    .quarterTo(100 - hw, waist + hw, 100 - hw, waist)
    .curveTo([100 - hw, top + b, 100 - hw * 0.78, top + b * 0.75, 100, top])
    .close()
}

/** Blob Studio's `cone`: quadratics via `quadToCubic`, straight runs via `lineToCubic`. */
function buildCone(w: number, h: number, tip: number, base: number): string {
  const hw = w / 2
  const hh = h / 2
  const t = hw * tip
  const b = hw * base * 0.55
  return new Path()
    .moveTo(100 - t, 100 - hh + t * 0.9)
    .quadTo(100, 100 - hh, 100 + t, 100 - hh + t * 0.9)
    .lineTo(100 + hw - b * 0.4, 100 + hh - b)
    .quadTo(100 + hw, 100 + hh, 100 + hw - b, 100 + hh)
    .lineTo(100 - hw + b, 100 + hh)
    .quadTo(100 - hw, 100 + hh, 100 - hw + b * 0.4, 100 + hh - b)
    .close()
}

const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
]

/** Blob Studio's `hex`: each vertex cut back along both its edges and arced across. */
function buildPolygon(w: number, h: number, sides: number, round: number): string {
  const n = Math.max(3, Math.round(sides))
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    pts.push([100 + Math.cos(a) * (w / 2), 100 + Math.sin(a) * (h / 2)])
  }
  const p = new Path()
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    const a = lerp(cur, prev, round * 0.5)
    const b = lerp(cur, next, round * 0.5)
    if (i === 0) p.moveTo(a[0], a[1])
    else p.lineTo(a[0], a[1])
    p.quadTo(cur[0], cur[1], b[0], b[1])
  }
  return p.close()
}

/** Blob Studio's `star`. It emits only lines, so every edge is a `lineToCubic`. */
function buildStar(w: number, h: number, points: number, inner: number): string {
  const n = Math.max(3, Math.round(points))
  const p = new Path()
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2
    const k = i % 2 === 0 ? 1 : inner
    const x = 100 + Math.cos(a) * (w / 2) * k
    const y = 100 + Math.sin(a) * (h / 2) * k
    if (i === 0) p.moveTo(x, y)
    else p.lineTo(x, y)
  }
  return p.close()
}


export const BODY_DEFS: BodyDef[] = [
  { id: "cursor", name: "Squircle", d: buildRoundedBox(200, 200, 50), viewBox: [0, 0, 200, 200] },
  // The wobble reaches 4.2 units past the 200x200 stage, so its box is padded:
  // a 200x200 viewBox would let the scanline pass shave the top lobe flat.
  { id: "blob", name: "Blob", d: buildBlob(200, 200, 0.35), viewBox: [-5, -5, 210, 210] },
  { id: "circle", name: "Circle", d: buildEllipse(200, 200), viewBox: [0, 0, 200, 200] },
  { id: "squircle", name: "Squircle", d: buildRoundedBox(200, 200, (Math.min(200, 200) / 2) * 0.5), viewBox: [0, 0, 200, 200] },
  { id: "capsule", name: "Capsule", d: buildRoundedBox(150, 200, Math.min(150, 200) / 2), viewBox: [0, 0, 200, 200] },
  { id: "drop", name: "Drop", d: buildDrop(156, 194, 0.62), viewBox: [0, 0, 200, 200] },
  { id: "shield", name: "Shield", d: buildCone(190, 200, 0.45, 0.9), viewBox: [0, 0, 200, 200] },
  { id: "hexagon", name: "Hexagon", d: buildPolygon(196, 196, 6, 0.12), viewBox: [0, 0, 200, 200] },
  { id: "diamond", name: "Diamond", d: buildPolygon(196, 196, 4, 0.12), viewBox: [0, 0, 200, 200] },
  // A face-fit constraint, not taste: at the classic 0.42 the notches pinch the
  // star to a 50-unit inscribed circle, and the smallest face clamps every body.
  { id: "star", name: "Star", d: buildStar(196, 196, 5, 0.55), viewBox: [0, 0, 200, 200] },
]

export const BODY_IDS: string[] = BODY_DEFS.map(s => s.id)
