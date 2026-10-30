import { describe, expect, it } from "vitest";

import { captureRecentLog } from "./recent-log.ts";

describe("the server's recent warnings and errors", () => {
  it("keeps the latest 200 warn and error lines, redacted and cut, and still prints every line", () => {
    const printed: string[] = [];
    const target = { warn: (...args: unknown[]) => printed.push(`W ${args.join(" ")}`), error: (...args: unknown[]) => printed.push(`E ${args.join(" ")}`) };
    const recent = captureRecentLog(target, () => Date.UTC(2026, 9, 27, 9, 0));
    target.warn("engine probe slow:", 1200, "ms");
    target.error(new Error("upstream said Bearer abcdefghijklmnopqrstuvwxyz"));
    target.warn("x".repeat(5_000));
    for (let i = 0; i < 300; i++) target.error(`line ${i}`);
    const kept = recent();
    expect(printed).toHaveLength(303);
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)).toBe("2026-10-27T09:00:00.000Z error line 299");
    expect(kept[0]).toBe("2026-10-27T09:00:00.000Z error line 100");

    const fresh = { warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} };
    const early = captureRecentLog(fresh, () => 0);
    fresh.warn("engine probe slow:", 1200, "ms");
    fresh.error(new Error("upstream said Bearer abcdefghijklmnopqrstuvwxyz"));
    fresh.warn("y".repeat(5_000));
    const lines = early();
    expect(lines[0]).toBe("1970-01-01T00:00:00.000Z warn engine probe slow: 1200 ms");
    expect(lines[1]).toContain("upstream said Bearer «redacted 26 chars»");
    expect(lines[1]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(lines[2]!.length).toBeLessThan(700);
  });
});
