// Standalone skills-library migration for a stopped server:
//
//   node --experimental-strip-types scripts/migrate-skills-library.ts [--data-dir <dir>]
//
// It never writes bots.json and does not read features.skillsLibrary: migrated
// skills disappear from bots until a boot with the flag on applies the pending
// assignments. Run it only when the flag is on.
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
