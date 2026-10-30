import { describe, expect, it } from "vitest";

import { omittedFromErrorNote, textOnlyErrorResult, textOnlyErrorResultLine } from "./mcp-error-result.ts";

const PNG = "iVBORw0KGgo=";
// The shape cua-driver 0.37.0 answers a refused pixel click with: text, a screenshot, and structured content.
const refusedClick = {
  content: [
    { type: "text", text: "Pixel click refused: read the window with get_window_state first." },
    { type: "image", data: PNG, mimeType: "image/png" },
  ],
  structuredContent: { code: "window_state_required" },
  isError: true,
};

describe("textOnlyErrorResult", () => {
  it("keeps an error's text and structured content, drops its image, and says so", () => {
    expect(textOnlyErrorResult(refusedClick)).toEqual({
      content: [
        { type: "text", text: "Pixel click refused: read the window with get_window_state first." },
        { type: "text", text: omittedFromErrorNote(1) },
      ],
      structuredContent: { code: "window_state_required" },
      isError: true,
    });
  });

  it("counts every non-text item, including audio and resources", () => {
    const result = textOnlyErrorResult({
      isError: true,
      content: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///tmp/x", text: "x" } },
      ],
    });
    expect(result.content).toEqual([{ type: "text", text: omittedFromErrorNote(3) }]);
    expect(omittedFromErrorNote(3)).toMatch(/^\[The 3 screenshots or other attachments this error mentions were removed: /);
  });

  it("tells the model plainly that the screenshot is gone and what to do before any pixel action", () => {
    expect(omittedFromErrorNote(1)).toBe("[The screenshot this error mentions was removed: an error result can carry only text. " +
      "Call get_window_state for that window and take x,y from its new screenshot before any pixel action.]");
  });

  it("rewrites run_steps' promise of a screenshot it no longer carries, and only when one was removed", () => {
    // Verbatim shape of cua-driver 0.37.0's run_steps recovery read (batch_tools.rs Recovery::after).
    const promise = "run_steps: step 1 of 1 failed; 0 step(s) ran before it, 0 not run\n1. click ERROR (action): No screenshot of window 29360131 " +
      "in this session: it has not been read yet.\nrecovery read: window 29360131 had no screenshot; one follows, take x,y from it";
    const stripped = textOnlyErrorResult({ isError: true, content: [{ type: "text", text: promise }, { type: "image", data: PNG, mimeType: "image/png" }] });
    const texts = stripped.content.map((item: { text?: string }) => item.text ?? "");
    expect(texts.join("\n")).not.toContain("one follows, take x,y from it");
    expect(texts[0]).toContain("recovery read: window 29360131 had no screenshot; that screenshot was removed from this error");
    expect(texts.at(-1)).toBe(omittedFromErrorNote(1));
    const textOnly = { isError: true, content: [{ type: "text", text: promise }] };
    expect(textOnlyErrorResult(textOnly)).toBe(textOnly);
  });

  it("returns successes, text-only errors and malformed values as the same object", () => {
    const shot = { content: [{ type: "image", data: PNG, mimeType: "image/png" }] };
    const textError = { content: [{ type: "text", text: "no such window" }], isError: true };
    const truthyNotTrue = { content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: "true" };
    for (const value of [shot, textError, truthyNotTrue, null, "text", { isError: true }]) {
      expect(textOnlyErrorResult(value)).toBe(value);
    }
  });
});

describe("textOnlyErrorResultLine", () => {
  it("rewrites a tools/call error frame and keeps its id", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: "call-7", result: refusedClick });
    const frame = JSON.parse(textOnlyErrorResultLine(line));
    expect(frame.id).toBe("call-7");
    expect(frame.result.isError).toBe(true);
    expect(frame.result.content.map((item: { type: string }) => item.type)).toEqual(["text", "text"]);
    expect(JSON.stringify(frame)).not.toContain(PNG);
  });

  it("passes every other line through byte for byte", () => {
    const success = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: PNG, mimeType: "image/png" }] } });
    const textError = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "bad" }], isError: true } });
    const request = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { isError: true, content: [{ type: "image" }] } });
    const notJson = '{"isError": true, not json';
    for (const line of [success, textError, request, notJson, ""]) expect(textOnlyErrorResultLine(line)).toBe(line);
  });

  it("recognises the flag with whitespace a server may print", () => {
    const line = `{"jsonrpc": "2.0", "id": 4, "result": {"isError" : true, "content": [{"type": "image", "data": "${PNG}", "mimeType": "image/png"}]}}`;
    expect(JSON.parse(textOnlyErrorResultLine(line)).result.content).toEqual([{ type: "text", text: omittedFromErrorNote(1) }]);
  });
});
