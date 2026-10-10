// Skills library migration (features.skillsLibrary, skills lane S1).
//
// Per-bot skill copies move into the shared library, deduplicated by the
// reviewed SKILL.md sha256. Originals are archived under the library root —
// write-once, never deleted — and the per-bot manifest entry is dropped
// only after the archive exists and the assignment is durably recorded. The
// sweep is idempotent through state, not markers: a migrated skill has no
// manifest entry left to re-read, and an existing archive short-circuits
// the move.
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
  /** botId → library skill names that bot should be assigned after this run. */
  assignments: Record<string, string[]>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Move a per-bot skill directory into its archive slot. Same-volume moves
 * rename; a cross-device fallback copies recursively and verifies the
 * SKILL.md hash before the copy counts as the archive. */
function archiveSkillDirectory(source: string, archive: string, expectSha256: string): void {
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  // Every source directory gets its own slot: the same sha256 can be
  // reinstalled after its manifest entry was cleared, so a collision takes
  // a hash-qualified name, then numeric suffixes, never a silent drop.
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

/** Migrate one bot's per-bot skill copies into the library. Org-stamped
 * skills carry their stamp onto the library entry, so an organization
 * install becomes a library source instead of a parallel system. A bot is
 * assigned only when its own copy was enabled; the first copy's enabled
 * flag still decides the entry's reviewState. */
export function migrateBotSkillsToLibrary(botId: string, root: string = skillsLibraryRoot()): SkillsMigrationReport {
  const outcomes: SkillMigrationOutcome[] = [];
  const assigned: string[] = [];
  for (const copy of listMigratableSkills(botId)) {
    if (!copy.intact || !copy.directory) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: "stored SKILL.md is missing or changed after review" });
      continue;
    }
    // The shared library currently stores SKILL.md only. Moving a package
    // with scripts/references/assets would make its relative paths vanish
    // from the bot's usable directory, so keep that working private copy.
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
    // The library entry's review state is shared by every assigned bot, so
    // deduplicating a copy whose own on/off differs from it would silently
    // flip that bot's switch. Keep the per-bot copy in place for a human to
    // reconcile instead of archiving and assigning it.
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
    // The manifest entry is the only re-readable record of this skill, so
    // the assignment must be durable before it goes away. Record it in the
    // pending-assignments file the boot sweep and the standalone script both
    // replay: if this write — or the later patch to the bot record — fails,
    // the next boot restores the assignment instead of stranding an
    // archived skill with no manifest and no assignment.
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
      // The library entry is idempotent, so leaving the per-bot copy in
      // place only means the next sweep retries this skill. The assignment
      // recorded above replays idempotently, so the extra pending entry a
      // failed archive leaves behind is harmless.
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: `archiving failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const removed = removeManifestEntry(botId, copy.name, copy.sha256);
    if ("error" in removed) {
      outcomes.push({ botId, name: copy.name, outcome: "skipped", detail: removed.error });
      continue;
    }
    // Assignment follows this bot's own copy.enabled: a disabled copy
    // migrates its bytes but assigns nothing, so nobody gains a skill
    // they never turned on.
    if (copy.enabled) assigned.push(copy.name);
  }
  return { ranAt: new Date().toISOString(), outcomes, assignments: assigned.length ? { [botId]: assigned } : {} };
}

export function pendingAssignmentsPath(root: string = skillsLibraryRoot()): string {
  return join(root, "pending-assignments.json");
}

/** Assignments waiting to reach bot records: recorded by the standalone
 * script for a stopped server, and by the migration itself before a
 * manifest entry is dropped. The next flag-on boot applies them through
 * the Store, the single writer of bots.json. */
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

/** The boot sweep: migrate every bot's copies, then apply assignments.
 * With a `patch` callback (the live server) assignments land on the bot
 * records directly and any script-recorded pending file is cleared; without
 * one this only reports. Runs under features.skillsLibrary only. */
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
  // Clear the pending file once every patch applied: entries recorded by
  // the script before this boot and recovery records written by this run's
  // migrations are both spent.
  if (options.patch && (Object.keys(pending).length || Object.keys(readPendingAssignments(root)).length)) {
    writePendingAssignments({}, root);
  }
  return { ranAt: new Date().toISOString(), outcomes, assignments };
}

/** Bot ids that have per-bot skill manifests on disk. Used by the
 * standalone script, which cannot reach the Store. */
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
