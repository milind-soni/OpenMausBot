import { describe, expect, it } from "vitest";
import { compactContext } from "./context-budget.ts";

describe("compactContext", () => {
  it("bounds ordinary history while retaining protected instructions/evidence", () => {
    const result = compactContext([
      { role: "system", text: "durable instruction", protected: true },
      { role: "user", text: "old ordinary" },
      { role: "assistant", text: "old answer" },
      { role: "system", text: "durable evidence", protected: true },
      { role: "user", text: "latest" },
    ], { maxChars: 48 });

    expect(result.filter((entry) => entry.protected).map((entry) => entry.text)).toEqual([
      "durable instruction",
      "[Earlier context omitted by bounded compaction]",
      "durable evidence",
    ]);
    expect(result.map((entry) => entry.text)).toContain("latest");
    expect(result.map((entry) => entry.text)).not.toContain("old ordinary");
  });

  it("returns the original entries when no compaction is needed", () => {
    const entries = [{ role: "user" as const, text: "hello" }];
    expect(compactContext(entries, { maxChars: 100 })).toEqual(entries);
  });

  it("waits for the pressure threshold, then compacts with hysteresis", () => {
    const entries = [
      { role: "user" as const, text: "a".repeat(40) },
      { role: "assistant" as const, text: "b".repeat(40) },
      { role: "user" as const, text: "latest" },
    ];
    expect(compactContext(entries, { maxChars: 100, targetChars: 60 })).toEqual(entries);
    const pressured = [...entries, { role: "assistant" as const, text: "c".repeat(30) }];
    const compacted = compactContext(pressured, { maxChars: 100, targetChars: 60, marker: "[older]" });
    expect(compacted.map((entry) => entry.text)).toEqual(["[older]", "latest", "c".repeat(30)]);
  });
});
