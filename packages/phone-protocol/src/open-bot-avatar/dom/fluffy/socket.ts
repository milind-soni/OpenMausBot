/**
 * Fluffy eyes are beads seated in sockets pressed into the coat. A socket follows its eye's
 * contour through every shape the eye takes, so the shader reads the contour as a small
 * distance field: one square tile per eye, re-made only when the contour changes.
 */
import type { EyeMark } from '../../render.ts';
import { eyeBox, paintEye } from '../eye.ts';

/** Width and height of a tile, pixels. */
export const SOCKET_TILE = 96;
/** How far around an eye the coat is pressed down, viewBox units. Also the range of the distance field. */
export const SOCKET_PAD = 3.8;

/** The share of a bead's height that shows: an open bead is partly buried, a shallower expression keeps its arc. */
export function exposedHeight(w: number, h: number): number {
  const openness = Math.max(0, Math.min(1, h / w - 1));
  return 0.8 - 0.175 * openness;
}

/** Where a socket sits around its eye: the eye's center and size, and the width of the square its tile covers. */
export interface SocketRegion {
  cx: number;
  cy: number;
  w: number;
  h: number;
  span: number;
}

function regionOf(mark: EyeMark): SocketRegion {
  const { x, y, w, h } = eyeBox(mark);
  return { cx: x + w / 2, cy: y + h / 2, w, h, span: Math.max(w, h) + 2 * SOCKET_PAD };
}

// An outline's box is parsed from its path, and an eye holds one outline for many frames.
const outlineRegions = new Map<string, SocketRegion>();

export function socketRegion(mark: EyeMark): SocketRegion {
  if (mark.shape === 'pill') return regionOf(mark);
  const key = socketKey(mark);
  let region = outlineRegions.get(key);
  if (!region) {
    region = regionOf(mark);
    if (outlineRegions.size >= 16) outlineRegions.clear();
    outlineRegions.set(key, region);
  }
  return region;
}

/**
 * What a tile depends on: the eye's contour, wherever it is. A pill is the same contour at both
 * eyes; other marks are outlines in face coordinates, one per eye.
 */
export function socketKey(mark: EyeMark): string {
  if (mark.shape === 'pill') return `${mark.width}|${mark.height}|${mark.radius}`;
  return mark.shape === 'arc' ? `${mark.strokeWidth}|${mark.d}` : mark.d;
}

/**
 * Signed distance to the eye's seated contour, in units of 2 × SOCKET_PAD around 0.5 (inside is
 * below), one byte per pixel. `ctx` is a scratch canvas of SOCKET_TILE pixels.
 */
export function socketTile(ctx: CanvasRenderingContext2D, mark: EyeMark): Uint8Array<ArrayBuffer> {
  const size = SOCKET_TILE;
  const { cx, cy, span, w, h } = socketRegion(mark);
  const scale = size / span;
  const exposure = exposedHeight(w, h);
  ctx.resetTransform();
  ctx.clearRect(0, 0, size, size);
  ctx.setTransform(scale, 0, 0, scale, size / 2 - cx * scale, size / 2 - cy * scale);
  ctx.lineCap = 'round';
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  // The surrounding nap hides a little of the top and bottom of the bead.
  ctx.translate(cx, cy);
  ctx.scale(1, exposure);
  ctx.translate(-cx, -cy);
  paintEye(ctx, mark);
  const rgba = ctx.getImageData(0, 0, size, size).data;

  // Round out the straight sides of the stadium into a soft bead profile, and apply the same
  // continuous warp to the contours between expressions.
  const coverage = new Uint8Array(size * size);
  const cap = Math.min(1, w / h);
  for (let y = 0; y < size; y++) {
    const v = Math.min(0.9999, Math.abs((y + 0.5 - size / 2) / ((scale * h * exposure) / 2)));
    const capY = Math.max(0, (v - 1 + cap) / cap);
    const stadium = Math.sqrt(1 - capY * capY);
    const oval = Math.pow(1 - Math.pow(v, 2.2), 1 / 2.2);
    const taper = h > w ? Math.min(1, oval / stadium) : 1;
    // A slight cant in the seated oval is most visible on an open eye.
    const cant = 0.04 * Math.max(0, 1 - cap) * (y + 0.5 - size / 2);
    for (let x = 0; x < size; x++) {
      const source = (x + 0.5 - size / 2 - cant) / taper + size / 2 - 0.5;
      const i = Math.floor(source);
      if (i < 0 || i + 1 >= size) continue;
      const offset = 4 * (y * size + i) + 3;
      coverage[y * size + x] = Math.round(rgba[offset] + (rgba[offset + 4] - rgba[offset]) * (source - i));
    }
  }

  // Start on each side of the antialiased boundary, then sweep the distance out both ways.
  const distance = new Float32Array(size * size).fill(size);
  for (let i = size + 1; i < distance.length - size - 1; i++) {
    const a = coverage[i] / 255;
    const inside = a >= 0.5;
    if (
      (a > 0 && a < 1) ||
      (coverage[i - 1] >= 128) !== inside || (coverage[i + 1] >= 128) !== inside ||
      (coverage[i - size] >= 128) !== inside || (coverage[i + size] >= 128) !== inside
    ) {
      distance[i] = Math.abs(a - 0.5);
    }
  }
  for (const step of [1, -1]) {
    for (let j = 1; j < size - 1; j++) for (let k = 1; k < size - 1; k++) {
      const i = step === 1 ? j * size + k : (size - 1 - j) * size + size - 1 - k;
      const prev = i - size * step;
      distance[i] = Math.min(distance[i], distance[i - step] + 1, distance[prev] + 1, distance[prev - 1] + Math.SQRT2, distance[prev + 1] + Math.SQRT2);
    }
  }
  const tile = new Uint8Array(distance.length);
  for (let i = 0; i < tile.length; i++) {
    const signed = ((coverage[i] >= 128 ? -1 : 1) * distance[i]) / scale;
    tile[i] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + signed / (2 * SOCKET_PAD))));
  }
  return tile;
}
