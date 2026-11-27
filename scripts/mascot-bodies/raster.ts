/**
 * Scanline rasteriser: fills face-space polylines into a binary mask under the
 * non-zero winding rule, SVG's default fill. Loaded by
 * `node --experimental-strip-types`, so only erasable type syntax.
 */

import { FACE_BOX } from "../../src/components/cursor-face-data.ts"

type Point = [number, number]

interface Edge {
  /** y at the edge's topmost (lower-y) endpoint. */
  y0: number
  /** y at the edge's bottommost (higher-y) endpoint. */
  y1: number
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

/** The polyline is implicitly closed; horizontal edges cross no scanline and are skipped. */
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

/** Clamped into `[0, size)`, so a span past the face box clips instead of
 * wrapping onto the other side of the row. */
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
 * One byte per pixel, `1` inside. Edges from every subpath are pooled, so a
 * same-wound subpath extends the fill and an opposite one cuts a hole. Rows are
 * sampled at pixel centres.
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
