import { describe, expect, it } from "vitest";

import { EngineProgress, statusReadMs } from "./live-start.ts";

describe("the status read's limit", () => {
  it("is 10 s on a machine with processors to spare, and grows with load up to three times that", () => {
    expect(statusReadMs(0.5, 4)).toBe(10_000);
    expect(statusReadMs(8, 4)).toBe(20_000);
    expect(statusReadMs(40, 4)).toBe(30_000);
  });
});

describe("an engine that left a status read unanswered", () => {
  it("is slow, not hung, while it starts or answered lately, for three minutes of unanswered reads", () => {
    let now = 0;
    const progress = new EngineProgress(() => now);
    expect(progress.verdict("s", { alive: true, held: false })).toBe("slow");
    now = 170_000;
    expect(progress.verdict("s", { alive: true, held: false })).toBe("slow");
    now = 181_000;
    expect(progress.verdict("s", { alive: true, held: false })).toBe("hung");
    progress.answered("s");
    now += 10_000;
    expect(progress.verdict("s", { alive: true, held: false })).toBe("slow");
  });
  it("is hung within 30 s of reads when it had been silent for a minute before", () => {
    let now = 0;
    const progress = new EngineProgress(() => now);
    progress.answered("s");
    now = 120_000;
    expect(progress.verdict("s", { alive: true, held: false })).toBe("slow");
    now = 151_000;
    expect(progress.verdict("s", { alive: true, held: false })).toBe("hung");
  });
  it("is hung at once when its process is gone, and never while a person holds the browser", () => {
    let now = 0;
    const progress = new EngineProgress(() => now);
    expect(progress.verdict("s", { alive: false, held: true })).toBe("hung");
    now = 3_600_000;
    expect(progress.verdict("t", { alive: true, held: true })).toBe("slow");
  });
});
