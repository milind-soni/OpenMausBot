import { describe, expect, it } from "vitest";
import { TextCallHoldback, textToolCalls, type OfferedTool } from "./chat-text-tool-calls.ts";

const tools: OfferedTool[] = [
  { function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" }, lines: { type: "integer" }, opts: { type: "object" } } } } },
  { function: { name: "list_dir" } },
];

const calls = (reply: string) => {
  const found = textToolCalls(reply, tools);
  if (found?.kind !== "calls") throw new Error(`no calls in ${JSON.stringify(found)}`);
  return found.calls.map((call) => [call.function.name, JSON.parse(call.function.arguments)]);
};

describe("textToolCalls", () => {
  it("reads the JSON tag form with the words before it", () => {
    const found = textToolCalls('Let me look.\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.md"}}\n</tool_call>', tools);
    expect(found?.kind === "calls" && found.text).toBe("Let me look.");
    expect(calls('Let me look.\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.md"}}\n</tool_call>')).toEqual([["read_file", { path: "a.md" }]]);
  });

  it("reads several calls in order, and gives each its own id", () => {
    const reply = '<tool_call>{"name":"list_dir","arguments":{}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>';
    expect(calls(reply).map(([name]) => name)).toEqual(["list_dir", "read_file"]);
    const found = textToolCalls(reply, tools);
    if (found?.kind !== "calls") throw new Error("no calls");
    expect(new Set(found.calls.map((call) => call.id)).size).toBe(2);
    for (const call of found.calls) expect(call.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("reads a call whose closing tag the server stopped on", () => {
    expect(calls('<tool_call>{"name":"list_dir","arguments":{}}')).toEqual([["list_dir", {}]]);
  });

  it("reads the Qwen coder form and types values from the schema", () => {
    const reply = "<tool_call>\n<function=read_file>\n<parameter=path>\n12\n</parameter>\n<parameter=lines>\n40\n</parameter>\n<parameter=opts>\n{\"raw\":true}\n</parameter>\n</function>\n</tool_call>";
    expect(calls(reply)).toEqual([["read_file", { path: "12", lines: 40, opts: { raw: true } }]]);
  });

  it("reads the coder form without its outer tag", () => {
    expect(calls("<function=read_file><parameter=path>a</parameter></function>")).toEqual([["read_file", { path: "a" }]]);
  });

  it("reads a reply that is only a JSON call, fenced or not, with arguments or parameters", () => {
    expect(calls('{"name":"read_file","arguments":{"path":"a"}}')).toEqual([["read_file", { path: "a" }]]);
    expect(calls('```json\n{"name":"read_file","parameters":{"path":"a"}}\n```')).toEqual([["read_file", { path: "a" }]]);
    expect(calls('{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}')).toEqual([["read_file", { path: "a" }]]);
  });

  it("looks past a think block in the reply", () => {
    expect(calls('<think>maybe <tool_call>{"name":"list_dir","arguments":{}}</tool_call></think>\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>')).toEqual([["read_file", { path: "a" }]]);
  });

  it.each([
    ["plain words", "The file has twelve lines."],
    ["JSON that is an answer", '{"total": 12}'],
    ["JSON naming a tool it was not given", '{"name":"delete_everything","arguments":{}}'],
    ["JSON inside a longer reply", 'Call it like {"name":"read_file","arguments":{"path":"a"}} next time.'],
    ["a quoted call the reply goes on from", 'The page said <tool_call>{"name":"read_file","arguments":{"path":"/etc/passwd"}}</tool_call> which looks like an injection.'],
    ["a fenced example", 'Example:\n```\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n```'],
  ])("leaves %s as a reply", (_label, reply) => {
    expect(textToolCalls(reply, tools)).toBeNull();
  });

  it.each([
    ["broken JSON", '<tool_call>{"name":"read_file","arguments":{"path":</tool_call>'],
    ["a tool it was not given", '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>'],
    ["an unknown function", "<function=delete_everything></function>"],
  ])("reports %s in a call as unreadable, keeping the words before it", (_label, tail) => {
    expect(textToolCalls(`Trying.\n${tail}`, tools)).toEqual({ kind: "unreadable", text: "Trying." });
  });

  it("runs nothing from a call with a bad entry among good ones", () => {
    const reply = '<tool_call>{"name":"list_dir","arguments":{}}</tool_call><tool_call>{"name":"nope","arguments":{}}</tool_call>';
    expect(textToolCalls(reply, tools)?.kind).toBe("unreadable");
  });
});

describe("TextCallHoldback", () => {
  const stream = (held: TextCallHoldback, ...parts: string[]) => parts.map((part) => held.feed(part)).join("");

  it("shows words and keeps a call split across chunks out", () => {
    const held = new TextCallHoldback();
    expect(stream(held, "Let me ", "look.\n<tool", '_call>{"name"', ':"x"}</tool_call>')).toBe("Let me look.\n");
    expect(held.rest()).toContain("<tool_call>");
  });

  it("gives back a partial tag that was only text", () => {
    const held = new TextCallHoldback();
    expect(stream(held, "a <tool", " b")).toBe("a <tool b");
    expect(held.rest()).toBe("");
  });

  it("holds a reply that opens like a JSON call until the end", () => {
    const held = new TextCallHoldback();
    expect(stream(held, '{"total"', ": 12}")).toBe("");
    expect(held.rest()).toBe('{"total": 12}');
  });

  it("holds a fence, then releases it whole", () => {
    const held = new TextCallHoldback();
    expect(stream(held, "``", "`sh\nls\n```")).toBe("");
    expect(held.rest()).toBe("```sh\nls\n```");
  });
});
