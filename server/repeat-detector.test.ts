import { describe, expect, it } from "vitest";

import { RepeatDetector, callKey } from "./repeat-detector.ts";

describe("callKey", () => {
  it("keys on tool plus arguments, normalizing whitespace, and ignores a bare tool name", () => {
    expect(callKey("Bash", "git   status\n")).toBe("Bash:git status");
    expect(callKey("Bash", "  git status ")).toBe("Bash:git status");
    expect(callKey("Bash", undefined)).toBeNull();
    expect(callKey("Bash", "")).toBeNull();
    // ACP titles that are just the tool name again carry no arguments
    expect(callKey("Bash", "Bash")).toBeNull();
    expect(callKey("Read", "Read src/index.ts")).toBe("Read:Read src/index.ts");
  });
});

describe("RepeatDetector", () => {
  it("fires once at each threshold for the same call in one thread", () => {
    const d = new RepeatDetector({ thresholds: [5, 10, 20] });
    const hits: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = d.record("t1", "Bash:git status");
      if (r.threshold) hits.push(r.threshold);
    }
    expect(hits).toEqual([5, 10, 20]);
    expect(d.record("t1", "Bash:git status").count).toBe(26);
  });

  it("keeps threads and calls apart", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    for (let i = 0; i < 2; i++) d.record("t2", "Bash:a");
    expect(d.record("t1", "Bash:b").threshold).toBeUndefined();
    expect(d.record("t1", "Bash:a").threshold).toBe(3);
    expect(d.record("t2", "Bash:a").threshold).toBe(3);
  });

  it("forgets a thread on settle", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    d.settle("t1");
    expect(d.record("t1", "Bash:a").count).toBe(1);
  });

  it("bounds distinct calls per thread and evicts the least recently seen", () => {
    const d = new RepeatDetector({ thresholds: [2], maxKeysPerThread: 2 });
    d.record("t1", "Bash:a");
    d.record("t1", "Bash:b");
    // Refresh a, so b is the least-recently-seen entry.
    expect(d.record("t1", "Bash:a").threshold).toBe(2);
    d.record("t1", "Bash:c");
    expect(d.record("t1", "Bash:a").count).toBe(3);
    expect(d.record("t1", "Bash:b").count).toBe(1);
  });

  it("rejects an invalid memory bound", () => {
    expect(() => new RepeatDetector({ thresholds: [2], maxKeysPerThread: 0 })).toThrow(/positive integer/);
  });
});
