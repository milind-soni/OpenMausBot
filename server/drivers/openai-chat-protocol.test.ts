import { describe, expect, it } from "vitest";

import { ChatReasoningDetails, ChatToolCalls, MAX_REASONING_DETAIL_CHARS } from "./openai-chat-protocol.ts";

const completeCall = {
  id: "call_echo",
  type: "function",
  function: { name: "echo", arguments: "{}" },
};

describe("streamed chat tool calls", () => {
  it("treats explicit null continuation fields as absent", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall, function: { ...completeCall.function, arguments: "" } }], true);
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);
    calls.add([{ index: 0, id: null, function: { name: null, arguments: "{}" } }], true);

    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("treats an empty-string id or type on a continuation chunk as absent (DashScope/Qwen)", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall, function: { ...completeCall.function, arguments: "" } }], true);
    calls.add([{ index: 0, id: "", type: "function", function: { arguments: "{" } }], true);
    calls.add([{ index: 0, id: "", type: "", function: { name: "", arguments: "}" } }], true);

    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("still rejects a streamed call that never gets an id, and an id that changes", () => {
    const noId = new ChatToolCalls();
    noId.add([{ index: 0, id: "", type: "function", function: { name: "echo", arguments: "{}" } }], true);
    expect(() => noId.finish("tool_calls", false)).toThrow(/incomplete or duplicate/);

    const changed = new ChatToolCalls();
    changed.add([{ index: 0, ...completeCall }], true);
    expect(() => changed.add([{ index: 0, id: "call_other" }], true)).toThrow(/changed or omitted/);
  });

  it("still rejects an empty id in a whole, non-streamed reply", () => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([{ ...completeCall, id: "" }], false)).toThrow(/changed or omitted/);
  });

  it("still rejects incomplete calls after null-only deltas", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);

    expect(() => calls.finish("tool_calls", false)).toThrow(/incomplete or duplicate/);
  });

  it.each([
    { index: 0, type: "computer" },
    { index: 0, function: null },
    { index: 0, function: [] },
    { index: 0, function: { name: 1 } },
    { index: 0, function: { arguments: 1 } },
  ])("rejects unsupported or malformed continuation fields", (delta) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([delta], true)).toThrow();
  });

  it.each([
    { id: "call_large_name", name: "n".repeat(65), arguments: "{}" },
    { id: "call_large_args", name: "echo", arguments: "x".repeat(256_001) },
  ])("preserves tool-call size limits", ({ id, name, arguments: args }) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([{ index: 0, id, function: { name, arguments: args } }], true)).toThrow(/size limit/);
  });
});

describe("tool calls per reply", () => {
  it("accepts 32 calls in one reply and refuses a 33rd", () => {
    const calls = new ChatToolCalls();
    calls.add(Array.from({ length: 32 }, (_, index) => ({ index, ...completeCall, id: `call_${index}` })), true);
    expect(calls.finish("tool_calls", false)).toHaveLength(32);
    expect(() => new ChatToolCalls().add([{ index: 32, ...completeCall }], true)).toThrow(/invalid tool-call index/);
  });
});

describe("complete chat tool calls", () => {
  it.each([
    { ...completeCall, id: null },
    { ...completeCall, type: null },
    { ...completeCall, function: null },
    { ...completeCall, function: { ...completeCall.function, name: null } },
    { ...completeCall, function: { ...completeCall.function, arguments: null } },
  ])("rejects null required fields in non-streaming responses", (call) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([call], false)).toThrow();
  });
});

describe("streamed tool calls without an index (Gemini's OpenAI-compatible endpoint)", () => {
  it("keeps each call's thought signature", () => {
    const calls = new ChatToolCalls();
    const extra_content = { google: { thought_signature: "c2ln" } };
    calls.add([{ ...completeCall, extra_content }, { ...completeCall, id: "call_two" }], true);
    expect(calls.finish("stop", false)).toEqual([{ ...completeCall, extra_content }, { ...completeCall, id: "call_two" }]);
  });

  it("ignores extra content that is not an object", () => {
    const calls = new ChatToolCalls();
    calls.add([{ ...completeCall, extra_content: "sig" }], true);
    expect(calls.finish("stop", false)).toEqual([completeCall]);
  });

  it("counts a signature repeated on every chunk once toward the size limit", () => {
    const calls = new ChatToolCalls();
    const extra_content = { google: { thought_signature: "s".repeat(100_000) } };
    calls.add([{ index: 0, ...completeCall, extra_content }], true);
    calls.add([{ index: 0, extra_content }], true);
    calls.add([{ index: 0, extra_content }], true);
    expect(calls.finish("stop", false)).toEqual([{ ...completeCall, extra_content }]);
  });

  const whole = (id: string, name: string, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

  it("keeps two whole calls sent in one chunk", () => {
    const calls = new ChatToolCalls();
    calls.add([whole("function-call-1", "open_url", '{"url":"https://example.com"}'), whole("function-call-2", "open_url", '{"url":"https://example.org"}')], true);
    expect(calls.finish("tool_calls", false).map((call) => [call.id, call.function.arguments]))
      .toEqual([["function-call-1", '{"url":"https://example.com"}'], ["function-call-2", '{"url":"https://example.org"}']]);
  });

  it("keeps whole calls sent in separate chunks in order, and joins a later part with the same id", () => {
    const calls = new ChatToolCalls();
    calls.add([whole("a", "first", '{"x"')], true);
    calls.add([whole("b", "second")], true);
    calls.add([{ id: "a", function: { arguments: ":1}" } }], true);
    expect(calls.finish("stop", false).map((call) => [call.function.name, call.function.arguments])).toEqual([["first", '{"x":1}'], ["second", "{}"]]);
  });

  it("never puts an id-keyed call into a slot an indexed call holds", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...whole("x", "zero") }, { index: 2, ...whole("y", "two") }], true);
    calls.add([whole("z", "next")], true);
    expect(calls.finish("tool_calls", false).map((call) => call.id)).toEqual(["x", "y", "z"]);
  });

  it("still rejects a part with neither an index nor an id, and more calls than one reply may carry", () => {
    expect(() => new ChatToolCalls().add([{ function: { name: "f", arguments: "{}" } }], true)).toThrow(/invalid tool-call index/);
    const calls = new ChatToolCalls();
    calls.add(Array.from({ length: 32 }, (_, n) => whole(`call_${n}`, "f")), true);
    expect(() => calls.add([whole("call_32", "f")], true)).toThrow(/invalid tool-call index/);
  });
});

describe("legacy function_call from OpenAI-compatible relays", () => {
  it("turns a streamed legacy call into one structured call", () => {
    const calls = new ChatToolCalls();
    calls.addLegacy({ name: "echo", arguments: "" });
    calls.addLegacy({ arguments: "{\"a\":" });
    calls.addLegacy({ name: null, arguments: "1}" });
    const [call, ...rest] = calls.finish("function_call", false);
    expect(rest).toEqual([]);
    expect(call).toMatchObject({ type: "function", function: { name: "echo", arguments: "{\"a\":1}" } });
    expect(call?.id).toMatch(/^call_[0-9a-f]{32}$/);
  });

  it("takes a whole legacy call from a non-streamed message", () => {
    const calls = new ChatToolCalls();
    calls.addLegacy({ name: "echo", arguments: "{}" });
    expect(calls.finish("stop", false)).toMatchObject([{ function: { name: "echo", arguments: "{}" } }]);
  });

  it("ignores an empty placeholder so a plain reply still finishes", () => {
    const calls = new ChatToolCalls();
    calls.addLegacy({});
    calls.addLegacy({ name: "", arguments: "" });
    expect(calls.finish("stop", false)).toEqual([]);
  });

  it("keeps the structured calls when a relay mirrors one into function_call", () => {
    const calls = new ChatToolCalls();
    calls.add([completeCall], false);
    calls.addLegacy({ name: "echo", arguments: "{}" });
    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it.each(["function_call", "stop"])("rejects a nameless legacy call with arguments (finish %s)", (reason) => {
    const calls = new ChatToolCalls();
    calls.addLegacy({ arguments: "{}" });
    expect(() => calls.finish(reason, false)).toThrow(/without a complete call/);
  });

  it.each(["call", [], { name: 1 }, { arguments: {} }])("rejects a malformed legacy call %j", (value) => {
    const calls = new ChatToolCalls();
    calls.addLegacy(value);
    expect(() => calls.finish("function_call", false)).toThrow(/invalid function_call/);
  });

  it.each(["call", { name: 1 }, { name: "n".repeat(65) }])("ignores a malformed mirror %j next to structured calls", (value) => {
    const calls = new ChatToolCalls();
    calls.add([completeCall], false);
    calls.addLegacy(value);
    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("applies the name rules and size limits to legacy calls", () => {
    const named = new ChatToolCalls();
    named.addLegacy({ name: "bad name", arguments: "{}" });
    expect(() => named.finish("function_call", false)).toThrow();
    const long = new ChatToolCalls();
    long.addLegacy({ name: "n".repeat(65) });
    expect(() => long.finish("function_call", false)).toThrow(/size limit/);
  });
});

describe("streamed reasoning details", () => {
  const delta = (text: string) => [{ type: "reasoning.text", text, format: "unknown", index: 0 }];

  it("keeps a long streamed reasoning trace whose per-delta blocks pass 256 KB of JSON", () => {
    const details = new ChatReasoningDetails();
    // ~40k characters of reasoning, streamed a few characters at a time as OpenRouter does.
    for (let i = 0; i < 8_000; i += 1) details.add(delta("think"));
    expect(details.blocks).toHaveLength(8_000);
    expect(JSON.stringify(details.blocks).length).toBeGreaterThan(256_000);
  });

  it("accepts reasoning details just under 4 MB of JSON", () => {
    const details = new ChatReasoningDetails();
    details.add(delta("x".repeat(3_900_000)));
    expect(details.blocks).toHaveLength(1);
  });

  it("still refuses reasoning details past the bound", () => {
    const details = new ChatReasoningDetails();
    expect(() => details.add(delta("x".repeat(MAX_REASONING_DETAIL_CHARS)))).toThrow(/exceeded the size limit/);
  });
});
