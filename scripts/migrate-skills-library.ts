// Standalone skills-library migration for a stopped server (skills lane S1).
//
// Run:  node --experimental-strip-types scripts/migrate-skills-library.ts [--data-dir <dir>]
//
// Migrates every bot's per-bot skill copies into DATA_DIR/skills-library
// (sha256 dedup, originals archived, never deleted) and records the
// resulting assignments in pending-assignments.json. It never writes
// bots.json: the next boot with features.skillsLibrary on applies the
// pending assignments through the Store, the single writer of bot records.
// While the flag is off, a migrated library plus pending file changes no
// bot's behavior.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dataDirFlag = args.indexOf("--data-dir");
const dataDir = dataDirFlag !== -1 ? resolve(args[dataDirFlag + 1]!) : undefined;
if (dataDir) process.env.OMB_DATA_DIR = dataDir;
else if (!process.env.OMB_DATA_DIR) {
  // Default run against the real data dir is the point of the script; the
  // scratch fallback only keeps an accidental bare invocation honest.
  process.env.OMB_DATA_DIR = mkdtempSync(resolve(tmpdir(), "omb-skills-library-migration-"));
}

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
