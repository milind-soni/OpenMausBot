// Prints where the harness compacts vs where the engine compacts itself.
// Run: node --experimental-strip-types scripts/show-compaction-thresholds.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { compactBudget } = await import(join(here, "../server/context-budget.ts"));
const { autoCompactWindow } = await import(join(here, "../server/drivers/claude.ts"));

const cli = Number(autoCompactWindow(process.env));
const n = (v) => v.toLocaleString("en-US").padStart(9);

console.log(`\nClaude's own --autocompact fires at ${n(cli)} tokens\n`);
console.log("model window │ harness (fixed) │ harness (before fix) │ who compacts first");
console.log("─────────────┼─────────────────┼──────────────────────┼───────────────────");
for (const w of [128_000, 200_000, 400_000, 1_000_000]) {
  const fixed = compactBudget(undefined, w, cli);
  const before = compactBudget(undefined, w);
  const winner = before < cli ? "harness (fine)" : "CLI — NO RECORD";
  console.log(`${n(w)}    │ ${n(fixed)}       │ ${n(before)}            │ ${winner}`);
}
console.log("\n'NO RECORD' = the thread's history lived only inside Claude's session:");
console.log("invisible in the app, and gone if the thread moves to another model.\n");
