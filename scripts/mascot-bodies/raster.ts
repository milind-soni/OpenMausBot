/**
 * Scanline rasteriser: fills a set of face-space polylines into a binary
 * mask using the non-zero winding rule — the same rule SVG uses to fill
 * `d` by default. This replaces Blob Studio's canvas-based `rasterise`
 * (draw through an `<img>`, read back pixels): the outline is already
 * known analytically here, so a scanline fill is both exact and
 * dependency-free.
 *
 * Plain TypeScript only: this module is loaded by a Node script via
 * `node --experimental-strip-types`, so no JSX and nothing beyond type
 * annotations the type-stripper can erase.
 */

import { FACE_BOX } from "../../src/components/cursor-face-data.ts"

type Point = [number, number]

interface Edge {
  /** y at the edge's topmost (lower-y) endpoint. */
  y0: number
  /** y at the edge's bottommost (higher-y) endpoint. */
  y1: number
  /** x at y0. */
  x0: number
  /** dx/dy, so x at any y in [y0, y1) is x0 + (y - y0) * slope. */
  slope: number
  /** +1 if the edge runs downward (y increasing) in the original winding, -1 if upward. */
  winding: 1 | -1
}

interface Crossing {
  x: number
  winding: 1 | -1
}

/**
 * Builds the edge table for one polyline (implicitly closed: the last point
 * connects back to the first). Horizontal edges contribute nothing to any
 * scanline crossing and are skipped, matching the standard scanline-fill
 * convention.
 */
function edgesOf(points: Point[]): Edge[] {
  const edges: Edge[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % n]
    if (ay === by) continue
    if (ay < by) {
      edges.push({ y0: ay, y1: by, x0: ax, slope: (bx - ax) / (by - ay), winding: 1 })
    } else {
      edges.push({ y0: by, y1: ay, x0: bx, slope: (ax - bx) / (ay - by), winding: -1 })
    }
  }
  return edges
}

/**
 * Fills every pixel in `row` whose centre falls within `[spanStartX,
 * spanEndX)`, clamped into `[0, size)` so a span that runs past either
 * edge of the face box clips there instead of wrapping onto the opposite
 * side of the row.
 */
function fillSpan(
  mask: Uint8Array, row: number, spanStartX: number, spanEndX: number, unitsPerPixel: number, size: number
): void {
  // Pixel px's centre is (px + 0.5) * unitsPerPixel; solve that against
  // the span bounds for the first/last px whose centre lands inside.
  const startPx = Math.max(0, Math.ceil(spanStartX / unitsPerPixel - 0.5))
  const endPx = Math.min(size - 1, Math.ceil(spanEndX / unitsPerPixel - 0.5) - 1)
  for (let px = startPx; px <= endPx; px++) mask[row + px] = 1
}

/**
 * Rasterises `polylines` (face-space coordinates, spanning `[0, FACE_BOX)`
 * on each axis) into a `size * size` mask, one byte per pixel, `1` inside
 * the fill and `0` outside, under the non-zero winding rule.
 *
 * Every polyline's edges — across every subpath — are pooled into one edge
 * table before scanning, so multiple subpaths combine correctly: a second
 * subpath wound the same way extends the fill (a disjoint lobe), while one
 * wound oppositely cuts a hole where the two overlap, exactly as SVG's
 * non-zero fill rule intends.
 *
 * Each row is sampled at the pixel centre `(py + 0.5) * unitsPerPixel`.
 * Every crossing on that row is collected with its winding direction
 * (`+1` for an edge running downward in y, `-1` for one running upward),
 * sorted by x, and walked left to right accumulating a running winding
 * total; pixels are filled while that total is non-zero. Span endpoints
 * are clamped into `[0, size)` so geometry that runs past the face box
 * clips at the edge of the mask instead of wrapping onto the opposite
 * side, which would otherwise silently corrupt the distance field the
 * next stage builds from this mask.
 */
export function maskFromPolylines(polylines: Point[][], size = 256): Uint8Array {
  const mask = new Uint8Array(size * size)
  const unitsPerPixel = FACE_BOX / size

  const edges: Edge[] = []
  for (const line of polylines) {
    if (line.length < 2) continue
    edges.push(...edgesOf(line))
  }
  if (edges.length === 0) return mask

  for (let py = 0; py < size; py++) {
    const y = (py + 0.5) * unitsPerPixel

    const crossings: Crossing[] = []
    for (const edge of edges) {
      if (y < edge.y0 || y >= edge.y1) continue
      const x = edge.x0 + (y - edge.y0) * edge.slope
      crossings.push({ x, winding: edge.winding })
    }
    if (crossings.length === 0) continue
    crossings.sort((a, b) => a.x - b.x)

    const row = py * size
    let winding = 0
    let spanStartX = 0
    for (const crossing of crossings) {
      const wasInside = winding !== 0
      winding += crossing.winding
      const isInside = winding !== 0

      if (!wasInside && isInside) {
        spanStartX = crossing.x
      } else if (wasInside && !isInside) {
        fillSpan(mask, row, spanStartX, crossing.x, unitsPerPixel, size)
      }
    }
  }

  return mask
}
