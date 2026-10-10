import { describe, expect, it } from "vitest";

import { MAX_TOOL_ERROR_CORRECTIVE_ROUNDS, parseToolErrorCorrectiveRounds } from "./tool-error-recovery";

describe("parseToolErrorCorrectiveRounds", () => {
  it("accepts a whole number within the bounds", () => {
    expect(parseToolErrorCorrectiveRounds("0")).toEqual({ ok: true, rounds: 0 });
    expect(parseToolErrorCorrectiveRounds("2")).toEqual({ ok: true, rounds: 2 });
    expect(parseToolErrorCorrectiveRounds(String(MAX_TOOL_ERROR_CORRECTIVE_ROUNDS))).toEqual({ ok: true, rounds: MAX_TOOL_ERROR_CORRECTIVE_ROUNDS });
  });

  it("trims surrounding whitespace", () => {
    expect(parseToolErrorCorrectiveRounds("  3  ")).toEqual({ ok: true, rounds: 3 });
  });

  it("rejects non-numeric input", () => {
    expect(parseToolErrorCorrectiveRounds("abc").ok).toBe(false);
    expect(parseToolErrorCorrectiveRounds("").ok).toBe(false);
    expect(parseToolErrorCorrectiveRounds("1.5").ok).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(parseToolErrorCorrectiveRounds("-1").ok).toBe(false);
    expect(parseToolErrorCorrectiveRounds(String(MAX_TOOL_ERROR_CORRECTIVE_ROUNDS + 1)).ok).toBe(false);
  });
});
