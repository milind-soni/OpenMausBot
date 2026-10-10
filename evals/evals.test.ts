import { describe, expect, it } from "vitest";
import { runScenario } from "./runners/run-scenario.ts";
import { loadScenarios } from "./runners/run-evals.ts";

// The offline tier-1 gate: every scenario runs against a freshly booted
// real server with the deterministic scripted engine. These are the
// behavior pins the release report diffs.
describe("behavior evals", () => {
  const scenarios = loadScenarios();
  it("loads at least the founding scenario set", () => {
    expect(scenarios.map((scenario) => scenario.id)).toContain("dispatch-supersede");
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it.each(scenarios)("$id pins its behavior", async (scenario) => {
    const result = await runScenario(scenario);
    if (result.pass) return;
    const failures = result.assertions
      .filter((assertion) => !assertion.pass)
      .map((assertion) => assertion.assertion.kind + ": " + assertion.detail)
      .join("\n");
    throw new Error(
      result.id + " failed" + (result.error === undefined ? "" : ": " + result.error) + "\n" + failures,
    );
  }, 180_000);
});
