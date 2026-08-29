import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSandboxIsolated, createBenchmarkSandbox } from "./sandbox.ts";
import { createDeterministicAdapter } from "./fixtures.ts";
import { getScenario } from "./scenarios.ts";
import { scoreScenario } from "./scorer.ts";
import { ALL_TOPOLOGIES, DETERMINISTIC_TOPOLOGIES, routeAction, summarizeTopology, validateTopology, type AgentTopology, type TopologyBenchmarkResult } from "./topologies.ts";
import type { BenchmarkAdapter, BenchmarkResult, RunOptions, ScenarioDefinition } from "./types.ts";

export async function runScenario(definition: ScenarioDefinition, options: RunOptions = {}): Promise<BenchmarkResult> {
  const sandbox = await createBenchmarkSandbox();
  assertSandboxIsolated(sandbox.paths);
  let adapter: BenchmarkAdapter | undefined;
  try {
    if (options.topology) validateTopology(options.topology);
    adapter = options.adapter ?? options.adapterFactory?.(sandbox) ?? createDeterministicAdapter(options);
    if (adapter.requiresSandboxBinding) {
      if (!adapter.bindSandbox) throw new Error(`benchmark adapter ${adapter.name} does not support sandbox binding`);
      adapter.bindSandbox(sandbox);
    }
    const activeAdapter = adapter;
    const maxRetries = options.maxRetries ?? definition.maxRetries ?? 1;
    for (const [actionIndex, action] of definition.actions.entries()) {
      const routedAction = options.topology
        ? { ...action, agentId: routeAction(options.topology, action, actionIndex) }
        : action;
      let attempt = 1;
      while (true) {
        const event = await activeAdapter.perform(definition.id, routedAction, attempt);
        if (event.status === "ok" || event.status === "blocked" || event.status === "dry-run") break;
        if (attempt > maxRetries) break;
        attempt += 1;
      }
    }
    const eventList = activeAdapter.events;
    const score = scoreScenario(definition, eventList, options.budgets, activeAdapter.evidenceMode);
    const result: BenchmarkResult = {
      scenario: { id: definition.id, title: definition.title, tags: definition.tags },
      ...score,
      events: eventList,
      sandbox: sandbox.paths,
      adapter: activeAdapter.name,
    };
    if (options.topology) result.topology = summarizeTopology(options.topology);
    await appendFile(join(sandbox.paths.traces, "events.ndjson"), eventList.map((event) => JSON.stringify(event)).join("\n") + "\n");
    return result;
  } finally {
    await adapter?.dispose?.();
    if (!options.retainSandbox) await sandbox.dispose();
  }
}

export async function runScenarioById(id: string, options: RunOptions = {}): Promise<BenchmarkResult> {
  return runScenario(getScenario(id), options);
}

export async function runAllScenarios(options: RunOptions = {}): Promise<readonly BenchmarkResult[]> {
  const { SCENARIOS } = await import("./scenarios.ts");
  return Promise.all(SCENARIOS.map((scenario) => runScenario(scenario, options)));
}

export async function runTopology(topology: AgentTopology, options: RunOptions = {}): Promise<TopologyBenchmarkResult<BenchmarkResult>> {
  validateTopology(topology);
  const results = await runAllScenarios({ ...options, topology });
  return { topology: summarizeTopology(topology), results, passed: results.every((result) => result.passed) };
}

/** Run all required topologies plus the optional compatibility template. */
export async function runAllTopologyBenchmarks(options: RunOptions = {}): Promise<readonly TopologyBenchmarkResult<BenchmarkResult>[]> {
  return Promise.all(ALL_TOPOLOGIES.map((topology) => runTopology(topology, options)));
}

/** Required matrix used by CI; the named Chief/Capture shape is opt-in. */
export async function runDeterministicTopologyCoverage(options: RunOptions = {}): Promise<readonly TopologyBenchmarkResult<BenchmarkResult>[]> {
  return Promise.all(DETERMINISTIC_TOPOLOGIES.map((topology) => runTopology(topology, options)));
}
