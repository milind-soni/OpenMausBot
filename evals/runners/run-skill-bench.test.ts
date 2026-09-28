import { describe, expect, it } from "vitest";
import { buildArmScenario, DEFAULT_OUT, loadSkillBenches, parseSkillBenchArgs, runSkillBench, skillBenchSchema } from "./run-skill-bench.ts";

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

    // Deltas: per prompt, three discriminating assertions at +1 and one
    // control at 0 — nine and three across the three prompts, each labeled
    // with the prompt it belongs to.
    expect(report.assertions).toHaveLength(12);
    expect(report.assertions.filter((assertion) => assertion.delta === 1)).toHaveLength(9);
    expect(report.summary.flags.nonDiscriminating).toBe(3);
    expect(report.summary.flags.highVariance).toBe(0);
    expect(new Set(report.assertions.map((assertion) => assertion.promptId))).toEqual(
      new Set(bench.prompts.map((prompt) => prompt.id)),
    );

    // Measurement surfaces exist; the skill block also costs prompt tokens.
    expect(report.summary.withSkill.durationMeanMs).toBeGreaterThan(0);
    expect(report.summary.withoutSkill.estimatedTokensMean).toBeGreaterThan(0);
    expect(report.summary.withSkill.estimatedTokensMean).toBeGreaterThan(report.summary.withoutSkill.estimatedTokensMean);
  }, 300_000);
});

describe("parseSkillBenchArgs", () => {
  it("parses repeated fixtures, replicates, and out together", () => {
    const parsed = parseSkillBenchArgs(["--fixture", "a", "--fixture", "b", "--replicates", "3", "--out", "/tmp/skill-bench"]);
    expect(parsed).toEqual({
      ok: true,
      options: { wanted: new Set(["a", "b"]), replicates: 3, outDir: "/tmp/skill-bench" },
    });
  });

  it("defaults to every fixture, fixture replicates, and the reports dir", () => {
    const parsed = parseSkillBenchArgs([]);
    expect(parsed).toEqual({ ok: true, options: { wanted: new Set(), replicates: undefined, outDir: DEFAULT_OUT } });
  });

  it("rejects replicates that are not positive integers instead of silently running zero", () => {
    for (const value of ["abc", "", "2.5", "0", "-1", "Infinity"]) {
      expect(parseSkillBenchArgs(["--replicates", value])).toEqual({
        ok: false,
        error: "--replicates must be a positive integer",
      });
    }
  });

  it("rejects flags without a value", () => {
    expect(parseSkillBenchArgs(["--fixture"])).toEqual({ ok: false, error: "--fixture requires a value" });
    expect(parseSkillBenchArgs(["--replicates"])).toEqual({ ok: false, error: "--replicates requires a value" });
    expect(parseSkillBenchArgs(["--out"])).toEqual({ ok: false, error: "--out requires a value" });
  });

  it("rejects an unknown option instead of running defaults", () => {
    expect(parseSkillBenchArgs(["--replicate", "10"])).toEqual({ ok: false, error: "unknown option --replicate" });
  });

  it("rejects an unexpected positional argument", () => {
    expect(parseSkillBenchArgs(["my-bench"])).toEqual({ ok: false, error: "unexpected argument my-bench" });
  });

  it("rejects a flag consumed as another flag's value", () => {
    expect(parseSkillBenchArgs(["--out", "--fixture", "my-bench"])).toEqual({
      ok: false,
      error: "--out requires a value",
    });
  });
});

describe("skillBenchSchema", () => {
  const bench = loadSkillBenches().find((entry) => entry.id === "bench-triage-handoff")!;

  it("accepts the founding fixture", () => {
    expect(skillBenchSchema.safeParse(bench).success).toBe(true);
  });

  it("rejects a fixture with no prompts to measure", () => {
    const parsed = skillBenchSchema.safeParse({ ...bench, prompts: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a prompt whose assertions check nothing", () => {
    const parsed = skillBenchSchema.safeParse({
      ...bench,
      prompts: [{ ...bench.prompts[0]!, assertions: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate prompt ids instead of folding their runs together", () => {
    const parsed = skillBenchSchema.safeParse({
      ...bench,
      prompts: [bench.prompts[0]!, { ...bench.prompts[1]!, id: bench.prompts[0]!.id }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message === "prompt ids must be unique")).toBe(true);
    }
  });
});

describe("buildArmScenario target waits", () => {
  const bench = loadSkillBenches().find((entry) => entry.id === "bench-triage-handoff")!;
  const subjectKey = bench.subject.key;

  const waitedBots = (scenario: ReturnType<typeof buildArmScenario>): string[] =>
    scenario.steps.flatMap((step) => (step.kind === "waitForTurns" ? [step.bot] : []));

  it("keeps the founding fixture's duty wait: the script dispatches to @duty", () => {
    const scenario = buildArmScenario(bench, bench.prompts[0]!, "with", 1);
    expect(waitedBots(scenario)).toEqual([subjectKey, "duty"]);
  });

  it("never waits on targets in the without arm", () => {
    const scenario = buildArmScenario(bench, bench.prompts[0]!, "without", 1);
    expect(waitedBots(scenario)).toEqual([subjectKey]);
  });

  it("skips target waits when the with-arm script dispatches to nobody", () => {
    const prompt = { ...bench.prompts[0]!, withSkill: { turns: [{ reply: "Handled inline; nobody dispatched." }] } };
    const scenario = buildArmScenario(bench, prompt, "with", 1);
    expect(waitedBots(scenario)).toEqual([subjectKey]);
  });

  it("waits only for the targets this prompt's script names", () => {
    const secondTarget = { key: "ops", name: "Ops runner", turns: [{ reply: "Ops handled." }] };
    const prompt = {
      ...bench.prompts[0]!,
      withSkill: {
        turns: [
          {
            steps: [{ arguments: { bot_ids: ["@ops"], request_key: "triage", message: "Handle this." } }],
            reply: "Assigned to ops.",
          },
        ],
      },
    };
    const scenario = buildArmScenario({ ...bench, targets: [...bench.targets, secondTarget] }, prompt, "with", 1);
    expect(waitedBots(scenario)).toEqual([subjectKey, "ops"]);
  });

  it("ignores malformed bot_ids instead of treating them as a dispatch", () => {
    const prompt = {
      ...bench.prompts[0]!,
      withSkill: { turns: [{ steps: [{ arguments: { bot_ids: "duty" } }], reply: "Assigned, probably." }] },
    };
    const scenario = buildArmScenario(bench, prompt, "with", 1);
    expect(waitedBots(scenario)).toEqual([subjectKey]);
  });
});
