/**
 * Flattening, bounds measurement and the fit transform that maps a shape's
 * drawn extent into the mascot's face box.
 *
 * Plain TypeScript only: this module is loaded by a Node script via
 * `node --experimental-strip-types`, so no JSX and nothing beyond type
 * annotations that the type-stripper can erase.
 */

import { FACE_BOX } from "../../src/components/cursor-face-data.ts"

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type Point = [number, number]

/* -------------------------------------------------------------- tokeniser */

/**
 * Scans a path's numbers exactly like the iOS parser: an optional leading
 * `-`, digits, an optional `.` and more digits, and nothing else — no
 * exponent notation, because a stray `e` would otherwise be read as a
 * command letter by a scanner this dumb.
 */
function tokenizeNumbers(s: string): number[] {
  const re = /-?\d+(?:\.\d+)?/g
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out.push(Number(m[0]))
  return out
}

/** Splits `d` into a sequence of `{ command, args }` runs on M / C / Z. */
function tokenizeCommands(d: string): { command: string; args: number[] }[] {
  const commands: { command: string; args: number[] }[] = []
  const re = /([MCZ])([^MCZ]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d)) !== null) {
    const command = m[1]
    const args = tokenizeNumbers(m[2])
    commands.push({ command, args })
  }
  return commands
}

/* ---------------------------------------------------------------- flatten */

/** Perpendicular distance from `p` to the line through `a`/`b`. */
function pointLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1])
  // |cross product| / |base|
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len
}

/**
 * Adaptively subdivides a cubic until the interior points are all within
 * `tolerance` of the chord from p0 to p3, appending sampled points
 * (excluding p0, which the caller already has) to `out`.
 */
function subdivideCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number, out: Point[], depth = 0
): void {
  // Flatness test: distance of both control points from the chord.
  const d1 = pointLineDistance(p1, p0, p3)
  const d2 = pointLineDistance(p2, p0, p3)
  if ((d1 + d2) < tolerance || depth > 24) {
    out.push(p3)
    return
  }
  // De Casteljau split at t = 0.5.
  const p01: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
  const p12: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
  const p23: Point = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2]
  const p012: Point = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2]
  const p123: Point = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2]
  const mid: Point = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2]
  subdivideCubic(p0, p01, p012, mid, tolerance, out, depth + 1)
  subdivideCubic(mid, p123, p23, p3, tolerance, out, depth + 1)
}

/**
 * Flattens absolute-cubic path data (`M`, `C`, `Z` only) into one polyline
 * per subpath, sampling each cubic adaptively until the chord deviates from
 * the true curve by less than `tolerance` artwork units.
 */
export function flatten(d: string, tolerance = 0.05): Point[][] {
  const commands = tokenizeCommands(d)
  const polylines: Point[][] = []
  let current: Point[] = []
  let at: Point = [0, 0]
  let start: Point = [0, 0]

  for (const { command, args } of commands) {
    if (command === "M") {
      if (current.length > 0) polylines.push(current)
      const x = args[0]
      const y = args[1]
      at = [x, y]
      start = [x, y]
      current = [at]
    } else if (command === "C") {
      for (let i = 0; i + 5 < args.length; i += 6) {
        const p1: Point = [args[i], args[i + 1]]
        const p2: Point = [args[i + 2], args[i + 3]]
        const p3: Point = [args[i + 4], args[i + 5]]
        subdivideCubic(at, p1, p2, p3, tolerance, current)
        at = p3
      }
    } else if (command === "Z") {
      // Close back to the subpath's start if not already there.
      if (Math.abs(at[0] - start[0]) > 1e-9 || Math.abs(at[1] - start[1]) > 1e-9) {
        current.push(start)
        at = start
      }
    }
  }
  if (current.length > 0) polylines.push(current)
  return polylines
}

/* ------------------------------------------------------------------ bounds */

/** Min/max over every point of every polyline. */
export function boundsOf(polylines: Point[][]): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const line of polylines) {
    for (const [x, y] of line) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

/* ------------------------------------------------------------- fit transform */

/** Rounds to `digits` decimal places (not fixed-point string formatting). */
function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * Scales the drawn bounds to fill `FACE_BOX` on their tighter axis, then
 * centres the shape on the other axis — the same mapping as Blob Studio's
 * `measureFit`. Returns both the emitted transform string (in the format the
 * renderer already parses, `translate(<tx> <ty>) scale(<scale>)`) and the
 * rounded numeric components, so a caller can reproduce exactly what the
 * string encodes.
 */
export function fitTransform(bounds: Bounds): { transform: string; scale: number; tx: number; ty: number } {
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const rawScale = FACE_BOX / Math.max(width, height)
  const scale = round(rawScale, 6)
  const tx = round(-bounds.minX * scale + (FACE_BOX - width * scale) / 2, 4)
  const ty = round(-bounds.minY * scale + (FACE_BOX - height * scale) / 2, 4)
  const transform = `translate(${tx} ${ty}) scale(${scale})`
  return { transform, scale, tx, ty }
}

/** Maps every point through `[x * scale + tx, y * scale + ty]`. */
export function applyFit(
  polylines: Point[][], fit: { scale: number; tx: number; ty: number }
): Point[][] {
  return polylines.map(line => line.map(([x, y]): Point => [x * fit.scale + fit.tx, y * fit.scale + fit.ty]))
}
