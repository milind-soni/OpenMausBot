import { describe, expect, it } from "vitest";

import { ChatToolCalls } from "./openai-chat-protocol.ts";

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
