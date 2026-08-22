// The floor gate's whole job is to distrust green runs, so its decision logic
// must be provably right without spawning a nested suite. evaluateRun is a
// pure function over (exit code, JSON summary) precisely so it can be pinned
// down here; the process-spawning half of test-floor.mjs stays a thin shell
// around it.
import { describe, expect, it } from "vitest";
import { evaluateRun, isTargetedRun, TEST_COUNT_FLOOR, vitestArguments } from "./test-floor.mjs";

const summary = (overrides = {}) => ({
  numTotalTests: 1000,
  success: true,
  ...overrides,
});

describe("evaluateRun", () => {
  it("passes a green run at or above the floor", () => {
    expect(evaluateRun({ exitCode: 0, summary: summary() }, 1000).ok).toBe(true);
    expect(evaluateRun({ exitCode: 0, summary: summary() }, 999).ok).toBe(true);
  });

  it("fails a green run below the floor — the failure mode this gate exists for", () => {
    const result = evaluateRun({ exitCode: 0, summary: summary({ numTotalTests: 999 }) }, 1000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("999");
    expect(result.message).toContain("1000");
    // the message must point at the real culprit, not just say "too few"
    expect(result.message).toMatch(/import|collection/);
  });

  it("refuses to pass when the count cannot be determined", () => {
    // A run that cannot be counted has exactly the shape of a collection
    // failure, so "unknown" must never be promoted to "fine".
    for (const broken of [
      null,
      undefined,
      {},
      summary({ numTotalTests: undefined }),
      summary({ numTotalTests: NaN }),
      summary({ numTotalTests: "1000" }),
    ]) {
      const result = evaluateRun({ exitCode: 0, summary: broken }, 1);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("cannot be counted");
    }
  });

  it("propagates a vitest failure even when the count clears the floor", () => {
    expect(evaluateRun({ exitCode: 1, summary: summary() }, 1).ok).toBe(false);
    // killed by a signal: exit code is null, still a failure
    expect(evaluateRun({ exitCode: null, summary: summary() }, 1).ok).toBe(false);
  });

  it("trusts the summary's own failure flag over a zero exit code", () => {
    const result = evaluateRun({ exitCode: 0, summary: summary({ success: false }) }, 1);
    expect(result.ok).toBe(false);
  });

  it("uses TEST_COUNT_FLOOR as the default floor", () => {
    const atFloor = summary({ numTotalTests: TEST_COUNT_FLOOR });
    const belowFloor = summary({ numTotalTests: TEST_COUNT_FLOOR - 1 });
    expect(evaluateRun({ exitCode: 0, summary: atFloor }).ok).toBe(true);
    expect(evaluateRun({ exitCode: 0, summary: belowFloor }).ok).toBe(false);
  });

  it("allows an intentional targeted run without weakening its exit checks", () => {
    expect(evaluateRun({ exitCode: 0, summary: summary({ numTotalTests: 1 }) }, null)).toMatchObject({ ok: true });
    expect(evaluateRun({ exitCode: 1, summary: summary({ numTotalTests: 1 }) }, null)).toMatchObject({ ok: false });
  });
});

describe("isTargetedRun", () => {
  it("recognizes positional file filters and Vitest collection filters", () => {
    expect(isTargetedRun(["server/config.test.ts"])).toBe(true);
    expect(isTargetedRun(["--testNamePattern", "credential"])).toBe(true);
    expect(isTargetedRun(["--changed=origin/main"])).toBe(true);
    expect(isTargetedRun(["--project", "unit"])).toBe(true);
  });

  it("keeps the floor for an unfiltered run with execution-only options", () => {
    expect(isTargetedRun([])).toBe(false);
    expect(isTargetedRun(["--coverage", "--pool=threads"])).toBe(false);
  });

  it("forwards the caller's filters to Vitest", () => {
    expect(vitestArguments("/vitest.mjs", "/summary.json", ["server/config.test.ts", "-t", "env"]))
      .toEqual([
        "/vitest.mjs",
        "run",
        "server/config.test.ts",
        "-t",
        "env",
        "--reporter=default",
        "--reporter=json",
        "--outputFile.json=/summary.json",
      ]);
  });
});
