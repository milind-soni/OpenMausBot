import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { readBoundedSkillFile } from "./bounded-skill-read.ts";

const identity = z.string().regex(/^\d+:\d+:[\d.]+:[\d.]+$/).max(160);
const receiptSchema = z.object({
  directory: z.string().max(4096).refine((path) => isAbsolute(path) && resolve(path) === path),
  identity,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["pending", "retained"]).optional(),
  localParent: identity.optional(),
}).strict();
export type SkillRetirementReceipt = z.infer<typeof receiptSchema>;
export const stableSkillIdentity = (value: string | null) => value?.slice(0, value.lastIndexOf(":")) ?? null;

export function skillRetirementKey(record: Pick<SkillRetirementReceipt, "directory" | "identity" | "hash">): string {
  return createHash("sha256").update(JSON.stringify([record.directory, record.identity, record.hash])).digest("hex");
}

export function readSkillRetirementReceipt(marker: string): SkillRetirementReceipt | null {
  try {
    const bytes = readBoundedSkillFile(marker, 16_384);
    const parsed = bytes && receiptSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed || !parsed.success || basename(marker) !== `${skillRetirementKey(parsed.data)}.json` ||
      (parsed.data.localParent && !parsed.data.state)) return null;
    return parsed.data;
  } catch { return null; }
}

export function localSkillRetirementPath(record: SkillRetirementReceipt): string {
  return join(dirname(record.directory), `.retired-${skillRetirementKey(record)}`);
}

/** A protected receipt can name only a derived sibling under its original, unchanged real parent. */
export function localSkillRetirementParentMatches(record: SkillRetirementReceipt): boolean {
  if (!record.localParent) return false;
  try {
    const parent = dirname(record.directory), before = lstatSync(parent);
    if (stableSkillIdentity(`${before.dev}:${before.ino}:${before.birthtimeMs}:${before.ctimeMs}`) !== stableSkillIdentity(record.localParent)) return false;
    for (let path = parent; ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (dirname(path) === path) return true;
    }
  } catch { return false; }
}
