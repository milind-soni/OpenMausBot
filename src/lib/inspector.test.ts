import { describe, expect, it } from "vitest";

import { summarizeNative, summarizeRuntime, toRows, type InspectorEntry } from "./inspector";

const base = { eventId: "e", provider: "claudeAgent" as const, threadId: "t", createdAt: "2026-08-17T10:00:00.000Z" };

describe("summarizeRuntime", () => {
  it("labels turn boundaries and failures by tone", () => {
    expect(summarizeRuntime({ ...base, type: "turn.started", turnId: "abcdef12-rest" })).toEqual({
      summary: "turn started · abcdef12",
      tone: "boundary",
    });
    expect(summarizeRuntime({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn", cost: 0.01234 })).toEqual({
      summary: "turn ok · end_turn · $0.0123",
      tone: "boundary",
    });
    expect(summarizeRuntime({ ...base, type: "turn.completed", ok: false }).tone).toBe("error");
    expect(summarizeRuntime({ ...base, type: "runtime.error", message: "boom", setup: true }).summary).toBe("setup: boom");
  });

  it("clips long assistant text to one line", () => {
    const text = "line one\nline two ".repeat(30);
    const { summary } = summarizeRuntime({ ...base, type: "item.completed", itemType: "assistant_text", text });
    expect(summary.startsWith("assistant: line one line two")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual("assistant: ".length + 120);
    expect(summary).not.toContain("\n");
  });
});

describe("summarizeNative", () => {
  it("names JSON-RPC methods and claude stream-json messages", () => {
    expect(summarizeNative({ at: "", dir: "out", source: "acp", msg: { jsonrpc: "2.0", id: 3, method: "session/prompt" } })).toBe(
      "session/prompt #3",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "claude", msg: { type: "assistant", message: { role: "assistant" } } })).toBe(
      "assistant · assistant",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "acp", msg: { jsonrpc: "2.0", id: 3, result: {} } })).toBe("result #3");
    expect(summarizeNative({ at: "", dir: "in", source: "agy.stream", msg: { event: "result", result: { status: "SUCCESS" } } })).toBe(
      "result · SUCCESS",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "agy.stream", msg: { event: "step_update", step: {} } })).toBe("step_update");
  });
});

describe("toRows", () => {
  it("folds a run of content.delta on one stream into one row", () => {
    const entries: InspectorEntry[] = [
      { kind: "runtime", at: "1", data: { ...base, eventId: "a", type: "turn.started" } },
      { kind: "runtime", at: "2", data: { ...base, eventId: "b", type: "content.delta", streamKind: "assistant_text", delta: "Hel" } },
      { kind: "runtime", at: "3", data: { ...base, eventId: "c", type: "content.delta", streamKind: "assistant_text", delta: "lo" } },
      { kind: "runtime", at: "4", data: { ...base, eventId: "d", type: "content.delta", streamKind: "reasoning_text", delta: "hmm" } },
      { kind: "native", at: "5", data: { at: "5", dir: "in", source: "claude", msg: { type: "result" } } },
    ];
    const rows = toRows(entries);
    expect(rows.map((r) => [r.tag, r.count, r.summary])).toEqual([
      ["turn.started", 1, "turn started"],
      ["content.delta", 2, "assistant_text: Hello"],
      ["content.delta", 1, "reasoning_text: hmm"],
      ["← in", 1, "claude · result"],
    ]);
  });

  it("builds a bounded folded preview without rejoining the full delta history", () => {
    const entries: InspectorEntry[] = Array.from({ length: 500 }, (_, i) => ({
      kind: "runtime" as const,
      at: String(i),
      data: { ...base, eventId: `d${i}`, type: "content.delta" as const, streamKind: "assistant_text" as const, delta: `word${i} ` },
    }));
    const [row] = toRows(entries);
    expect(row.count).toBe(500);
    expect(row.summary).toMatch(/^assistant_text: word0 word1/);
    expect(row.summary.endsWith("…")).toBe(true);
    expect(row.summary.length).toBeLessThanOrEqual("assistant_text: ".length + 120);
    expect((row.data as unknown[])).toHaveLength(500);
  });
});
