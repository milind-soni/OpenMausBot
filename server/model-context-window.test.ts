import { describe, expect, it } from "vitest";
import { modelContextWindow } from "./model-context-window.ts";

describe("model context window fallback", () => {
  it("knows the common families and stays silent otherwise", () => {
    expect(modelContextWindow("claude-sonnet-5")).toBe(200_000);
    expect(modelContextWindow("claude-opus-5[1m]")).toBe(1_000_000);
    expect(modelContextWindow("gpt-5.6-sol")).toBe(272_000);
    expect(modelContextWindow("gpt-4.1-mini")).toBe(1_000_000);
    expect(modelContextWindow("gemini-2.5-pro")).toBe(1_000_000);
    expect(modelContextWindow("grok-4.7")).toBe(500_000);
    expect(modelContextWindow("grok-4")).toBe(256_000);
    expect(modelContextWindow("MiniMax-M3")).toBeUndefined();
    expect(modelContextWindow(undefined)).toBeUndefined();
  });
});
