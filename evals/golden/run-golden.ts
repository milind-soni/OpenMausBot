import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioSchema, type Scenario } from "../types.ts";
import type { ScenarioResult } from "../scorers/snapshot.ts";
import { renderMarkdown, writeReport } from "../reports/write-report.ts";
import { runScenario } from "../runners/run-scenario.ts";
import { behaviorTrace, type BehaviorTrace } from "./trace/behavior-trace.ts";
import { diffTrace } from "./trace/diff-trace.ts";

/** Tier 2, step two: replay redacted golden-thread fixtures through the
 * mock provider (the same real-server, scripted-engine path as tier 1) and
 * assert the behavior trace is stable against the committed baseline. A
 * drift anywhere in tool sequence, argument-key shape, error outcomes,
 * handoff tree, send admission, or the overall outcome fails the run with
 * a readable delta; --update-baseline rewrites baselines on purpose. */

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)));
export const GOLDEN_SCENARIOS_DIR = join(GOLDEN_DIR, "scenarios");
export const GOLDEN_BASELINES_DIR = join(GOLDEN_DIR, "baselines");
const DEFAULT_OUT = join(GOLDEN_DIR, "..", "reports", "runs");

export function loadGoldenScenarios(dir: string = GOLDEN_SCENARIOS_DIR): Scenario[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = scenarioSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.golden === undefined) {
        throw new Error(name + " is not a golden fixture: missing golden provenance");
      }
      return parsed;
    });
}

export interface GoldenOutcome {
  results: ScenarioResult[];
  deltas: Array<{ id: string; lines: string[] }>;
  updatedBaselines: string[];
  missingBaselines: string[];
  pass: boolean;
}

function baselinePath(id: string): string {
  return join(GOLDEN_BASELINES_DIR, id + ".trace.json");
}

export async function runGolden(options: {
  updateBaseline?: boolean;
  outDir?: string;
  only?: Set<string>;
} = {}): Promise<GoldenOutcome> {
  const all = loadGoldenScenarios();
  const selected = options.only === undefined || options.only.size === 0
    ? all
    : all.filter((scenario) => options.only?.has(scenario.id));
  const unknown = options.only === undefined
    ? []
    : [...options.only].filter((id) => !all.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new Error("unknown golden scenarios: " + unknown.join(", "));

  const results: ScenarioResult[] = [];
  const deltas: Array<{ id: string; lines: string[] }> = [];
  const updatedBaselines: string[] = [];
  const missingBaselines: string[] = [];

  for (const scenario of selected) {
    console.log("replaying golden " + scenario.id + "...");
    const result = await runScenario(scenario);
    results.push(result);
    console.log("  " + (result.pass ? "PASS" : "FAIL") + " in " + Math.round(result.durationMs / 100) / 10 + "s");
    const trace = behaviorTrace(result);
    const path = baselinePath(scenario.id);
    if (options.updateBaseline) {
      mkdirSync(GOLDEN_BASELINES_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(trace, null, 2) + "\n");
      updatedBaselines.push(path);
      continue;
    }
    if (!existsSync(path)) {
      missingBaselines.push(scenario.id);
      deltas.push({ id: scenario.id, lines: ["no baseline committed; run with --update-baseline to pin the current trace"] });
      continue;
    }
    const baseline = JSON.parse(readFileSync(path, "utf8")) as BehaviorTrace;
    const lines = diffTrace(baseline, trace);
    if (lines.length > 0) deltas.push({ id: scenario.id, lines });
  }

  const outDir = options.outDir ?? DEFAULT_OUT;
  if (results.length > 0) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const markdown = renderGoldenMarkdown(results, deltas, updatedBaselines, missingBaselines);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "golden-" + stamp + ".md"), markdown + "\n");
    const written = writeReport(outDir, results, "golden-" + stamp);
    console.log("report: " + written.markdown);
  }

  const pass = results.every((result) => result.pass) && deltas.length === 0 && missingBaselines.length === 0;
  return { results, deltas, updatedBaselines, missingBaselines, pass };
}

export function renderGoldenMarkdown(
  results: ScenarioResult[],
  deltas: Array<{ id: string; lines: string[] }>,
  updatedBaselines: string[],
  missingBaselines: string[],
): string {
  const lines: string[] = [
    "# Golden-thread replay report",
    "",
    "- Generated: " + new Date().toISOString(),
    "- Outcome: " + (deltas.length === 0 && missingBaselines.length === 0 && results.every((r) => r.pass) ? "PASS" : "FAIL"),
    "- Golden scenarios: " + results.length,
    "- Baselines updated: " + updatedBaselines.length,
    "",
    renderMarkdown(results),
    "",
    "## Trace baseline deltas",
    "",
  ];
  if (deltas.length === 0 && missingBaselines.length === 0) {
    lines.push("All golden traces match their committed baselines.", "");
  }
  for (const delta of deltas) {
    lines.push("### " + delta.id, "");
    for (const line of delta.lines) lines.push("- " + line);
    lines.push("");
  }
  for (const id of missingBaselines) lines.push("- " + id + ": no committed baseline");
  if (missingBaselines.length > 0) lines.push("");
  return lines.join("\n");
}
