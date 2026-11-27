// Per-bot skill copies move into the shared library; originals are archived write-once, and a manifest entry is dropped only after its archive and assignment are durable.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import {
  installLibrarySkill,
  libraryArchiveDirectory,
  readSkillLibraryIndex,
  skillsLibraryRoot,
} from "./skill-library.ts";
import { listMigratableSkills, removeManifestEntry } from "./skills.ts";

export interface SkillMigrationOutcome {
  botId: string;
  name: string;
  outcome: "migrated" | "deduplicated" | "skipped";
  detail?: string;
}

export interface SkillsMigrationReport {
  ranAt: string;
  outcomes: SkillMigrationOutcome[];
  assignments: Record<string, string[]>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function archiveSkillDirectory(source: string, archive: string, expectSha256: string): void {
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  let destination = archive;
  if (existsSync(destination)) {
    const stem = `${archive}.${expectSha256}`;
    destination = stem;
    let suffix = 1;
    while (existsSync(destination)) destination = `${stem}.${suffix++}`;
  }
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
  }
  const archived = readFileSync(join(destination, "SKILL.md"), "utf8");
  if (sha256Hex(archived) !== expectSha256) {
    throw new Error("the archived copy does not match the reviewed sha256");
  }
}

export function migrateBotSkillsToLibrary(botId: string, root: string = skillsLibraryRoot()): SkillsMigrationReport {
  const outcomes: SkillMigrationOutcome[] = [];
  const assigned: string[] = [];
  for (const copy of listMigratableSkills(botId)) {
    if (!copy.intact || !copy.directory) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: "stored SKILL.md is missing or changed after review" });
      continue;
    }
    try {
      if (readdirSync(copy.directory).some((name) => name !== "SKILL.md")) {
        outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: "skill has auxiliary files — keeping its complete private directory" });
        continue;
      }
    } catch {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: "could not inspect the private skill directory" });
      continue;
    }
    let instructions: string;
    try {
      instructions = readFileSync(join(copy.directory, "SKILL.md"), "utf8");
    } catch (error) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: `could not read the stored SKILL.md: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (sha256Hex(instructions) !== copy.sha256) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: "stored SKILL.md changed after review" });
      continue;
    }
    const existing = readSkillLibraryIndex(root)[copy.name];
    if (existing && existing.sha256 !== copy.sha256) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: `the library already has a different "${copy.name}" — rename one of them` });
      continue;
    }
    // The entry's review state is shared: deduplicating a copy whose on/off differs would flip that bot's switch.
    if (existing && (existing.reviewState === "approved") !== copy.enabled) {
      outcomes.push({
        botId,
        name: copy.name,
        outcome: "skipped",
        detail: `the library "${copy.name}" is ${existing.reviewState === "approved" ? "enabled" : "disabled"} while this bot had it ${copy.enabled ? "enabled" : "disabled"} — align them before migrating`,
      });
      continue;
    }
    if (!existing) {
      const installed = installLibrarySkill({
        name: copy.name,
        description: copy.description,
        instructions,
        source: copy.source,
        license: copy.license,
        compatibility: copy.compatibility,
        reviewState: copy.enabled ? "approved" : "disabled",
        package: copy.package,
        root,
      });
      if ("error" in installed) {
        outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: installed.error });
        continue;
      }
      outcomes.push({ botId, name: copy.name, outcome: "migrated" });
    } else {
      outcomes.push({ botId, name: copy.name, outcome: "deduplicated", detail: "identical sha256 already in the library" });
    }
    // The manifest entry is the only re-readable record: the assignment must be durable (pending file) before it goes.
    try {
      const pendingAssignments = readPendingAssignments(root);
      if (copy.enabled) writePendingAssignments({
        ...pendingAssignments,
        [botId]: [...new Set([...(pendingAssignments[botId] ?? []), ...assigned, copy.name])].sort(),
      }, root);
    } catch (error) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: `could not record the assignment durably: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    try {
      archiveSkillDirectory(copy.directory, libraryArchiveDirectory(root, botId, copy.name), copy.sha256);
    } catch (error) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: `archiving failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const removed = removeManifestEntry(botId, copy.name, copy.sha256);
    if ("error" in removed) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: removed.error });
      continue;
    }
    // A disabled copy assigns nothing: nobody gains a skill they never turned on.
    if (copy.enabled) assigned.push(copy.name);
  }
  return { ranAt: new Date().toISOString(), outcomes, assignments: assigned.length ? { [botId]: assigned } : {} };
}

export function pendingAssignmentsPath(root: string = skillsLibraryRoot()): string {
  return join(root, "pending-assignments.json");
}

export function readPendingAssignments(root: string = skillsLibraryRoot()): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pendingAssignmentsPath(root), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [botId, names] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(names) && names.every((name) => typeof name === "string")) result[botId] = [...names];
    }
    return result;
  } catch {
    return {};
  }
}

export function writePendingAssignments(assignments: Record<string, string[]>, root: string = skillsLibraryRoot()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileAtomic(pendingAssignmentsPath(root), `${JSON.stringify(assignments, null, 2)}\n`, { mode: 0o600 });
}

export function runSkillsLibraryBootSweep(options: {
  bots: readonly { id: string; assignedSkills?: string[] }[];
  patch?: (botId: string, assignedSkills: string[]) => void;
  root?: string;
}): SkillsMigrationReport {
  const root = options.root ?? skillsLibraryRoot();
  const outcomes: SkillMigrationOutcome[] = [];
  const assignments: Record<string, string[]> = {};
  const pending = options.patch ? readPendingAssignments(root) : {};
  for (const bot of options.bots) {
    const report = migrateBotSkillsToLibrary(bot.id, root);
    outcomes.push(...report.outcomes);
    const current = bot.assignedSkills ?? [];
    const merged = [...new Set([...(pending[bot.id] ?? []), ...(report.assignments[bot.id] ?? []), ...current])].sort();
    const changed = merged.length !== current.length || merged.some((name, index) => name !== current[index]);
    if (!changed) continue;
    if (options.patch) options.patch(bot.id, merged);
    assignments[bot.id] = merged;
  }
  if (options.patch && (Object.keys(pending).length || Object.keys(readPendingAssignments(root)).length)) {
    writePendingAssignments({}, root);
  }
  return { ranAt: new Date().toISOString(), outcomes, assignments };
}

export function botIdsWithSkillState(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, "skill-state"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
