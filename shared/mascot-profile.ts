import { z } from "zod";

import { FACE_BOX } from "./cursor-face-data.ts";
import { BOT_BODY_IDS, type BotBodyId } from "./bot-body.ts";

export const MASCOT_PROFILE_VERSION = 1 as const;
export const MAX_CUSTOM_MASCOT_SHAPES = 24;
export const MAX_CUSTOM_MASCOT_POINTS = 512;
export const MAX_CUSTOM_MASCOT_PROFILE_BYTES = 256 * 1024;
export const MAX_NATIVE_MASCOT_SCALE = 0.791;
export const MIN_CUSTOM_MASCOT_SCALE = 0.02;
export const MAX_CUSTOM_MASCOT_NAME = 80;
const PROFILE_SIZE_LIMIT_ERROR = "mascot profile exceeds the size limit";

export type CustomMascotPoint = readonly [x: number, y: number];

export interface CustomMascotAnchor {
  x: number;
  y: number;
  scale: number;
}

/** Canonical geometry only. The imported SVG and path data are never stored. */
export interface CustomMascotDefinition {
  name: string;
  /** One implicitly closed outline in face-box coordinates; holes are unsupported. */
  outline: readonly CustomMascotPoint[];
  anchor: CustomMascotAnchor;
}

export interface CustomMascotShape extends CustomMascotDefinition {
  /** SHA-256 of the normalized definition, assigned and checked by the server. */
  id: string;
}

export type MascotSelection =
  | { kind: "builtin"; bodyId: BotBodyId }
  | { kind: "custom"; shapeId: string };

export interface MascotProfile {
  version: typeof MASCOT_PROFILE_VERSION;
  /** Immutable local snapshots, including shapes copied from another bot. */
  shapes: CustomMascotShape[];
  selected: MascotSelection;
}

export class MascotProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MascotProfileValidationError";
  }
}

const coordinate = z.number().finite().min(0).max(FACE_BOX);
const pointSchema = z.tuple([coordinate, coordinate]);
const anchorSchema = z.object({
  x: coordinate,
  y: coordinate,
  scale: z.number().finite().min(MIN_CUSTOM_MASCOT_SCALE).max(MAX_NATIVE_MASCOT_SCALE),
}).strict();
const nameSchema = z.string().min(1).max(MAX_CUSTOM_MASCOT_NAME).refine(
  (value) => normalizeMascotName(value) === value,
  "name must be a normalized single line",
);

const outlineSchema = z.array(pointSchema).min(8).max(MAX_CUSTOM_MASCOT_POINTS).superRefine((outline, context) => {
  if (!isSimpleClosedOutline(outline)) {
    context.addIssue({ code: "custom", message: "outline must be one simple, closed shape without holes" });
  }
});

export const customMascotDefinitionSchema = z.object({
  name: nameSchema,
  outline: outlineSchema,
  anchor: anchorSchema,
}).strict();

export const customMascotShapeSchema = customMascotDefinitionSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), bodyId: z.enum(BOT_BODY_IDS) }).strict(),
  z.object({ kind: z.literal("custom"), shapeId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

export const mascotProfileSchema = z.object({
  version: z.literal(MASCOT_PROFILE_VERSION),
  shapes: z.array(customMascotShapeSchema).max(MAX_CUSTOM_MASCOT_SHAPES),
  selected: selectionSchema,
}).strict().superRefine((profile, context) => {
  const ids = new Set<string>();
  for (const shape of profile.shapes) {
    if (ids.has(shape.id)) context.addIssue({ code: "custom", path: ["shapes"], message: "shape IDs must be unique" });
    ids.add(shape.id);
  }
  if (profile.selected.kind === "custom" && !ids.has(profile.selected.shapeId)) {
    context.addIssue({ code: "custom", path: ["selected"], message: "selected custom shape must exist in this profile" });
  }
  if (new TextEncoder().encode(JSON.stringify(profile)).byteLength > MAX_CUSTOM_MASCOT_PROFILE_BYTES) {
    context.addIssue({ code: "custom", message: PROFILE_SIZE_LIMIT_ERROR });
  }
});

export function normalizeMascotName(value: string): string {
  return value.normalize("NFC").replace(/[\s\u200b]+/gu, " ").trim();
}

export function normalizeCustomMascotDefinition(input: unknown): CustomMascotDefinition {
  const candidate = input && typeof input === "object" && !Array.isArray(input)
    ? { ...input as Record<string, unknown>, name: typeof (input as Record<string, unknown>).name === "string"
      ? normalizeMascotName((input as Record<string, unknown>).name as string)
      : (input as Record<string, unknown>).name }
    : input;
  const parsed = customMascotDefinitionSchema.parse(candidate);
  const outline: CustomMascotPoint[] = [];
  for (const [x, y] of parsed.outline) {
    const next: CustomMascotPoint = [round(x, 3), round(y, 3)];
    if (!samePoint(outline.at(-1), next)) outline.push(next);
  }
  if (outline.length > 1 && samePoint(outline[0]!, outline[outline.length - 1]!)) outline.pop();
  const definition: CustomMascotDefinition = {
    name: normalizeMascotName(parsed.name),
    outline,
    anchor: {
      x: round(parsed.anchor.x, 3),
      y: round(parsed.anchor.y, 3),
      scale: round(parsed.anchor.scale, 4),
    },
  };
  customMascotDefinitionSchema.parse(definition);
  return definition;
}

export function customMascotDefinitionOf(shape: CustomMascotShape): CustomMascotDefinition {
  return { name: shape.name, outline: shape.outline, anchor: shape.anchor };
}

export function customMascotOutlinePathData(outline: readonly CustomMascotPoint[]): string {
  if (outline.length < 8 || outline.length > MAX_CUSTOM_MASCOT_POINTS) return "";
  if (outline.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > FACE_BOX || y > FACE_BOX)) return "";
  return `M${outline.map(([x, y]) => `${formatCoordinate(x)} ${formatCoordinate(y)}`).join(" L")} Z`;
}

export function sameCustomMascotDefinition(a: CustomMascotDefinition, b: CustomMascotDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isSimpleClosedOutline(outline: readonly CustomMascotPoint[]): boolean {
  if (outline.length < 8 || outline.length > MAX_CUSTOM_MASCOT_POINTS) return false;
  let twiceArea = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i]!;
    const [x2, y2] = outline[(i + 1) % outline.length]!;
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || x1 < 0 || y1 < 0 || x1 > FACE_BOX || y1 > FACE_BOX) return false;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.001) return false;
    twiceArea += x1 * y2 - x2 * y1;
  }
  if (Math.abs(twiceArea) < 2) return false;

  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    for (let j = i + 1; j < outline.length; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === outline.length - 1)) continue;
      const c = outline[j]!;
      const d = outline[(j + 1) % outline.length]!;
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

export function createMascotProfile(bodyId?: string | null): MascotProfile {
  const safeBody = typeof bodyId === "string" && (BOT_BODY_IDS as readonly string[]).includes(bodyId)
    ? bodyId as BotBodyId
    : "cursor";
  return { version: MASCOT_PROFILE_VERSION, shapes: [], selected: { kind: "builtin", bodyId: safeBody } };
}

export function selectBuiltinMascot(profile: MascotProfile | undefined, bodyId: string): MascotProfile {
  const next = profile ?? createMascotProfile();
  const selected = createMascotProfile(bodyId).selected;
  return { ...next, selected };
}

export function addOrSelectCustomMascot(profile: MascotProfile | undefined, shape: CustomMascotShape): MascotProfile {
  const current = profile ?? createMascotProfile();
  const existing = current.shapes.find((candidate) => candidate.id === shape.id);
  if (existing && !sameCustomMascotDefinition(customMascotDefinitionOf(existing), customMascotDefinitionOf(shape))) {
    throw new MascotProfileValidationError("custom mascot ID already exists with different content");
  }
  if (!existing && current.shapes.length >= MAX_CUSTOM_MASCOT_SHAPES) {
    throw new MascotProfileValidationError(`a bot can save up to ${MAX_CUSTOM_MASCOT_SHAPES} custom mascots`);
  }
  const shapes = existing ? current.shapes : [...current.shapes, shape];
  const next = { ...current, shapes, selected: { kind: "custom" as const, shapeId: shape.id } };
  const validated = mascotProfileSchema.safeParse(next);
  if (!validated.success) {
    const issue = validated.error.issues.length === 1 ? validated.error.issues[0] : undefined;
    if (issue?.code === "custom" && issue.path.length === 0 && issue.message === PROFILE_SIZE_LIMIT_ERROR) {
      throw new MascotProfileValidationError(PROFILE_SIZE_LIMIT_ERROR);
    }
    throw validated.error;
  }
  return next;
}

export function selectedCustomMascot(profile: MascotProfile | undefined): CustomMascotShape | undefined {
  const selected = profile?.selected;
  if (!profile || selected?.kind !== "custom") return undefined;
  return profile.shapes.find((shape) => shape.id === selected.shapeId);
}

/** Legacy client projection only. The canonical selection lives in mascotProfile. */
export function legacyMascotBody(profile: MascotProfile | undefined): BotBodyId {
  return profile?.selected.kind === "builtin" ? profile.selected.bodyId : "cursor";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatCoordinate(value: number): string {
  return String(round(value, 3));
}

function samePoint(a: CustomMascotPoint | undefined, b: CustomMascotPoint): boolean {
  return Boolean(a && a[0] === b[0] && a[1] === b[1]);
}

function segmentsIntersect(a: CustomMascotPoint, b: CustomMascotPoint, c: CustomMascotPoint, d: CustomMascotPoint): boolean {
  const orient = (p: CustomMascotPoint, q: CustomMascotPoint, r: CustomMascotPoint) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p: CustomMascotPoint, q: CustomMascotPoint, r: CustomMascotPoint) =>
    Math.min(p[0], r[0]) - 1e-8 <= q[0] && q[0] <= Math.max(p[0], r[0]) + 1e-8 &&
    Math.min(p[1], r[1]) - 1e-8 <= q[1] && q[1] <= Math.max(p[1], r[1]) + 1e-8;
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 1e-8 && o2 < -1e-8) || (o1 < -1e-8 && o2 > 1e-8)) &&
      ((o3 > 1e-8 && o4 < -1e-8) || (o3 < -1e-8 && o4 > 1e-8))) return true;
  return (Math.abs(o1) <= 1e-8 && onSegment(a, c, b)) ||
    (Math.abs(o2) <= 1e-8 && onSegment(a, d, b)) ||
    (Math.abs(o3) <= 1e-8 && onSegment(c, a, d)) ||
    (Math.abs(o4) <= 1e-8 && onSegment(c, b, d));
}
