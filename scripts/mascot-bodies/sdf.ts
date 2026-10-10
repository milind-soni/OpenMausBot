/**
 * Signed distance field for a silhouette.
 *
 * The face has to sit somewhere the body can actually hold it, so we need to ask "how far
 * is this point from the edge?" thousands of times. Rasterising once into a distance field
 * makes each of those questions an array lookup.
 *
 * Distances are exact (Felzenszwalb & Huttenlocher's squared-EDT, linear time per axis)
 * rather than an approximate chamfer pass — a wrong distance here shows up as a mascot with
 * its mouth hanging off the edge.
 */

import { FACE_BOX } from "../../src/components/cursor-face-data.ts"

export interface Sdf {
  size: number
  /** Signed distance in face-space units. Positive inside the silhouette. */
  data: Float32Array
  /** Face-space units per pixel. */
  unitsPerPixel: number
}

/** Builds the signed field: distance to the nearest outside pixel, minus the reverse. */
export function fieldFromMask(mask: Uint8Array, size: number): Sdf {
  const inside = edt(mask, size, 1)
  const outside = edt(mask, size, 0)
  const unitsPerPixel = FACE_BOX / size
  const data = new Float32Array(size * size)
  for (let i = 0; i < data.length; i++) {
    data[i] = (mask[i] ? Math.sqrt(inside[i]) : -Math.sqrt(outside[i])) * unitsPerPixel
  }
  return { size, data, unitsPerPixel }
}

/**
 * Exact squared Euclidean distance transform. Distance from every pixel to the nearest
 * pixel whose mask value differs from `target`.
 */
function edt(mask: Uint8Array, size: number, target: number): Float64Array {
  const INF = 1e20
  const grid = new Float64Array(size * size)
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] === target ? INF : 0

  const f = new Float64Array(size)
  const d = new Float64Array(size)
  const v = new Int32Array(size)
  const z = new Float64Array(size + 1)

  // Columns, then rows — the 2D transform separates into two 1D passes.
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = grid[y * size + x]
    edt1d(f, d, v, z, size)
    for (let y = 0; y < size; y++) grid[y * size + x] = d[y]
  }
  for (let y = 0; y < size; y++) {
    const row = y * size
    for (let x = 0; x < size; x++) f[x] = grid[row + x]
    edt1d(f, d, v, z, size)
    for (let x = 0; x < size; x++) grid[row + x] = d[x]
  }
  return grid
}

/** Lower envelope of parabolas — the 1D case the 2D transform is built from. */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number) {
  let k = 0
  v[0] = 0
  z[0] = -1e20
  z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dist = q - v[k]
    d[q] = dist * dist + f[v[k]]
  }
}

/** Signed distance at a face-space point. Outside the grid reads as far outside. */
export function sampleSdf(sdf: Sdf, x: number, y: number): number {
  const px = Math.round(x / sdf.unitsPerPixel)
  const py = Math.round(y / sdf.unitsPerPixel)
  if (px < 0 || py < 0 || px >= sdf.size || py >= sdf.size) return -999
  return sdf.data[py * sdf.size + px]
}

/** The largest circle that fits inside the silhouette — where a face most wants to sit. */
export function largestInscribedCircle(sdf: Sdf): { x: number; y: number; radius: number } {
  let best = -Infinity
  let bi = 0
  for (let i = 0; i < sdf.data.length; i++) {
    if (sdf.data[i] > best) {
      best = sdf.data[i]
      bi = i
    }
  }
  const py = Math.floor(bi / sdf.size)
  const px = bi - py * sdf.size
  return {
    x: (px + 0.5) * sdf.unitsPerPixel,
    y: (py + 0.5) * sdf.unitsPerPixel,
    radius: Math.max(best, 0),
  }
}
