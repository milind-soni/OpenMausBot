import { resolve } from "node:path";

import { runProductJourneyHost } from "../benchmarks/agent-centipede/product-journey-host.mjs";

const option = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value?.slice(prefix.length);
};

const repoRoot = resolve(".");
const stateRoot = resolve(option("state-root") ?? "benchmarks/agent-centipede/.local-runs/product-journey");
const outputDir = resolve(option("output") ?? "artifacts/centipede-0.2.0/benchmark/journey");
const result = await runProductJourneyHost({ repoRoot, stateRoot, outputDir, mode: "drive" });
process.stdout.write(`${JSON.stringify({ passed: result.passed, output: "artifacts/centipede-0.2.0/benchmark/journey/drive-result.json" })}\n`);
