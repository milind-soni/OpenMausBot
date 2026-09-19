import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenarioSchema, type Scenario } from "../types.ts";
import { writeReport } from "../reports/write-report.ts";
import { runScenario } from "./run-scenario.ts";

const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");
const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "runs");

export function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => scenarioSchema.parse(JSON.parse(readFileSync(join(SCENARIOS_DIR, name), "utf8"))));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: pnpm eval [--scenario <id>]... [--out <dir>]");
    return 0;
  }
  const wanted = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") wanted.add(args[index + 1] ?? "");
    if (args[index] === "--out") index += 1;
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex === -1 ? DEFAULT_OUT : (args[outIndex + 1] ?? DEFAULT_OUT);
  const all = loadScenarios();
  const selected = wanted.size === 0 ? all : all.filter((scenario) => wanted.has(scenario.id));
  if (selected.length === 0) {
    console.error("no scenarios matched " + [...wanted].join(", "));
    return 2;
  }
  const results = [];
  for (const scenario of selected) {
    console.log("running " + scenario.id + " (" + scenario.world + ")...");
    const result = await runScenario(scenario);
    results.push(result);
    console.log("  " + (result.pass ? "PASS" : "FAIL") + " in " + Math.round(result.durationMs / 100) / 10 + "s");
    for (const assertion of result.assertions) {
      if (!assertion.pass) console.log("    assertion failed: " + assertion.assertion.kind + " — " + assertion.detail.replaceAll("\n", " "));
    }
    if (result.error !== undefined) console.log("    run error: " + result.error);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const written = writeReport(outDir, results, stamp);
  console.log("report: " + written.markdown);
  return results.every((result) => result.pass) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
