// Standalone skills-library migration for a stopped server (skills lane S1).
//
// Run:  node --experimental-strip-types scripts/migrate-skills-library.ts [--data-dir <dir>]
//
// Migrates every bot's per-bot skill copies into DATA_DIR/skills-library
// (sha256 dedup, originals archived, never deleted) and records the
// resulting assignments in pending-assignments.json. It never writes
// bots.json: the next boot with features.skillsLibrary on applies the
// pending assignments through the Store, the single writer of bot records.
// This script migrates unconditionally — it does not read the flag: each
// migrated skill's per-bot copy is archived away and its manifest entry
// cleared, so until a boot with features.skillsLibrary on applies the
// pending assignments, bots see those skills gone. Run it only when the
// flag is on.
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dataDirFlag = args.indexOf("--data-dir");
if (dataDirFlag !== -1 && (!args[dataDirFlag + 1]?.trim() || args[dataDirFlag + 1]!.startsWith("-"))) {
  console.error("Usage: migrate-skills-library.ts [--data-dir <dir>]");
  process.exit(2);
}
const dataDir = dataDirFlag !== -1 ? resolve(args[dataDirFlag + 1]!) : undefined;
// A bare invocation runs against the real application data dir: a scratch
// fallback here would report success while migrating nothing.
if (dataDir) process.env.OMB_DATA_DIR = dataDir;

const { botIdsWithSkillState, migrateBotSkillsToLibrary, readPendingAssignments, writePendingAssignments } =
  await import("../server/skills-library-migration.ts");
const { DATA_DIR } = await import("../server/config.ts");

const pending = readPendingAssignments();
const outcomes = [];
const assignments: Record<string, string[]> = { ...pending };
for (const botId of botIdsWithSkillState(DATA_DIR)) {
  const report = migrateBotSkillsToLibrary(botId);
  outcomes.push(...report.outcomes);
  if (report.assignments[botId]?.length) {
    assignments[botId] = [...new Set([...(assignments[botId] ?? []), ...report.assignments[botId]!])].sort();
  }
}
writePendingAssignments(assignments);
const applied = outcomes.filter((outcome) => outcome.outcome !== "skipped").length;
console.log(JSON.stringify({ dataDir: DATA_DIR, bots: Object.keys(assignments).length, applied, skipped: outcomes.length - applied, outcomes }, null, 2));
