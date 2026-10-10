import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../types.ts";
import { runScenario } from "../runners/run-scenario.ts";
import { GOLDEN_BASELINES_DIR, GOLDEN_SCENARIOS_DIR, loadGoldenScenarios } from "./run-golden.ts";
import { goldenExportSchema, redactThread } from "./redact/redact-thread.ts";
import { scanSerialized, scanStrings } from "./redact/leak-scan.ts";
import { behaviorTrace } from "./trace/behavior-trace.ts";
import { diffTrace } from "./trace/diff-trace.ts";

const SAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "samples", "coordination-handoff.sample.json");

describe("committed golden fixtures", () => {
  it("carry golden provenance and pass both leak scans", () => {
    const fixtures = loadGoldenScenarios();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of readdirSync(GOLDEN_SCENARIOS_DIR).filter((entry) => entry.endsWith(".json"))) {
      const raw = readFileSync(join(GOLDEN_SCENARIOS_DIR, name), "utf8");
      expect(scanSerialized(raw), name).toEqual([]);
      const parsed = JSON.parse(raw);
      expect(scanStrings(parsed), name).toEqual([]);
      expect(scenarioSchema.safeParse(parsed).success, name).toBe(true);
    }
  });

  it("are byte-identical to what the redactor produces from the sample export", () => {
    const exported = goldenExportSchema.parse(JSON.parse(readFileSync(SAMPLE_PATH, "utf8")));
    const { serialized } = redactThread(exported);
    const committed = readFileSync(join(GOLDEN_SCENARIOS_DIR, exported.meta.id + ".json"), "utf8");
    expect(serialized).toBe(committed);
  });
});

const scenarios = loadGoldenScenarios();
describe.each(scenarios.map((scenario) => [scenario.id]))("golden replay: %s", (id) => {
  const baselinePath = join(GOLDEN_BASELINES_DIR, String(id) + ".trace.json");
  it.skipIf(!existsSync(baselinePath))(
    "replays through the mock provider and matches the committed trace baseline",
    async () => {
      const scenario = scenarios.find((entry) => entry.id === id);
      if (scenario === undefined) throw new Error("missing scenario " + String(id));
      const result = await runScenario(scenario);
      expect(result.error ?? "", result.error).toBe("");
      expect(result.assertions.filter((assertion) => !assertion.pass)).toEqual([]);
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      expect(diffTrace(baseline, behaviorTrace(result))).toEqual([]);
    },
    180_000,
  );
});
