import { MOUTH_STROKE } from "./cursor-face-data.ts";
import { fieldFromMask, largestInscribedCircle, type Sdf } from "./mascot-geometry/sdf.ts";
import { maskFromPolylines } from "./mascot-geometry/raster.ts";
import { buildClouds, maxScaleAt, report } from "./mascot-geometry/solve.ts";
import {
  MAX_NATIVE_MASCOT_SCALE,
  MIN_CUSTOM_MASCOT_SCALE,
  isSimpleClosedOutline,
  type CustomMascotAnchor,
  type CustomMascotPoint,
} from "./mascot-profile.ts";

const RASTER_SIZE = 256;
const FIT_CLEARANCE = 1;
const MAX_CLOUD_EDGE_STEP = 2;
const GAZE_CORNERS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
] as const;

type FaceCloud = ReturnType<typeof buildClouds>[number];

export interface CustomMascotFitContext {
  sdf: Sdf;
  clouds: FaceCloud[];
}

export interface CustomMascotFitResult {
  fits: boolean;
  clearance: number;
}

export function createCustomMascotFitContext(outline: readonly CustomMascotPoint[]): CustomMascotFitContext {
  if (!isSimpleClosedOutline(outline)) throw new Error("outline must be one simple, closed shape without holes");
  const points = outline.map(([x, y]) => [x, y] as [number, number]);
  const sdf = fieldFromMask(maskFromPolylines([points], RASTER_SIZE), RASTER_SIZE);
  if (largestInscribedCircle(sdf).radius <= 0) throw new Error("outline must enclose a filled area");

  const cornerClouds = [0, 1].flatMap((lookAround) =>
    GAZE_CORNERS.flatMap((aim) => buildClouds(lookAround, MOUTH_STROKE, aim)),
  );
  const cloud = convexMotionEnvelope(cornerClouds);
  return { sdf, clouds: [cloud] };
}

export function measureCustomMascotFit(
  context: CustomMascotFitContext,
  anchor: CustomMascotAnchor,
): CustomMascotFitResult {
  const result = report(context.clouds, context.sdf, anchor);
  return { fits: result.clipping.length === 0, clearance: result.clearance };
}

export function suggestCustomMascotAnchor(context: CustomMascotFitContext): CustomMascotAnchor {
  const center = largestInscribedCircle(context.sdf);
  const x = round(center.x, 3);
  const y = round(center.y, 3);
  let scale = round(maxScaleAt(context.clouds, context.sdf, x, y, MAX_NATIVE_MASCOT_SCALE), 4);
  if (scale < MIN_CUSTOM_MASCOT_SCALE) {
    throw new Error("there is not enough room for the standard mascot face in this outline");
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const anchor = { x, y, scale };
    if (measureCustomMascotFit(context, anchor).fits) return anchor;
    scale = round(scale - 0.0001, 4);
    if (scale < MIN_CUSTOM_MASCOT_SCALE) break;
  }
  throw new Error("there is not enough room for a safely fitted standard mascot face in this outline");
}

function convexMotionEnvelope(clouds: FaceCloud[]): FaceCloud {
  const points: [number, number][] = [];
  let need = 0;
  for (const cloud of clouds) {
    for (let index = 0, n = 0; index < cloud.points.length; index += 2, n++) {
      points.push([cloud.points[index]!, cloud.points[index + 1]!]);
      need = Math.max(need, cloud.need[n]!);
    }
  }
  const hull = convexHull(points);
  const boundary: [number, number][] = [];
  for (let index = 0; index < hull.length; index++) {
    const from = hull[index]!;
    const to = hull[(index + 1) % hull.length]!;
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.ceil(distance / MAX_CLOUD_EDGE_STEP));
    for (let step = 0; step < steps; step++) {
      const progress = step / steps;
      boundary.push([
        from[0] + (to[0] - from[0]) * progress,
        from[1] + (to[1] - from[1]) * progress,
      ]);
    }
  }
  const margin = need + FIT_CLEARANCE;
  const packed = new Float32Array(boundary.length * 2);
  const needs = new Float32Array(boundary.length);
  boundary.forEach(([x, y], index) => {
    packed[index * 2] = x;
    packed[index * 2 + 1] = y;
    needs[index] = margin;
  });
  return { points: packed, need: needs } as FaceCloud;
}

function convexHull(input: [number, number][]): [number, number][] {
  const points = input
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((point, index, all) => index === 0 || point[0] !== all[index - 1]![0] || point[1] !== all[index - 1]![1]);
  if (points.length < 3) return points;
  const cross = (origin: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower: [number, number][] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: [number, number][] = [];
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
