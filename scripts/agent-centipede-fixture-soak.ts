import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createIndependentLocalFixtureAdapter, runAllScenarios } from "../benchmarks/agent-centipede/index.ts";

const valueArg = (name: string): string | undefined => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const iterations = Number(valueArg("--iterations") ?? "20");
const output = resolve(valueArg("--output") ?? "artifacts/agent-centipede-benchmark/independent-local-fixture-soak.json");
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000) throw new Error("iterations must be an integer from 1 to 1000");

const startedAt = Date.now();
let scenarioRuns = 0;
let retries = 0;
let failedRuns = 0;
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const results = await runAllScenarios({ adapterFactory: () => createIndependentLocalFixtureAdapter() });
  scenarioRuns += results.length;
  retries += results.reduce((sum, result) => sum + result.metrics.retries, 0);
  const failures = results.filter((result) => !result.passed || !result.evidence.e2eVerified || result.metrics.safetyViolations > 0);
  failedRuns += failures.length;
  if (failures.length > 0) throw new Error(`fixture soak failed on iteration ${iteration}: ${failures.map((result) => result.scenario.id).join(", ")}`);
}

const receipt = {
  schemaVersion: 1,
  mode: "independent-local-fixture-accelerated-soak",
  iterations,
  scenarioRuns,
  retries,
  failedRuns,
  durationMs: Date.now() - startedAt,
  productionWrites: 0,
  externalActions: 0,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt));
