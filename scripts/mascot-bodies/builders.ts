/**
 * The ten catalog outlines, as absolute cubic path data.
 *
 * Adapted from Blob Studio's studio/src/shapes/builtin.ts at fixed parameters.
 * Cubics only, because the phone's twenty-line path parser understands `M`, `C`
 * and `Z` and nothing else — emitting anything richer here would mean growing a
 * parser on the platform least able to afford it.
 *
 * Every generated outline is one closed, non-self-intersecting subpath centred on
 * (100, 100) of a 200x200 stage, wound the same way, so its interior is
 * unambiguous under the non-zero winding rule however the later rasteriser walks
 * it. `viewBox` is advisory and must not be used to normalise — see the note on
 * the field. The `cursor` outline is the one exception to all of this: it is
 * shipped artwork, copied verbatim.
 */

export interface BodyDef {
  id: string
  name: string
  /** Absolute cubic path data: `M`, `C` and `Z` only. */
  d: string
  /**
   * `[minX, minY, width, height]` of the artwork's nominal canvas — advisory only.
   *
   * Do not normalise against this. Derive bounds by flattening the path, because
   * two of the ten deliberately disagree with their box: `cursor`'s is the original
   * artwork canvas rather than any space it is ever drawn in, and `blob`'s is padded
   * past the 200x200 stage so its lobe is not shaved off.
   */
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

/**
 * Fixed-point to five decimals, trailing zeros trimmed.
 *
 * Never exponent notation: the iOS parser is a character scanner that reads every
 * letter as a command, so a stray `e` would be taken for a curve and would
 * silently corrupt the outline.
 */
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

  /** Absolute cubic from the current point. */
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

  /**
   * One quarter of an axis-aligned ellipse, from the current point to (x, y),
   * bulging towards the corner (kx, ky) — the point where the tangents at the two
   * ends meet, i.e. the box corner the arc rounds off. Reads like `quadTo`, but
   * pulls each control point only KAPPA of the way to the corner instead of 2/3,
   * which is what makes the result a circle rather than a parabola.
   */
  quarterTo(kx: number, ky: number, x: number, y: number): Path {
    const [x0, y0] = this.at
    return this.curveTo([
      x0 + (kx - x0) * KAPPA, y0 + (ky - y0) * KAPPA,
      x + (kx - x) * KAPPA, y + (ky - y) * KAPPA,
      x, y,
    ])
  }

  /** Closes the ring, adding a straight cubic back to the start if we are not already there. */
  close(): string {
    const [x, y] = this.at
    const [sx, sy] = this.origin
    if (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9) this.lineTo(sx, sy)
    return this.parts.join("") + "Z"
  }
}

/* ------------------------------------------------------------------ builders */

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

/**
 * Blob Studio's `roundedBox`, with its quadratic corners promoted to KAPPA arcs.
 * Quadratics bulge visibly at a 75-unit radius, and the capsule's caps are meant
 * to be circles.
 */
function buildRoundedBox(w: number, h: number, radius: number): string {
  const x = 100 - w / 2
  const y = 100 - h / 2
  const k = Math.min(radius, w / 2, h / 2)
  // A cap that eats the whole side leaves a zero-length run; skip it rather than
  // emit a degenerate cubic the rasteriser would have to special-case.
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

/* ------------------------------------------------------------------ catalog */

/**
 * The shipped maus artwork, copied verbatim out of `DEFAULT_SILHOUETTE.body` in
 * src/components/CursorAvatar.tsx. It is already cubics-only, so it is carried
 * across byte-for-byte rather than regenerated — the artwork is the spec here.
 *
 * Drawn pre-transform, which is why the raw coordinates below run negative: the
 * artwork's own bbox is -83.23,-16.56 .. 238.51,368.25. The component paints it
 * under `translate(210, 80)`, then maps that into face space with the silhouette's
 * `fit` transform — `translate(-56.5564 -37.6751) scale(0.593899)` — which lands it
 * at 18.73,0 .. 209.81,228.54, flush inside `FACE_BOX` (228.541, see
 * src/components/cursor-face-data.ts). The `viewBox` below is neither of those
 * spaces: it is the artwork's nominal canvas. See the note on `BodyDef.viewBox`.
 */
const CURSOR_D = "M0 0 C1.12815992 0.94880479 2.25705591 1.89673511 3.38671875 2.84375 C5.57657936 4.68528228 7.75793952 6.53624249 9.93359375 8.39453125 C13.5602214 11.48647103 17.25022962 14.49819427 20.9453125 17.5078125 C25.41301487 21.15281776 29.86103386 24.8215994 34.31054688 28.48876953 C38.00933931 31.5370903 41.70951059 34.58367973 45.4140625 37.625 C52.50037463 43.44570076 59.55669812 49.29508834 66.54003906 55.23901367 C70.43289872 58.54377434 74.40406577 61.73568847 78.40625 64.90625 C82.05401433 67.85083084 85.6145398 70.89451533 89.18359375 73.93359375 C92.41424312 76.67774533 95.67698054 79.36747809 99 82 C103.47931906 85.54855146 107.83340036 89.22936876 112.18359375 92.93359375 C115.41424312 95.67774533 118.67698054 98.36747809 122 101 C125.9014198 104.09073517 129.71091352 107.27378506 133.5 110.5 C137.99002543 114.32092614 142.53350963 118.0537239 147.15234375 121.71875 C156.74255328 129.40144186 166.1812645 137.27326897 175.53833008 145.23754883 C179.4317456 148.54281661 183.40347641 151.73522157 187.40625 154.90625 C191.05401433 157.85083084 194.6145398 160.89451533 198.18359375 163.93359375 C201.41424312 166.67774533 204.67698054 169.36747809 208 172 C236.43637507 194.63776677 236.43637507 194.63776677 238.27050781 209.13867188 C239.19944445 221.27193361 237.57124038 231.13444436 230 241 C223.66050278 247.82715086 215.75482398 254.47140646 206.04764748 255.13307858 C205.3615811 255.13693349 204.67551472 255.1407884 203.96865845 255.14476013 C203.17563324 255.15165863 202.38260803 255.15855713 201.56555176 255.16566467 C200.27360901 255.16958473 200.27360901 255.16958473 198.95556641 255.17358398 C198.04112762 255.180271 197.12668884 255.18695801 196.18453979 255.19384766 C194.19843498 255.20789156 192.21231409 255.21978771 190.22618484 255.22979546 C187.07149762 255.24625057 183.91692738 255.26949556 180.76229858 255.29469299 C171.79227585 255.36530712 162.82220292 255.42526708 153.85205078 255.47680664 C148.36195434 255.5088283 142.87198905 255.55017011 137.38199997 255.59700203 C135.30028042 255.61289593 133.21853066 255.62527474 131.13676834 255.63390923 C104.46972494 255.74602279 80.75351522 259.19455182 60.52978516 278.41845703 C55.75259196 283.35727885 51.81217213 289.04473423 47.77441406 294.5859375 C44.62107661 298.87600364 41.36381878 303.08685058 38.125 307.3125 C32.82026548 314.26649347 27.55386673 321.24815866 22.3125 328.25 C21.07690581 329.89589556 19.84122979 331.5417297 18.60546875 333.1875 C16.22002164 336.36552908 13.84996009 339.55428087 11.48828125 342.75 C3.0450311 354.10095576 -5.25712203 365.22607871 -20 368 C-33.42903027 368.85957067 -44.2929604 367.90032788 -55 358.9140625 C-63.51513963 350.76480778 -67.79688328 340.99527428 -68.37686157 329.29350281 C-68.43541887 328.1487851 -68.49397617 327.00406738 -68.55430794 325.82466125 C-68.61453573 324.57243271 -68.67476353 323.32020416 -68.73681641 322.0300293 C-68.80423726 320.68369989 -68.87198477 319.33738681 -68.94003105 317.99108887 C-69.12569162 314.29881586 -69.30666938 310.60632592 -69.48688698 306.91378379 C-69.68142908 302.94481208 -69.88036562 298.97606035 -70.07873535 295.00727844 C-70.55465828 285.46711948 -71.02377004 275.92663022 -71.49235249 266.3861084 C-71.71278092 261.90166682 -71.93398876 257.41726373 -72.1552124 252.93286133 C-72.22122149 251.59460763 -72.22122149 251.59460763 -72.28856409 250.2293185 C-72.37783973 248.41936974 -72.46711776 246.6094211 -72.55639815 244.79947257 C-72.7821203 240.22326204 -73.00777832 235.64704836 -73.23336792 231.0708313 C-73.2783997 230.15734865 -73.32343148 229.24386601 -73.36982787 228.30270207 C-73.64581049 222.70253299 -73.92113412 217.10233189 -74.19602597 211.50210917 C-75.35713101 187.85146938 -76.54638525 164.20245932 -77.76320994 140.55462319 C-78.3174362 129.77404232 -78.86176258 118.9929594 -79.40472984 108.2118063 C-79.83986282 99.58021501 -80.28322749 90.94912395 -80.73695588 82.31848997 C-81.04621068 76.42094211 -81.34513355 70.52292566 -81.63612723 64.62444884 C-81.8031421 61.24551841 -81.97612174 57.86718776 -82.15861511 54.48903847 C-84.29931862 14.73242483 -84.29931862 14.73242483 -72.03125 -1.625 C-50.89854752 -24.96559677 -21.34867451 -18.24899383 0 0 Z "

/** Ten outlines, in the order the catalog persists them. `cursor` is the default, so it leads. */
export const BODY_DEFS: BodyDef[] = [
  { id: "cursor", name: "Cursor", d: CURSOR_D, viewBox: [0, 0, 512, 512] },
  // The wobble pushes lobes past the nominal 200x200 stage — its radius factor peaks at
  // 1.042, so the outline reaches 4.2 units outside. Its box is padded to hold that: a
  // 200x200 viewBox here would let the scanline pass silently shave the top lobe flat.
  { id: "blob", name: "Blob", d: buildBlob(200, 200, 0.35), viewBox: [-5, -5, 210, 210] },
  { id: "circle", name: "Circle", d: buildEllipse(200, 200), viewBox: [0, 0, 200, 200] },
  { id: "squircle", name: "Squircle", d: buildRoundedBox(200, 200, (Math.min(200, 200) / 2) * 0.5), viewBox: [0, 0, 200, 200] },
  { id: "capsule", name: "Capsule", d: buildRoundedBox(150, 200, Math.min(150, 200) / 2), viewBox: [0, 0, 200, 200] },
  { id: "drop", name: "Drop", d: buildDrop(156, 194, 0.62), viewBox: [0, 0, 200, 200] },
  { id: "shield", name: "Shield", d: buildCone(190, 200, 0.45, 0.9), viewBox: [0, 0, 200, 200] },
  { id: "hexagon", name: "Hexagon", d: buildPolygon(196, 196, 6, 0.12), viewBox: [0, 0, 200, 200] },
  { id: "diamond", name: "Diamond", d: buildPolygon(196, 196, 4, 0.12), viewBox: [0, 0, 200, 200] },
  // The inner-radius factor is a face-fit constraint, not a taste knob: at the classic
  // 0.42 the notches between the points pinch the silhouette down to a 50-unit inscribed
  // circle, and since the catalog clamps every body to the smallest face any one body can
  // hold, that one number would shrink the mascot everywhere. 0.55 lets the star hold a
  // 0.831 face — clear headroom over the cursor's 0.791, which is what sets the clamp.
  { id: "star", name: "Star", d: buildStar(196, 196, 5, 0.55), viewBox: [0, 0, 200, 200] },
]

export const BODY_IDS: string[] = BODY_DEFS.map(s => s.id)
