import { z } from "zod";

import type { RoutineContextAttachment } from "../shared/routines.ts";

const MAX_ATTACHMENTS = 50;
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["file", "image"]),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  size: z.number().finite().nonnegative(),
});

export function cleanAttachments(value: unknown): RoutineContextAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
      throw new Error("Choose a valid attachment");
    }
    if (ids.has(parsed.data.id)) throw new Error("Each attachment must be unique");
    ids.add(parsed.data.id);
    return { ...parsed.data };
  });
}

/** The file paths the owners' attachments name; null when any saved list is malformed, so a clear that relies on it refuses. */
export function attachmentPathsOf(owners: ReadonlyArray<{ attachments?: unknown }>): string[] | null {
  const paths: string[] = [];
  for (const { attachments } of owners) {
    if (attachments === undefined) continue;
    if (!Array.isArray(attachments)) return null;
    for (const file of attachments as unknown[]) {
      const path = file && typeof file === "object" ? (file as { path?: unknown }).path : undefined;
      if (typeof path !== "string") return null;
      paths.push(path);
    }
  }
  return paths;
}

/** True when any saved list would not load as it is: loading drops such a list, so its files are no longer named. */
export function attachmentsMalformed(owners: ReadonlyArray<{ attachments?: unknown }>): boolean {
  return owners.some(({ attachments }) => {
    try { cleanAttachments(attachments); return false; } catch { return true; }
  });
}

export function cleanTimeoutMinutes(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 240) {
    throw new Error("Run limit must be a whole number from 5 to 240 minutes");
  }
  return value;
}

export function loadTimeoutMinutes(value: unknown): number | undefined {
  try {
    return cleanTimeoutMinutes(value);
  } catch {
    return undefined;
  }
}

export function loadAttachments(value: unknown): RoutineContextAttachment[] {
  try {
    return cleanAttachments(value);
  } catch {
    return [];
  }
}

export function cloneAttachments(attachments: readonly RoutineContextAttachment[] | undefined): RoutineContextAttachment[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}
