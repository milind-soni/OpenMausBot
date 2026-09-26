import { describe, expect, it } from "vitest";
import type { Assertion } from "../types.ts";
import type { AssertionResult } from "./assertions.ts";
import type { ScenarioResult } from "./snapshot.ts";
import { estimateTokens, mean, scoreSkillBench, stddev } from "./skill-bench.ts";
import { skillBenchSchema, type SkillBenchArmRun } from "../runners/run-skill-bench.ts";

function fakeResult(
  id: string,
  assertions: Array<{ kind: Assertion["kind"]; pass: boolean }>,
  options: { systemChars?: number; durationMs?: number } = {},
): ScenarioResult {
  const assertionResults: AssertionResult[] = assertions.map((assertion) => ({
    assertion: { kind: assertion.kind } as Assertion,
    pass: assertion.pass,
    detail: assertion.pass ? "matched" : "differed",
  }));
  return {
    id,
    title: id,
    behavior: "",
    world: "coordination",
    pass: assertions.every((assertion) => assertion.pass),
    startedAt: new Date().toISOString(),
    durationMs: options.durationMs ?? 100,
    steps: [],
    assertions: assertionResults,
    assertionsInput: [],
    evidence: {
      turns: [
        {
          bot: "worker",
          index: 0,
          threadId: "t",
          system: "x".repeat(options.systemChars ?? 40),
          prompt: "y".repeat(20),
          toolCalls: [],
        },
      ],
      handoffs: [],
      sends: [],
    },
  };
}

const fixture = skillBenchSchema.parse({
  id: "fake-bench",
  title: "Fake bench",
  behavior: "Contrived fixture for scorer tests",
  skill: {
    id: "fake-skill",
    name: "Fake Skill",
    version: "0.1.0",
    description: "Contrived",
    defaultEnabled: true,
    triggerTerms: ["fake"],
    requiredCapabilities: [],
    skillMd: "---\nname: fake-skill\ndescription: Contrived\n---\n\n# Fake\n",
  },
  subject: { key: "worker", name: "Worker" },
  prompts: [
    {
      id: "p1",
      text: "fake prompt one",
      assertions: [
        { kind: "systemPromptIncludes", bot: "worker", turn: 0, includes: "<openmaus-skill" },
        { kind: "promptIncludes", bot: "worker", turn: 0, includes: "fake" },
      ],
      withSkill: { turns: [{ reply: "with" }] },
      withoutSkill: { turns: [{ reply: "without" }] },
    },
    {
      id: "p2",
      text: "fake prompt two",
      assertions: [
        { kind: "systemPromptIncludes", bot: "worker", turn: 0, includes: "<openmaus-skill" },
        { kind: "promptIncludes", bot: "worker", turn: 0, includes: "fake" },
      ],
      withSkill: { turns: [{ reply: "with" }] },
      withoutSkill: { turns: [{ reply: "without" }] },
    },
  ],
  replicates: 1,
});

describe("skill bench scorers", () => {
  it("computes mean and sample standard deviation", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
    expect(stddev([1, 2, 3])).toBeCloseTo(1, 10);
    expect(stddev([5])).toBe(0);
    expect(stddev([])).toBe(0);
  });

  it("estimates tokens deterministically from evidence turns", () => {
    const small = estimateTokens(fakeResult("small", [], { systemChars: 40 }));
    const large = estimateTokens(fakeResult("large", [], { systemChars: 400 }));
    expect(small).toBe(Math.ceil((40 + 20 + 2) / 4));
    expect(large).toBeGreaterThan(small);
    expect(estimateTokens(fakeResult("same", [], { systemChars: 400 }))).toBe(large);
  });

  it("scores deltas, non-discriminating controls, and run errors", () => {
    const runs: SkillBenchArmRun[] = [];
    const verdict = (promptId: string, arm: "with" | "without", replicate: number, systemPass: boolean, promptPass = true) =>
      runs.push({
        promptId,
        arm,
        replicate,
        result: fakeResult(promptId + "/" + arm + "#" + replicate, [
          { kind: "systemPromptIncludes", pass: systemPass },
          { kind: "promptIncludes", pass: promptPass },
        ]),
      });
    verdict("p1", "with", 1, true);
    verdict("p2", "with", 1, true);
    verdict("p1", "without", 1, false);
    verdict("p2", "without", 1, false);

    const report = scoreSkillBench(fixture, runs);
    expect(report.summary.withSkill.passRate).toBe(1);
    expect(report.summary.withoutSkill.passRate).toBe(0.5);
    expect(report.assertions[0]).toMatchObject({ delta: 1, nonDiscriminating: false, highVariance: false });
    expect(report.assertions[1]).toMatchObject({ delta: 0, nonDiscriminating: true });
    expect(report.summary.flags.nonDiscriminating).toBe(1);
    expect(report.errors).toEqual([]);

    const errored = fakeResult("boom", [{ kind: "systemPromptIncludes", pass: false }]);
    errored.error = "server did not answer";
    const withError = scoreSkillBench(fixture, [...runs, { promptId: "p1", arm: "with", replicate: 2, result: errored }]);
    expect(withError.errors).toHaveLength(1);
  });

  it("flags verdict flips across replicates of the same prompt and arm", () => {
    const runs: SkillBenchArmRun[] = [
      { promptId: "p1", arm: "with", replicate: 1, result: fakeResult("a", [{ kind: "systemPromptIncludes", pass: true }, { kind: "promptIncludes", pass: true }]) },
      { promptId: "p1", arm: "with", replicate: 2, result: fakeResult("b", [{ kind: "systemPromptIncludes", pass: false }, { kind: "promptIncludes", pass: true }]) },
      { promptId: "p1", arm: "without", replicate: 1, result: fakeResult("c", [{ kind: "systemPromptIncludes", pass: false }, { kind: "promptIncludes", pass: true }]) },
      { promptId: "p1", arm: "without", replicate: 2, result: fakeResult("d", [{ kind: "systemPromptIncludes", pass: false }, { kind: "promptIncludes", pass: true }]) },
    ];
    const report = scoreSkillBench(fixture, runs);
    expect(report.assertions[0].highVariance).toBe(true);
    expect(report.assertions[1].highVariance).toBe(false);
    expect(report.summary.flags.highVariance).toBe(1);
  });
});
