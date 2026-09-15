import { MASCOT_BODIES, type MascotBodyId } from "../../shared/mascot-bodies";
import { MASCOT_MOTION_POINTS } from "../../shared/mascot-motion-points";
import { FACE_CENTRE, type Ring } from "./cursor-face-data";

const SPHERE_C = 114.2705;
const SPHERE_R = 105;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
type Anchor = { x: number; y: number; scale: number };
export type Projection = { x: number; y: number; sx: number; sy: number; cx: number; cy: number; visible: boolean };
export type FacePart = { points: Ring; projection: Projection; padding?: number };

/** Keep perspective and back-face visibility independent of the silhouette correction. */
export function projectFace(cx: number, cy: number, radians: number, gx: number, gy: number, sx = 1, sy = 1): Projection {
  const base = Math.asin(clamp((cx - SPHERE_C) / SPHERE_R, -1, 1));
  const longitude = base + radians;
  const depth = Math.cos(longitude);
  return {
    x: SPHERE_C + SPHERE_R * Math.sin(longitude) + gx, y: cy + gy,
    sx: clamp(Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02) * sx, 0.02, 2.4),
    sy: clamp(sy, 0.02, 2.4), cx, cy, visible: depth > 0.02,
  };
}

export function mouthPoints(frame: { x: number; y: number; angle: number }, spec: number[]): Ring {
  return Array.from({ length: 17 }, (_, i) => {
    const t = i / 16, x = (2 * t - 1) * spec[0], y = 2 * (1 - t) * t * spec[1];
    return [frame.x + x * Math.cos(frame.angle) - y * Math.sin(frame.angle),
      frame.y + x * Math.sin(frame.angle) + y * Math.cos(frame.angle)];
  });
}

type Edge = { slope: number; offset: number };
type Slice = { bottom: number; top: number; left: Edge; right: Edge };
export type FaceBounds = Slice[];
const at = (edge: Edge, y: number) => edge.slope * y + edge.offset;

/** Exact horizontal sections of the existing 96-point contour; no SVG parsing. */
export function createFaceBounds(points: readonly number[], centreX: number): FaceBounds {
  const levels = [...new Set(points.filter((_, i) => i % 2 === 1))].sort((a, b) => a - b);
  const slices: FaceBounds = [];
  for (let level = 1; level < levels.length; level++) {
    const bottom = levels[level - 1], top = levels[level], y = (bottom + top) / 2;
    const edges: Edge[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const j = (i + 2) % points.length;
      if ((points[i + 1] > y) === (points[j + 1] > y)) continue;
      const slope = (points[j] - points[i]) / (points[j + 1] - points[i + 1]);
      edges.push({ slope, offset: points[i] - slope * points[i + 1] });
    }
    edges.sort((a, b) => at(a, y) - at(b, y));
    let pair = 0, distance = Infinity;
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const next = Math.abs(clamp(centreX, at(edges[i], y), at(edges[i + 1], y)) - centreX);
      if (next < distance) { pair = i; distance = next; }
    }
    if (edges.length >= 2) slices.push({ bottom, top, left: edges[pair], right: edges[pair + 1] });
  }
  return slices;
}

const catalogBounds = new Map<MascotBodyId, FaceBounds>();
export function getFaceBounds(id: MascotBodyId): FaceBounds {
  let bounds = catalogBounds.get(id);
  if (!bounds) {
    bounds = createFaceBounds(MASCOT_MOTION_POINTS[id], MASCOT_BODIES[id].anchor.x);
    catalogBounds.set(id, bounds);
  }
  return bounds;
}

/** Conservative span over a point's clearance band, including concave corners. */
function span(bounds: FaceBounds, y: number, pad: number): [number, number] {
  const bottom = y - pad, top = y + pad;
  if (bottom < bounds[0].bottom || top > bounds[bounds.length - 1].top) return [Infinity, -Infinity];
  let lo = 0, hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[mid].top < bottom) lo = mid + 1; else hi = mid;
  }
  let left = -Infinity, right = Infinity;
  for (let i = lo; i < bounds.length && bounds[i].bottom <= top; i++) {
    const slice = bounds[i], a = Math.max(bottom, slice.bottom), b = Math.min(top, slice.top);
    left = Math.max(left, at(slice.left, a) + pad, at(slice.left, b) + pad);
    right = Math.min(right, at(slice.right, a) - pad, at(slice.right, b) - pad);
  }
  return [left, right];
}

/** One translation for the whole visible face: eyes cannot converge independently. */
export function containFace(parts: FacePart[], bounds: FaceBounds, anchor: Anchor): [number, number] {
  if (!parts.some(part => part.projection.visible)) return [0, 0];
  const points: [number, number, number][] = [];
  for (const { points: ring, projection: p, padding = 0 } of parts) {
    // Retain the occluded eye's footprint: removing its constraint at the
    // hemisphere boundary would abruptly move the eye that is still visible.
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i], next = ring[(i + 1) % ring.length];
      // An eye segment can cross a concave corner even with both ends inside.
      const steps = Math.max(1, Math.ceil(Math.hypot((next[0] - x) * p.sx, (next[1] - y) * p.sy) * anchor.scale));
      for (let step = 0; step < steps; step++) points.push([
        anchor.x + (p.x + (x + (next[0] - x) * step / steps - p.cx) * p.sx - FACE_CENTRE[0]) * anchor.scale,
        anchor.y + (p.y + (y + (next[1] - y) * step / steps - p.cy) * p.sy - FACE_CENTRE[1]) * anchor.scale,
        // Cover contour sampling/rounding, segment interiors and mouth stroke.
        1.5 + padding * Math.max(p.sx, p.sy) * anchor.scale,
      ]);
    }
  }
  if (!points.length || !bounds.length) return [0, 0];
  const horizontal = (dy: number): number | null => {
    let left = -Infinity, right = Infinity;
    for (const [x, y, pad] of points) {
      const [a, b] = span(bounds, y + dy, pad);
      left = Math.max(left, a - x); right = Math.min(right, b - x);
      if (left > right) return null;
    }
    return clamp(0, left, right);
  };
  const dx = horizontal(0);
  if (dx !== null) return [dx / anchor.scale, 0];

  // A tall expression may need to move vertically as well. Find the nearest
  // feasible band, then refine its boundary so slow motion does not step by pixels.
  for (let distance = 1; distance <= 228; distance++) {
    for (const direction of [-1, 1]) {
      let dy = distance * direction;
      const x = horizontal(dy);
      if (x === null) continue;
      let near = (distance - 1) * direction, far = dy;
      for (let i = 0; i < 12; i++) {
        const middle = (near + far) / 2;
        if (horizontal(middle) === null) near = middle; else far = middle;
      }
      dy = far;
      return [(horizontal(dy) ?? x) / anchor.scale, dy / anchor.scale];
    }
  }
  // An explicitly oversized custom face may not fit anywhere. Keep its authored
  // scale and the SVG clip instead of changing perspective or hiding a front eye.
  return [0, 0];
}
