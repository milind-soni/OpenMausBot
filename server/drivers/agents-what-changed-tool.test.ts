import { describe, expect, it, vi } from "vitest";

import type { ToolCallContext } from "./agents-call.ts";
import { callWhatChangedTool, WHAT_CHANGED_INLINE_MAX, WHAT_CHANGED_INLINE_REFUSAL } from "./agents-what-changed-tool.ts";

function context() {
  const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "comparison" } }));
  return { apiResponse, context: { client: { apiResponse } } as unknown as ToolCallContext };
}

describe("what_changed inline request size", () => {
  it.each([["CJK", "界".repeat(400_000)], ["emoji", "🙂".repeat(300_000)]])("refuses oversized %s text before sending a request", async (_label, text) => {
    const args = { original_text: text, edited_text: "edited" };
    const body = JSON.stringify(args);
    expect(body.length).toBeLessThan(WHAT_CHANGED_INLINE_MAX);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1_000_000);
    const f = context();
    expect(await callWhatChangedTool(args, f.context)).toEqual({ text: WHAT_CHANGED_INLINE_REFUSAL, isError: true });
    expect(f.apiResponse).not.toHaveBeenCalled();
  });

  it.each(["a", "界", "🙂"])("accepts an exact byte-budget request containing %s", async (character) => {
    const overhead = Buffer.byteLength(JSON.stringify({ original_text: "", edited_text: "" }), "utf8");
    const available = WHAT_CHANGED_INLINE_MAX - overhead;
    const width = Buffer.byteLength(character, "utf8");
    const original_text = character.repeat(Math.floor(available / width)) + "x".repeat(available % width);
    const args = { original_text, edited_text: "" };
    const body = JSON.stringify(args);
    expect(Buffer.byteLength(body, "utf8")).toBe(WHAT_CHANGED_INLINE_MAX);
    const f = context();
    expect(await callWhatChangedTool(args, f.context)).toEqual({ text: "comparison" });
    expect(f.apiResponse).toHaveBeenCalledWith("/api/internal/what-changed", { method: "POST", body });
    f.apiResponse.mockClear();
    expect(await callWhatChangedTool({ ...args, edited_text: "x" }, f.context)).toEqual({ text: WHAT_CHANGED_INLINE_REFUSAL, isError: true });
    expect(f.apiResponse).not.toHaveBeenCalled();
  });

  it("counts JSON escaping and preserves the serialized request", async () => {
    const args = { original_text: '"\\\n界🙂', edited_text: "updated", start: 2 };
    const f = context();
    expect(await callWhatChangedTool(args, f.context)).toEqual({ text: "comparison" });
    expect(f.apiResponse).toHaveBeenCalledWith("/api/internal/what-changed", { method: "POST", body: JSON.stringify(args) });
  });
});
