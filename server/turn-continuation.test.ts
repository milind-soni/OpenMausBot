import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyContinuable, writeTurnHandoff } from "./turn-continuation.ts";

let temp: string | undefined;
afterEach(() => {
  if (temp) { rmSync(temp, { recursive: true, force: true }); temp = undefined; }
  delete process.env.OMB_DATA_DIR;
  vi.restoreAllMocks();
});

function withTempDataDir(): string {
  temp = mkdtempSync(join(tmpdir(), "omb-handoff-"));
  process.env.OMB_DATA_DIR = temp;
  return temp;
}

describe("writeTurnHandoff", () => {
  it("uses the active task instead of an older request or a later image message", () => {
    withTempDataDir();
    const path = writeTurnHandoff({
      threadId: "current", turnId: "turn", toolCalls: 0,
      task: "Repair the parser test",
      messages: [
        { role: "user", content: "List repository files" },
        { role: "assistant", content: "Listed the files" },
        { role: "user", content: [{ type: "text", text: "Repair the parser test" }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] },
        { role: "user", content: [{ type: "text", text: "Screenshot result from tool call read" }] },
      ],
    });
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("Repair the parser test");
    expect(text).not.toContain("List repository files");
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("Screenshot result");
  });

  it("retains delivered updates in order without treating internal user messages as instructions", () => {
    withTempDataDir();
    const path = writeTurnHandoff({
      threadId: "updated", turnId: "turn", toolCalls: 0, task: "Prepare a release",
      updates: ["Draft only; do not publish", "Use version 2"],
      messages: [
        { role: "user", content: "Prepare a release" },
        { role: "user", content: "Draft only; do not publish" },
        { role: "user", content: "Use version 2" },
        { role: "user", content: "Synthetic internal corrective prompt" },
      ],
    });
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("Draft only; do not publish");
    expect(text).toContain("Use version 2");
    expect(text.indexOf("Draft only")).toBeLessThan(text.indexOf("Use version 2"));
    expect(text).not.toContain("Synthetic internal corrective prompt");
  });

  it("writes a structured handoff with the original task, ordered tool calls, and last text", () => {
    const dir = withTempDataDir();
    const path = writeTurnHandoff({
      threadId: "thread-abc", turnId: "turn-xyz", model: "test-model",
      hasUsage: true, usage: { input: 10, output: 20 },
      failure: "Stopped after 64 steps without a final answer",
      toolCalls: 3,
      task: "Build the thing",
      messages: [
        { role: "user", content: "Build the thing" },
        { role: "assistant", content: null, tool_calls: [{ function: { name: "host_shell_exec", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", content: JSON.stringify({ ok: true, result: "files" }) },
        { role: "tool", content: JSON.stringify({ ok: false, result: "boom" }) },
        { role: "assistant", content: "Almost done" },
      ],
    });
    expect(path).not.toBeNull();
    expect(path).toContain(join(dir, "handoffs", "cap-"));
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("# Handoff - turn ended without a final answer");
    expect(text).toContain("Build the thing");
    expect(text).toContain("1. host_shell_exec - {\"command\":\"ls\"}");
    expect(text).toContain("result ok: {\"ok\":true,\"result\":\"files\"}");
    expect(text).toContain("result FAILED: {\"ok\":false,\"result\":\"boom\"}");
    expect(text).toContain("Almost done");
    expect(text).toContain("Stop reason: Stopped after 64 steps");
    expect(text).toContain("Tokens this turn: 10 in / 20 out");
  });

  it("returns an absolute handoff when OMB_DATA_DIR is relative", () => {
    const dir = withTempDataDir();
    process.env.OMB_DATA_DIR = relative(process.cwd(), dir);
    const path = writeTurnHandoff({ threadId: "relative", turnId: "turn", toolCalls: 0, task: "Continue", messages: [] });
    expect(path).not.toBeNull();
    expect(isAbsolute(path!)).toBe(true);
    expect(dirname(path!)).toBe(join(dir, "handoffs"));
    expect(readFileSync(path!, "utf8")).toContain("# Handoff");
  });

  it("returns null when the handoff cannot be written", () => {
    process.env.OMB_DATA_DIR = join(tmpdir(), "omb-handoff-", "does-not-exist", "nested");
    expect(writeTurnHandoff({ threadId: "t", turnId: "u", toolCalls: 0, task: "Continue", messages: [] })).not.toBeNull();
    rmSync(join(tmpdir(), "omb-handoff-"), { recursive: true, force: true });
  });
});

describe("classifyContinuable", () => {
  it.each([
    ["budget cap message", "error", "Stopped after 64 steps without a final answer. The steps so far already ran, so ask only for what's left.", "cap"],
    ["legacy limit message", "error", "model-call limit reached before a final response", "cap"],
    ["tool-call cap message", "error", "Stopped after 200 tool calls without a final answer. The steps so far already ran, so ask only for what's left.", "cap"],
    ["provider rate limit (429)", "error", "upstream HTTP 429: {\"error\":{\"message\":\"Rate limit reached\"}}", null],
    ["provider quota", "error", "upstream HTTP 429: {\"error\":{\"message\":\"Monthly usage limit reached\"}}", null],
    ["provider body quoting the cap", "error", "upstream HTTP 500: Stopped after 3 steps without a final answer", null],
    ["provider usage limit", "error", "You have reached your usage limit reached for today", null],
    ["tool_error terminal", "tool_error", "One or more tool operations failed or were denied. See the tool results; the final response is not an execution receipt.", null],
    ["provider config 400 (non-multimodal)", "error", "upstream HTTP 400: {\"error\":{\"message\":\"deepseek-ai/DeepSeek-V4-Flash-0731 is not a multimodal model\"}}", null],
    ["unknown model", "error", "Model \"nope\" does not exist", null],
    ["no failure text", "error", undefined, null],
    ["successful turn", null, "done", null],
  ] as const)("%s → %s", (_name, stopReason, failure, expected) => {
    expect(classifyContinuable(stopReason, failure)).toBe(expected);
  });
});
