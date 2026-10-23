import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import * as chatTools from "./chat-mcp-tools.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("invalidates complete history when original catalogs change behind identical visible schemas", async () => {
  let catalogFingerprint = "original-catalog-v1";
  const execute = vi.fn(async () => ({ text: "synthetic operation receipt", ok: true }));
  vi.spyOn(chatTools, "mountChatTools").mockImplementation(async () => ({
    definitions: [{ type: "function", function: { name: "fixture_proxy", description: "Stable directory proxy", parameters: { type: "object", properties: {} } } }],
    catalogFingerprint, skipped: [],
    validate: () => {}, view: (name, input) => ({ title: name, input, ask: false }),
    execute, close: async () => {},
  }));
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
    bodies.push(JSON.parse(String(init?.body)));
    const message = bodies.length === 1
      ? { content: null, reasoning_content: "Use the registered operation", tool_calls: [{ id: "first-call", type: "function", function: { name: "fixture_proxy", arguments: "{}" } }] }
      : { content: bodies.length === 2 ? "Finished" : "Follow-up" };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] }), { headers: { "content-type": "application/json" } });
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "catalog-history", displayName: "Catalog fixture", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }), environment: { K: "fixture-key" } });
  const completed: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { if (event.type === "turn.completed") completed.push(event); });
  const transcript: Array<{ id: string; role: "user" | "assistant"; text: string }> = [];
  const send = async (index: number) => {
    const text = `message ${index}`;
    await instance.adapter.sendTurn({ threadId: "t", text, approvalMode: "full", systemStable: "Standing rules", systemVolatile: "Current context",
      transcript: [...transcript], sourceMessage: { id: `u${index}`, role: "user", text } });
    await vi.waitFor(() => expect(completed).toHaveLength(index));
    expect(completed.at(-1)).toMatchObject({ ok: true });
    transcript.push({ id: `u${index}`, role: "user", text }, { id: `a${index}`, role: "assistant", text: index === 1 ? "Finished" : "Follow-up" });
  };
  try {
    await send(1);
    await send(2);
    expect(bodies[2].messages.slice(0, bodies[1].messages.length)).toEqual(bodies[1].messages);
    expect(bodies[2].messages.some((message: any) => message.role === "tool")).toBe(true);
    catalogFingerprint = "original-catalog-v2";
    await send(3);
    expect(bodies[3].tools).toEqual(bodies[2].tools);
    expect(bodies[3].messages.some((message: any) => message.role === "tool" || message.tool_calls || message.reasoning_content)).toBe(false);
    expect(bodies[3].messages[1]).toEqual({ role: "user", content: "message 1" });
    expect(bodies[3].messages.at(-1).content).toContain("Current context");
    expect(execute).toHaveBeenCalledTimes(1);
  } finally { await instance.dispose(); }
});

it("discards retained wire history when a corrective round fails after an earlier answer", async () => {
  vi.spyOn(chatTools, "mountChatTools").mockResolvedValue({
    definitions: [{ type: "function", function: { name: "fixture_tool", description: "Fixture", parameters: { type: "object" } } }],
    catalogFingerprint: "fixture", skipped: [], validate: () => {},
    view: (name, input) => ({ title: name, input, ask: false }),
    execute: async () => ({ text: "failed", ok: false }), close: async () => {},
  });
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response('{"data":[]}');
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 3) return new Response("synthetic failure", { status: 400 });
    const message = bodies.length === 1
      ? { content: null, tool_calls: [{ id: "failed-call", type: "function", function: { name: "fixture_tool", arguments: "{}" } }] }
      : { content: bodies.length === 2 ? "Earlier answer" : "Follow-up" };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] }), { headers: { "content-type": "application/json" } });
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "corrective-history", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }, environment: { K: "fixture" } });
  const finished: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { if (event.type === "turn.completed") finished.push(event); });
  try {
    await instance.adapter.sendTurn({ threadId: "t", text: "Try", sourceMessage: { id: "u1", role: "user", text: "Try" },
      systemStable: "Stable", approvalMode: "full", toolErrorCorrectiveRounds: 1 });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ ok: false });
    expect(bodies[2].messages.at(-2)).toMatchObject({ role: "assistant", content: "Earlier answer" });
    await instance.adapter.sendTurn({ threadId: "t", text: "Continue", sourceMessage: { id: "u2", role: "user", text: "Continue" },
      systemStable: "Stable", approvalMode: "full", transcript: [{ id: "u1", role: "user", text: "Try" }, { id: "a1", role: "assistant", text: "Earlier answer" }] });
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(bodies.at(-1).messages.some((row: any) => row.role === "tool" || row.tool_calls)).toBe(false);
    expect(bodies.at(-1).messages.some((row: any) => row.role === "user" && /Re-run the failed/.test(row.content))).toBe(false);
  } finally { await instance.dispose(); }
});


it.each(["http-error", "malformed", "no-progress", "nudge-limit"])("rebuilds durable history after tool progress, announcement and %s", async failure => {
  const execute = vi.fn(async () => ({ text: "private raw receipt", ok: true }));
  vi.spyOn(chatTools, "mountChatTools").mockResolvedValue({
    definitions: [{ type: "function", function: { name: "fixture_tool", description: "Fixture", parameters: { type: "object" } } }],
    catalogFingerprint: "fixture", skipped: [], validate: () => {}, view: (name, input) => ({ title: name, input, ask: false }),
    execute, close: async () => {},
  });
  const bodies: any[] = [];
  let followUp = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const round = bodies.length;
    if (!followUp && round === 3 && failure === "http-error") return new Response("synthetic provider failure", { status: 400 });
    if (!followUp && round === 3 && failure === "malformed") return new Response("{bad-json", { headers: { "content-type": "application/json" } });
    const tool = !followUp && (round === 1 || (failure === "nudge-limit" && round % 2 === 1));
    const message = followUp ? { content: "Finished follow-up" } : tool
      ? { content: null, tool_calls: [{ id: `call-${round}`, type: "function", function: { name: "fixture_tool", arguments: "{}" } }] }
      : { content: "I will read the selected file now." };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }] }), { headers: { "content-type": "application/json" } });
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "nudge-history", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }, environment: { K: "fixture" } });
  const finished: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { if (event.type === "turn.completed") finished.push(event); });
  try {
    await instance.adapter.sendTurn({ threadId: "t", text: "Read", sourceMessage: { id: "u1", role: "user", text: "Read" }, systemStable: "Stable", systemVolatile: "Context", approvalMode: "full" });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ ok: false });
    expect(execute).toHaveBeenCalledTimes(failure === "nudge-limit" ? 4 : 1);
    expect(bodies[2].messages.at(-2)).toMatchObject({ role: "assistant", content: "I will read the selected file now." });
    const syntheticNudge = bodies[2].messages.at(-1);
    followUp = true;
    await instance.adapter.sendTurn({ threadId: "t", text: "Continue", sourceMessage: { id: "u2", role: "user", text: "Continue" },
      systemStable: "Stable", systemVolatile: "Context", approvalMode: "full", transcript: [{ id: "u1", role: "user", text: "Read" }, { id: "a1", role: "assistant", text: "I will read the selected file now." }] });
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(finished[1]).toMatchObject({ ok: true });
    const messages = bodies.at(-1).messages;
    expect(messages.filter((m: any) => m.content === "I will read the selected file now.")).toHaveLength(1);
    expect(messages.some((m: any) => m.role === "tool" || m.tool_calls || m.content === "private raw receipt")).toBe(false);
    expect(messages).not.toContainEqual(syntheticNudge);
  } finally { await instance.dispose(); }
});
