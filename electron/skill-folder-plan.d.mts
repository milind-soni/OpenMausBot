import type { SkippedSkillFile, SkippedSkillFileReason } from "../shared/skill-import.ts";

export const SKILL_FOLDER_LIMITS: Readonly<{ files: number; bytes: number; fileBytes: number; depth: number }>;
export const SKILL_IMPORT_SKIP_REPORT_MAX: number;

export interface FolderEntry {
  /** Relative to the skill folder, "/"-separated. */
  path: string;
  kind: "file" | "folder" | "link" | "submodule";
  size: number;
  executable?: boolean;
}

export function skillFilePathProblem(path: string, folder?: boolean): SkippedSkillFileReason | null;
export function planSkillFolder<T extends FolderEntry>(entries: readonly T[]): { take: T[]; skipped: SkippedSkillFile[] };
