import { describe, expect, it } from "vitest";
import { buildArmScenario, loadSkillBenches, runSkillBench } from "./run-skill-bench.ts";

// The bench is tested by a fixture skill with known outcomes: three
// prompts where the with-skill arm must pass every assertion and the
// without-skill arm must fail the skill-effect assertions while keeping
// the control assertion green.
describe("skill bench runner", () => {
  const benches = loadSkillBenches();

  it("loads the founding fixture", () => {
    expect(benches.map((bench) => bench.id)).toContain("bench-triage-handoff");
  });

  it("builds with/without scenarios that differ only by the installSkill step", () => {
    const bench = benches.find((entry) => entry.id === "bench-triage-handoff")!;
    const withScenario = buildArmScenario(bench, bench.prompts[0]!, "with", 1);
    const withoutScenario = buildArmScenario(bench, bench.prompts[0]!, "without", 1);
    expect(withScenario.steps[0]).toMatchObject({ kind: "installSkill" });
    expect(withoutScenario.steps.map((step) => step.kind)).not.toContain("installSkill");
    expect(withScenario.assertions).toEqual(bench.prompts[0]!.assertions);
    expect(withoutScenario.assertions).toEqual(bench.prompts[0]!.assertions);
    expect(withScenario.bots[0]!.turns).toEqual(bench.prompts[0]!.withSkill.turns);
    expect(withoutScenario.bots[0]!.turns).toEqual(bench.prompts[0]!.withoutSkill.turns);
  });

  it("produces the alpha report for the fixture skill with known outcomes", async () => {
    const bench = benches.find((entry) => entry.id === "bench-triage-handoff")!;
    const report = await runSkillBench(bench);

    // Every arm-run completed: a red without-skill arm is data, an error is not.
    expect(report.errors).toEqual([]);
    expect(report.prompts).toHaveLength(3);

    // With the skill: the block rides the system prompt, the scripted
    // follower dispatches, and every assertion holds.
    expect(report.summary.withSkill.passRate).toBe(1);
    expect(report.summary.withSkill.total).toBe(12);

    // Without it: prompt delivery still holds (control) but no skill
    // block, no dispatch, no target turn.
    expect(report.summary.withoutSkill.passRate).toBe(0.25);

    // Deltas: three discriminating assertions at +1, one control at 0.
    expect(report.assertions.filter((assertion) => assertion.delta === 1)).toHaveLength(3);
    expect(report.summary.flags.nonDiscriminating).toBe(1);
    expect(report.summary.flags.highVariance).toBe(0);

    // Measurement surfaces exist; the skill block also costs prompt tokens.
    expect(report.summary.withSkill.durationMeanMs).toBeGreaterThan(0);
    expect(report.summary.withoutSkill.estimatedTokensMean).toBeGreaterThan(0);
    expect(report.summary.withSkill.estimatedTokensMean).toBeGreaterThan(report.summary.withoutSkill.estimatedTokensMean);
  }, 300_000);
});
