import { describe, expect, it, vi } from "vitest";
import { createWorkflowConnector } from "./connector.ts";

const signal = new AbortController().signal;
const response = (value: unknown, status = 200) => ({ status, bytes: new TextEncoder().encode(JSON.stringify(value)), transportSessionId: "test-session" });

describe("workflow connector", () => {
  it("checks authorization before using the relay and parses successful tool data", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const relay = vi.fn(async (payload: Record<string, unknown>) => {
      calls.push(payload);
      if (payload.method === "initialize") return response({ result: {} });
      if (payload.method === "notifications/initialized") return response({});
      return response({ jsonrpc: "2.0", id: "minimum-ai-call", result: { content: [{ type: "text", text: JSON.stringify({ data: { results: [{ tool_slug: "MAIL_LIST", response: { successful: true, data: { messages: [] } } }] } }) }] } });
    });
    const authorize = vi.fn(async () => true);
    const invoke = createWorkflowConnector({ authorize, relay });
    expect(await invoke("MAIL_LIST", { folder: "inbox" }, signal)).toEqual({ messages: [] });
    expect(authorize).toHaveBeenCalledWith("MAIL_LIST");
    expect(calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });
  it("never contacts the relay when permission is refused", async () => {
    const relay = vi.fn();
    const invoke = createWorkflowConnector({ authorize: async () => false, relay });
    await expect(invoke("MAIL_LIST", {}, signal)).rejects.toThrow(/permission/i);
    expect(relay).not.toHaveBeenCalled();
  });
  it("treats the tool's own error as a failure", async () => {
    const relay = vi.fn(async (payload: Record<string, unknown>) => payload.method === "tools/call" ? response({ jsonrpc: "2.0", id: "minimum-ai-call", result: { isError: true, content: [{ type: "text", text: "denied" }] } }) : response({ result: {} }));
    const invoke = createWorkflowConnector({ authorize: async () => true, relay });
    await expect(invoke("MAIL_LIST", {}, signal)).rejects.toThrow("denied");
  });
  it("does not report success when multi-execute omits the per-tool result", async () => {
    const relay = vi.fn(async (payload: Record<string, unknown>) => payload.method === "tools/call"
      ? response({ jsonrpc: "2.0", id: "minimum-ai-call", result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { message: "accepted" } }) }] } })
      : response({ result: {} }));
    const invoke = createWorkflowConnector({ authorize: async () => true, relay });
    await expect(invoke("MAIL_LIST", {}, signal)).rejects.toThrow(/no result list/);
  });
});
