/* oxlint-disable anti-slop/no-conditional-empty-object-spread
 * -- optional benchmark CLI flags are deliberately omitted from the profile
 * object when absent so fixtures cannot inherit live configuration. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBaseline,
  createHttpSandboxAdapter,
  createIndependentLocalFixtureAdapter,
  createProcessSandboxAdapter,
  evaluatePromotionGate,
  isBenchmarkBaseline,
  runAllScenarios,
  runAllTopologyBenchmarks,
  runScenarioById,
  getTopology,
  type BenchmarkBaseline,
  type BenchmarkAdapter,
  type RunOptions,
  type SandboxProfile,
} from "../benchmarks/agent-centipede/index.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const json = args.includes("--json");
const liveProcess = args.find((arg) => arg.startsWith("--live-process="))?.slice("--live-process=".length);
const httpEndpoint = args.find((arg) => arg.startsWith("--http-endpoint="))?.slice("--http-endpoint=".length);
const independentFixtures = args.includes("--independent-fixtures");
const scenarioArg = args.find((arg) => arg.startsWith("--scenario="));
const valueArg = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const topologyArg = valueArg("--topology");
const allTopologies = args.includes("--all-topologies");
if (topologyArg && allTopologies) throw new Error("choose one topology mode: --topology or --all-topologies");
const topology = topologyArg ? getTopology(topologyArg) : undefined;
const profileDir = valueArg("--profile-dir");
const dataRoot = valueArg("--data-root");
const traceDir = valueArg("--trace-dir") ?? (dataRoot ? join(dataRoot, "traces") : undefined);
const isLive = liveProcess !== undefined || httpEndpoint !== undefined;
if (liveProcess !== undefined && httpEndpoint !== undefined) throw new Error("choose one live adapter: --live-process or --http-endpoint");
if (independentFixtures && isLive) throw new Error("choose one benchmark adapter: --independent-fixtures or a live adapter");
if (isLive && (!profileDir || !dataRoot || !traceDir)) throw new Error("live benchmarks require explicit --profile-dir, --data-root, and --trace-dir");
const approvedActionIds = (valueArg("--approve") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const allowSideEffects = args.includes("--allow-side-effects");
const allowNetwork = args.includes("--allow-network");
const profile: SandboxProfile | undefined = profileDir && dataRoot && traceDir
  ? { profileDir, dataRoot, traceDir, dryRun: dryRun || !allowSideEffects, allowNetwork }
  : undefined;
const liveAdapterFactory = profile && isLive
  ? (): BenchmarkAdapter => liveProcess
    ? createProcessSandboxAdapter({ ...profile, command: liveProcess, approvedActionIds, allowSideEffects })
    : createHttpSandboxAdapter({ ...profile, endpoint: httpEndpoint ?? "", approvedActionIds, allowSideEffects })
  : undefined;
const adapterFactory = independentFixtures
  ? (): BenchmarkAdapter => createIndependentLocalFixtureAdapter()
  : liveAdapterFactory;
const budgets = {
  ...(valueArg("--max-latency-ms") ? { maxLatencyMs: Number(valueArg("--max-latency-ms")) } : {}),
  ...(valueArg("--max-cost-usd") ? { maxCostUsd: Number(valueArg("--max-cost-usd")) } : {}),
  ...(valueArg("--max-tokens") ? { maxTokens: Number(valueArg("--max-tokens")) } : {}),
  ...(valueArg("--max-attempts") ? { maxAttempts: Number(valueArg("--max-attempts")) } : {}),
};
const runOptions: RunOptions = { dryRun, budgets, retainSandbox: isLive, ...(adapterFactory ? { adapterFactory } : {}), ...(topology ? { topology } : {}) };
const topologyCoverage = allTopologies ? await runAllTopologyBenchmarks(runOptions) : undefined;
const results = topologyCoverage
  ? topologyCoverage.flatMap((coverage) => coverage.results)
  : scenarioArg
  ? [await runScenarioById(scenarioArg.slice("--scenario=".length), runOptions)]
  : await runAllScenarios(runOptions);
const baselinePath = valueArg("--baseline");
let baseline: BenchmarkBaseline | undefined;
if (baselinePath) {
  const parsed: unknown = JSON.parse(await readFile(baselinePath, "utf8"));
  if (!isBenchmarkBaseline(parsed)) throw new Error(`invalid benchmark baseline: ${baselinePath}`);
  baseline = parsed;
}
const promotion = args.includes("--promote") ? evaluatePromotionGate(results, baseline) : undefined;
const writeBaselinePath = valueArg("--write-baseline");
if (writeBaselinePath) await writeFile(writeBaselinePath, `${JSON.stringify(createBaseline(results), null, 2)}\n`, "utf8");

if (json) {
  console.log(JSON.stringify({ results, ...(topologyCoverage ? { topologies: topologyCoverage } : {}), ...(promotion ? { promotion } : {}) }, null, 2));
} else {
  const mode = independentFixtures ? "independent local fixtures" : isLive ? "live adapter" : "deterministic sandbox";
  console.log(`Agent Centipede benchmark lab (${mode})`);
  if (topologyCoverage) {
    for (const coverage of topologyCoverage) console.log(`topology ${coverage.topology.id}: ${coverage.passed ? "PASS" : "FAIL"}`);
  }
  for (const result of results) {
    const evidenceLabel = `${result.evidence.outcomeScore.toFixed(1)}% outcome evidence${result.evidence.e2eVerified ? "" : " (not E2E)"}`;
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.scenario.id} ${result.score.toFixed(1)}% | ${evidenceLabel} | retries=${result.metrics.retries} cost=$${result.metrics.costUsd.toFixed(3)} latency=${result.metrics.latencyMs}ms`);
  }
  const passed = results.filter((result) => result.passed).length;
  console.log(`${passed}/${results.length} scenarios passed${dryRun ? " (dry-run)" : ""}`);
  if (promotion) console.log(`promotion: ${promotion.promotable ? "PROMOTE" : "BLOCKED"}${promotion.reasons.length ? ` (${promotion.reasons.join(", ")})` : ""}`);
  if (passed !== results.length && !dryRun) process.exitCode = 1;
  if (promotion && !promotion.promotable) process.exitCode = 1;
}
