/**
 * The fluffy body as a triangle mesh: surface nets over the union of the avatar's parts. One vertex
 * per boundary cell gives a closed surface, including the backs of ears and the walls of holes.
 * Hair roots are scattered over it by area, and the front around the eyes is refined so a socket
 * and its bead keep their shape in profile.
 *
 * Building a mesh takes tens of milliseconds, so the renderer keeps what it builds (see renderer.ts).
 */
import { EdgeIndex } from '../../distance.ts';
import { edgeBands, type Bounds } from '../../path.ts';
import { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC } from '../../validate.ts';
import type { Volume, VolumePart } from '../../volume.ts';
import { SOCKET_PAD } from './socket.ts';

export interface FluffyMesh {
  /** Position and outward normal per vertex (6 floats). */
  vertices: Float32Array;
  /** The triangles twice: as the grid gives them, then with those around the eyes refined. */
  indices: Uint32Array;
  /** Where each set sits in `indices`. A small avatar is drawn from the coarse one. */
  coarse: IndexRange;
  fine: IndexRange;
  /**
   * Hair roots, independent of the triangles: position, normal and two random numbers (8 floats).
   * Stored in ROOT_PASSES passes over the surface, so the first few passes are an even share of
   * the coat (see rootsIn).
   */
  roots: Float32Array;
}

export interface IndexRange {
  start: number;
  count: number;
}

/** A state mark: a vertical capsule centered at the origin. Equal width and height give a ball. */
export interface Capsule {
  bounds: Bounds;
  radius: number;
}

export type FluffyShape = Volume | Capsule;

const isCapsule = (shape: FluffyShape): shape is Capsule => 'radius' in shape;

/** Front-to-back half extent of a shape, viewBox units. */
export function halfDepth(shape: FluffyShape): number {
  return isCapsule(shape) ? shape.radius : Math.max(0.5, ...shape.parts.map((part) => part.depth / 2));
}

/** Grid spacing, viewBox units. */
const STEP = 1.05;
/** Empty margin around the shape, viewBox units. */
const PAD = 3 * STEP;
/**
 * The roots are stored in this many passes over the surface, each taking every ROOT_PASSES-th
 * root. Each pass runs along the surface, which draws faster than roots in random order.
 */
export const ROOT_PASSES = 8;

/** How many of `total` roots the first `passes` passes hold. */
export function rootsIn(total: number, passes: number): number {
  let count = 0;
  for (let pass = 0; pass < passes; pass++) count += Math.ceil((total - pass) / ROOT_PASSES);
  return count;
}

/** Hair roots per square unit of surface. */
const ROOT_DENSITY = 3.3;
/** Each level splits the triangles around the eyes in four. */
const SOCKET_LEVELS = 2;

/** Samples of a field that is positive inside the shape, on a regular grid. */
interface Grid {
  x0: number;
  y0: number;
  z0: number;
  nx: number;
  ny: number;
  nz: number;
  field: Float32Array;
}

function emptyGrid(shape: FluffyShape): Grid {
  const b = shape.bounds, half = halfDepth(shape);
  const nx = Math.ceil((b.maxX - b.minX + 2 * PAD) / STEP) + 1;
  const ny = Math.ceil((b.maxY - b.minY + 2 * PAD) / STEP) + 1;
  const nz = Math.ceil((2 * half + 2 * PAD) / STEP) + 1;
  return { x0: b.minX - PAD, y0: b.minY - PAD, z0: -half - PAD, nx, ny, nz, field: new Float32Array(nx * ny * nz).fill(-1000) };
}

function addCapsule(g: Grid, { bounds, radius }: Capsule) {
  const halfStem = bounds.maxY - radius;
  for (let j = 0; j < g.ny; j++) {
    const dy = Math.max(0, Math.abs(g.y0 + j * STEP) - halfStem);
    for (let i = 0; i < g.nx; i++) {
      const radial = (g.x0 + i * STEP) ** 2 + dy ** 2;
      for (let k = 0; k < g.nz; k++) g.field[i + j * g.nx + k * g.nx * g.ny] = radius - Math.sqrt(radial + (g.z0 + k * STEP) ** 2);
    }
  }
}

/** Union one part into the grid: its outline's distance, capped by its height or rounded by its fillet. */
function addPart(g: Grid, part: VolumePart) {
  const { field, nx } = g, plane = nx * g.ny;
  const rounded = part.kind === 'inflate' && part.rxy > 0 && part.rz > 0;
  const distances = new EdgeIndex(part.polys, part.bounds).distances({ x0: g.x0, y0: g.y0, step: STEP, nx, ny: g.ny });
  // By winding, as the volume's own height does: grid columns start at the body's bounds, where
  // many outlines have a straight edge, and a point on an edge must fall on the same side.
  const outline = edgeBands(part.polys);
  for (let j = 0; j < g.ny; j++) {
    const y = g.y0 + j * STEP;
    for (let i = 0; i < nx; i++) {
      const x = g.x0 + i * STEP;
      const inside = outline.winding(x, y) !== 0;
      const sd = inside ? distances[i + j * nx] : -distances[i + j * nx];
      // An inflated part is shaped by its fillet instead; outside the outline there is no height.
      const h = part.kind === 'inflate' || !inside ? 0 : part.height(x, y);
      for (let k = 0; k < g.nz; k++) {
        const z = Math.abs(g.z0 + k * STEP);
        let d;
        if (rounded) {
          const side = (part.rxy - sd) / part.rxy, top = (z - part.depth / 2 + part.rz) / part.rz;
          d = (1 - Math.hypot(Math.max(0, side), Math.max(0, top))) * Math.min(part.rxy, part.rz);
        } else d = Math.min(sd, Math.max(0.55, h) - z);
        const at = i + j * nx + k * plane;
        if (d > field[at]) field[at] = d;
      }
    }
  }
}

/** One vertex in every cell the surface crosses, at the mean of its edge crossings, and a quad across every crossed edge. */
function surfaceNets(g: Grid): { vertices: number[]; indices: number[] } {
  const { field, nx, ny, nz } = g, plane = nx * ny;
  const corners = [0, 1, nx, nx + 1, plane, plane + 1, plane + nx, plane + nx + 1];
  const strides = [1, nx, plane];
  const ids = new Int32Array(field.length).fill(-1);
  const vertices: number[] = [], indices: number[] = [];
  for (let k = 1; k < nz - 2; k++) for (let j = 1; j < ny - 2; j++) for (let i = 1; i < nx - 2; i++) {
    const cell = i + j * nx + k * plane, inside = field[cell] > 0;
    let crossed = false;
    for (let c = 1; c < 8 && !crossed; c++) crossed = (field[cell + corners[c]] > 0) !== inside;
    if (!crossed) continue;
    let sx = 0, sy = 0, sz = 0, count = 0, gx = 0, gy = 0, gz = 0;
    for (let c = 0; c < 8; c++) {
      const a = cell + corners[c];
      for (let axis = 0; axis < 3; axis++) {
        if (c & (1 << axis)) continue;
        const other = a + strides[axis];
        if ((field[a] > 0) === (field[other] > 0)) continue;
        const t = field[a] / (field[a] - field[other]);
        sx += (c & 1) + (axis === 0 ? t : 0);
        sy += ((c >> 1) & 1) + (axis === 1 ? t : 0);
        sz += ((c >> 2) & 1) + (axis === 2 ? t : 0);
        // The field's gradient at the crossing, from central differences at the edge's two ends.
        gx += (field[a - 1] - field[a + 1]) * (1 - t) + (field[other - 1] - field[other + 1]) * t;
        gy += (field[a - nx] - field[a + nx]) * (1 - t) + (field[other - nx] - field[other + nx]) * t;
        gz += (field[a - plane] - field[a + plane]) * (1 - t) + (field[other - plane] - field[other + plane]) * t;
        count++;
      }
    }
    const norm = Math.hypot(gx, gy, gz) || 1;
    const id = vertices.length / 6;
    ids[cell] = id;
    vertices.push(g.x0 + (i + sx / count) * STEP, g.y0 + (j + sy / count) * STEP, g.z0 + (k + sz / count) * STEP, gx / norm, gy / norm, gz / norm);
    for (let axis = 0; axis < 3; axis++) {
      if ((field[cell + strides[axis]] > 0) === inside) continue;
      const u = strides[(axis + 1) % 3], v = strides[(axis + 2) % 3];
      const p = ids[cell - u], q = ids[cell - u - v], r = ids[cell - v];
      if (Math.min(p, q, r) >= 0) indices.push(id, p, q, id, q, r);
    }
  }
  return { vertices, indices };
}

/** Seeded, so a shape always grows the same coat. */
function randomFrom(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Hair roots spread evenly by area, each with two random numbers for its strand. */
function scatterRoots(vertices: number[], indices: number[]): Float32Array {
  const random = randomFrom(51821);
  const roots: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 6, b = indices[i + 1] * 6, c = indices[i + 2] * 6;
    const abx = vertices[b] - vertices[a], aby = vertices[b + 1] - vertices[a + 1], abz = vertices[b + 2] - vertices[a + 2];
    const acx = vertices[c] - vertices[a], acy = vertices[c + 1] - vertices[a + 1], acz = vertices[c + 2] - vertices[a + 2];
    const area = 0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    const count = Math.floor(area * ROOT_DENSITY + random());
    for (let n = 0; n < count; n++) {
      const u = Math.sqrt(random()), v = u * random();
      for (let k = 0; k < 6; k++) roots.push((1 - u) * vertices[a + k] + (u - v) * vertices[b + k] + v * vertices[c + k]);
      roots.push(random(), random());
    }
  }
  const total = roots.length / 8;
  const passes = new Float32Array(roots.length);
  let at = 0;
  for (let pass = 0; pass < ROOT_PASSES; pass++) {
    for (let i = pass; i < total; i += ROOT_PASSES) for (let k = 0; k < 8; k++) passes[at++] = roots[8 * i + k];
  }
  return passes;
}

/**
 * The grid is too coarse to describe a bead in profile: split the front triangles within reach of
 * an eye (its largest mark, anywhere its gaze takes it). Adds the new vertices to `vertices`.
 */
function refineSockets(vertices: number[], indices: number[], vol: Volume): number[] {
  const pad = SOCKET_PAD + 2 * STEP;
  const reachX = vol.eyeScale * (EYE_W * (HAPPY_ARC.halfWidth + HAPPY_ARC.stroke / 2) + GAZE_X) + pad;
  const reachY = vol.eyeScale * (EYE_H / 2 + GAZE_Y) + pad;
  const refined: number[] = [];
  const midpoints = new Map<number, number>();
  const midpoint = (a: number, b: number) => {
    const key = Math.min(a, b) * 2 ** 26 + Math.max(a, b);
    let id = midpoints.get(key);
    if (id === undefined) {
      id = vertices.length / 6;
      for (let k = 0; k < 6; k++) vertices.push((vertices[6 * a + k] + vertices[6 * b + k]) / 2);
      midpoints.set(key, id);
    }
    return id;
  };
  const split = (a: number, b: number, c: number, level: number) => {
    if (level === 0) {
      refined.push(a, b, c);
      return;
    }
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    split(a, ab, ca, level - 1);
    split(ab, b, bc, level - 1);
    split(ca, bc, c, level - 1);
    split(ab, bc, ca, level - 1);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], x = vertices[6 * a], y = vertices[6 * a + 1], z = vertices[6 * a + 2];
    const near = z >= -2 * STEP && vol.eyePlanes.some((eye) => Math.abs(eye.x - x) <= reachX && Math.abs(eye.y - y) <= reachY);
    split(a, indices[i + 1], indices[i + 2], near ? SOCKET_LEVELS : 0);
  }
  return refined;
}

export function buildMesh(shape: FluffyShape): FluffyMesh {
  const grid = emptyGrid(shape);
  if (isCapsule(shape)) addCapsule(grid, shape);
  else for (const part of shape.parts) addPart(grid, part);
  const { vertices, indices } = surfaceNets(grid);
  // Roots first: refining would otherwise change which triangle each one falls on.
  const roots = scatterRoots(vertices, indices);
  const coarse = { start: 0, count: indices.length };
  if (isCapsule(shape)) return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), coarse, fine: coarse, roots };
  const refined = refineSockets(vertices, indices, shape);
  const all = new Uint32Array(indices.length + refined.length);
  all.set(indices);
  all.set(refined, indices.length);
  return { vertices: new Float32Array(vertices), indices: all, coarse, fine: { start: indices.length, count: refined.length }, roots };
}
