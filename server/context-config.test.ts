// Phase 1 part 1: the compaction budget knobs in config.json.
import { describe, expect, it } from "vitest";

import { contextAutoCompact, contextCompactAt, type AppConfig } from "./config.ts";

describe("context compaction config", () => {
  it("defaults to auto compaction with no explicit threshold", () => {
    const cfg = {} as AppConfig;
    expect(contextAutoCompact(cfg)).toBe(true);
    expect(contextCompactAt(cfg)).toBeUndefined();
  });

  it("reads a share or an absolute threshold, and the off switch", () => {
    expect(contextCompactAt({ context: { compactAt: 0.5 } } as AppConfig)).toBe(0.5);
    expect(contextCompactAt({ context: { compactAt: 50_000 } } as AppConfig)).toBe(50_000);
    expect(contextAutoCompact({ context: { autoCompact: false } } as AppConfig)).toBe(false);
  });
});
