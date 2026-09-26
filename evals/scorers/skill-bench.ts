import type { ScenarioResult } from "./snapshot.ts";
import type {
  SkillBenchArmRun,
  SkillBenchArmSummary,
  SkillBenchAssertionDelta,
  SkillBenchFixture,
  SkillBenchReport,
} from "../runners/run-skill-bench.ts";

/** Pure scorers for the skill bench. The runner only produces arm runs
 * (with-skill and without-skill ScenarioResults); every number in the
 * alpha report is computed here from frozen results, never from a live
 * server. */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation (n - 1). A single sample carries no variance
 * information, so n < 2 reports 0; the report separately states the
 * replicate count so a 0 is never read as "no variance observed". */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

/** The scripted provider makes no API calls, so there are no real token
 * counts to read. This is a deterministic chars/4 estimate of what rode
 * the prompt (system + user prompt + tool-call JSON per evidence turn);
 * the live tier is where measured usage replaces it. */
export function estimateTokens(result: ScenarioResult): number {
  let chars = 0;
  for (const turn of result.evidence.turns) {
    chars += turn.system.length + turn.prompt.length + JSON.stringify(turn.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

function armSummary(runs: SkillBenchArmRun[]): SkillBenchArmSummary {
  const assertionResults = runs.flatMap((run) => run.result.assertions);
  const durations = runs.map((run) => run.result.durationMs);
  const tokens = runs.map((run) => estimateTokens(run.result));
  return {
    runs: runs.length,
    passed: assertionResults.filter((assertion) => assertion.pass).length,
    total: assertionResults.length,
    passRate: assertionResults.length === 0 ? 0 : assertionResults.filter((a) => a.pass).length / assertionResults.length,
    durationMeanMs: mean(durations),
    durationStddevMs: stddev(durations),
    estimatedTokensMean: mean(tokens),
    estimatedTokensStddev: stddev(tokens),
  };
}

/** An assertion is non-discriminating when its pass rate is identical in
 * both arms: it pins something true regardless of the skill, so it cannot
 * attribute any change to the skill under test. Such assertions are still
 * useful as controls; the flag keeps them out of the effect story. */
function assertionDeltas(bench: SkillBenchFixture, runs: SkillBenchArmRun[]): SkillBenchAssertionDelta[] {
  const template = bench.prompts[0]?.assertions ?? [];
  return template.map((assertion, index) => {
    const withRuns = runs.filter((run) => run.arm === "with");
    const withoutRuns = runs.filter((run) => run.arm === "without");
    const withPasses = withRuns.filter((run) => run.result.assertions[index]?.pass === true).length;
    const withoutPasses = withoutRuns.filter((run) => run.result.assertions[index]?.pass === true).length;
    const withRate = withRuns.length === 0 ? 0 : withPasses / withRuns.length;
    const withoutRate = withoutRuns.length === 0 ? 0 : withoutPasses / withoutRuns.length;
    // High variance: within one prompt and arm, replicates of the same
      // run disagree about this assertion. Only assessable with n >= 2.
    let highVariance = false;
    for (const prompt of bench.prompts) {
      for (const arm of ["with", "without"] as const) {
        const group = runs.filter((run) => run.promptId === prompt.id && run.arm === arm);
        const verdicts = new Set(group.map((run) => run.result.assertions[index]?.pass === true));
        if (group.length >= 2 && verdicts.size > 1) highVariance = true;
      }
    }
    const label = "#" + index + " " + assertion.kind + ("bot" in assertion ? " (" + assertion.bot + ")" : "");
    return {
      index,
      label,
      withPasses,
      withoutPasses,
      withRuns: withRuns.length,
      withoutRuns: withoutRuns.length,
      withRate,
      withoutRate,
      delta: withRate - withoutRate,
      nonDiscriminating: withRate === withoutRate,
      highVariance,
    };
  });
}

export function scoreSkillBench(bench: SkillBenchFixture, runs: SkillBenchArmRun[]): SkillBenchReport {
  const assertions = assertionDeltas(bench, runs);
  return {
    fixtureId: bench.id,
    title: bench.title,
    behavior: bench.behavior,
    generatedAt: new Date().toISOString(),
    replicates: bench.replicates,
    prompts: bench.prompts.map((prompt) => ({
      promptId: prompt.id,
      text: prompt.text,
      runs: runs
        .filter((run) => run.promptId === prompt.id)
        .map((run) => ({
          arm: run.arm,
          replicate: run.replicate,
          pass: run.result.pass,
          durationMs: run.result.durationMs,
          estimatedTokens: estimateTokens(run.result),
          failedAssertions: run.result.assertions
            .filter((assertion) => !assertion.pass)
            .map((assertion) => assertion.assertion.kind + ": " + assertion.detail.replaceAll("\n", " ")),
          error: run.result.error,
        })),
    })),
    assertions,
    summary: {
      withSkill: armSummary(runs.filter((run) => run.arm === "with")),
      withoutSkill: armSummary(runs.filter((run) => run.arm === "without")),
      flags: {
        nonDiscriminating: assertions.filter((assertion) => assertion.nonDiscriminating).length,
        highVariance: assertions.filter((assertion) => assertion.highVariance).length,
      },
    },
    errors: runs.filter((run) => run.result.error !== undefined).map((run) => run.promptId + "/" + run.arm + "#" + run.replicate + ": " + run.result.error),
  };
}
