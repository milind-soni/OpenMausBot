import { describe, expect, it } from "vitest";
import { contextReplayBudget } from "./context-rebuild.ts";

describe("contextReplayBudget", () => {
  it("uses a late conservative fallback instead of trimming normal chats early", () => {
    const result = contextReplayBudget("cursor-grok-4.6-high", {
      default: "cursor-grok-4.6-high",
      options: [{ id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6" }],
    });
    expect(result).toEqual({
      contextWindowTokens: 200_000,
      triggerChars: 640_000,
      targetChars: 520_000,
      source: "fallback",
    });
  });

  it("prefers catalog metadata and recognizes explicit window labels", () => {
    expect(contextReplayBudget("known", {
      default: "known",
      options: [{ id: "known", label: "Known", contextWindow: 1_000_000 }],
    }).source).toBe("catalog");
    expect(contextReplayBudget("labelled", {
      default: "labelled",
      options: [{ id: "labelled", label: "Labelled (128k)" }],
    })).toMatchObject({ contextWindowTokens: 128_000, source: "label" });
  });
});
