import { describe, expect, it } from "vitest";
import { InkboxMcpRelay, inkboxToolNeedsApproval, type InkboxToolConnection } from "./inkbox-mcp.ts";

const key = "private-identity-scoped-key-never-for-the-bot";
const tools = [
  { name: "inkbox_identity_get", description: "Identity", inputSchema: { type: "object" } },
  { name: "inkbox_email_send", description: "Send email", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "inkbox_slack_send", inputSchema: { type: "object" } },
  { name: "inkbox_call_create", inputSchema: { type: "object" } },
  { name: "inkbox_a2a_task_send", inputSchema: { type: "object" } },
  { name: "inkbox_future_get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];
function fixture() {
  let connection: InkboxToolConnection | null = { apiKey: key, identityId: "identity-one", binding: "binding-one" };
  let active = true;
  let allowed = true;
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, any> }> = [];
  const approvals: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  let respond = (body: Record<string, any>): Response => Response.json({ jsonrpc: "2.0", id: body.id,
    result: body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "inkbox", version: "1" } }
      : body.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "provider-result" }] } },
    { headers: { "mcp-session-id": "provider-session" } });
  const relay = new InkboxMcpRelay({ connection: bot => bot === "bot-one" ? connection : null,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), init: init!, body });
      return body.method === "notifications/initialized" ? new Response(null, { status: 202 }) : respond(body);
    } });
  const context = { botId: "bot-one", binding: "binding-one", assertActive: () => { if (!active) throw new Error("revoked"); },
    approve: async (input: { tool: string; arguments: Record<string, unknown> }) => { approvals.push(input); return allowed; } };
  return { relay, calls, approvals, context, connection: (value: InkboxToolConnection | null) => { connection = value; },
    active: (value: boolean) => { active = value; }, allowed: (value: boolean) => { allowed = value; },
    respond: (value: typeof respond) => { respond = value; } };
}
const call = (name: string, args: Record<string, unknown> = {}) => ({ method: "tools/call", params: { name, arguments: args } });

describe("Inkbox host-owned MCP relay", () => {
  it("discovers dynamic tools through a fixed authenticated endpoint and exposes no key or upstream session", async () => {
    const f = fixture();
    const result = await f.relay.request({ method: "tools/list" }, f.context) as any;
    expect(result.tools.map((tool: any) => tool.name)).toContain("inkbox_call_create");
    expect(result.tools.map((tool: any) => tool.name)).toContain("inkbox_slack_send");
    expect(result.tools.map((tool: any) => tool.name)).toContain("inkbox_a2a_task_send");
    expect(result.tools.find((tool: any) => tool.name === "inkbox_email_send").annotations.readOnlyHint).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("provider-session");
    expect(f.calls.map(row => row.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    for (const row of f.calls) {
      expect(row.url).toBe("https://inkbox.ai/mcp");
      expect(row.init.redirect).toBe("error");
      expect(new Headers(row.init.headers).get("X-API-Key")).toBe(key);
    }
  });
  it("allows documented read names, but never trusts name suffixes or upstream readOnly hints", async () => {
    expect(inkboxToolNeedsApproval("inkbox_identity_get")).toBe(false);
    expect(inkboxToolNeedsApproval("inkbox_slack_message_get")).toBe(false);
    expect(inkboxToolNeedsApproval("inkbox_future_get")).toBe(true);
    const f = fixture();
    await f.relay.request(call("inkbox_identity_get"), f.context);
    expect(f.approvals).toHaveLength(0);
    await f.relay.request(call("inkbox_future_get"), f.context);
    expect(f.approvals).toEqual([{ tool: "inkbox_future_get", arguments: {} }]);
  });
  it("holds mutation arguments for one explicit decision and denial emits no provider call", async () => {
    const f = fixture(); f.allowed(false);
    const result = await f.relay.request(call("inkbox_email_send", { to: "recipient@example.test", body: "hello" }), f.context) as any;
    expect(result.isError).toBe(true);
    expect(f.approvals).toEqual([{ tool: "inkbox_email_send", arguments: { to: "recipient@example.test", body: "hello" } }]);
    expect(f.calls.filter(row => row.body.method === "tools/call")).toHaveLength(0);
    f.allowed(true);
    await f.relay.request(call("inkbox_email_send", { to: "recipient@example.test", body: "hello" }), f.context);
    expect(f.calls.filter(row => row.body.method === "tools/call")).toHaveLength(1);
    expect(f.approvals).toHaveLength(2);
  });
  it("rechecks turn authority and connection after a held approval before any write", async () => {
    const f = fixture();
    await expect(f.relay.request(call("inkbox_email_send"), { ...f.context, approve: async () => { f.active(false); return true; } })).rejects.toThrow("revoked");
    expect(f.calls.filter(row => row.body.method === "tools/call")).toHaveLength(0);
    const g = fixture();
    await expect(g.relay.request(call("inkbox_email_send"), { ...g.context, approve: async () => { g.connection(null); return true; } })).rejects.toThrow(/connection/i);
    expect(g.calls.filter(row => row.body.method === "tools/call")).toHaveLength(0);
  });
  it("refuses different bots, stale connections, unknown tools and foreign acting identities", async () => {
    const f = fixture();
    for (const context of [{ ...f.context, botId: "other" }, { ...f.context, binding: "old" }]) {
      await expect(f.relay.request(call("inkbox_identity_get"), context)).rejects.toThrow(/connection/i);
    }
    expect(f.calls).toHaveLength(0);
    await expect(f.relay.request(call("inkbox_missing_tool"), f.context)).rejects.toThrow(/available/i);
    await expect(f.relay.request(call("inkbox_email_send", { acting_identity_id: "other" }), f.context)).rejects.toThrow(/identity/i);
    expect(f.calls.filter(row => row.body.method === "tools/call")).toHaveLength(0);
  });
  it("bounds responses and refuses malformed JSON, foreign RPC ids, server requests, redirects and provider error leakage", async () => {
    for (const response of [
      () => new Response("not json", { headers: { "content-type": "application/json" } }),
      () => Response.json({ jsonrpc: "2.0", id: "foreign", result: {} }),
      () => Response.json({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} }),
      () => new Response("", { status: 302, headers: { location: "https://evil.example" } }),
      () => new Response(key, { status: 403 }),
      () => Response.json({ jsonrpc: "2.0", id: 1, result: "x".repeat(4_194_305) }),
    ]) {
      const f = fixture(); f.respond(response);
      await expect(f.relay.request({ method: "tools/list" }, f.context)).rejects.not.toThrow(key);
      expect(f.calls).toHaveLength(1);
    }
  });
  it("parses bounded SSE results and redacts any reflected credential", async () => {
    const f = fixture();
    await f.relay.request({ method: "tools/list" }, f.context);
    f.respond(body => new Response(`: keepalive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `result ${key}` }] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }));
    const result = await f.relay.request(call("inkbox_identity_get"), f.context);
    expect(JSON.stringify(result)).toContain("result");
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("never retries an uncertain mutation or reinitializes it automatically", async () => {
    const f = fixture(); await f.relay.request({ method: "tools/list" }, f.context);
    const before = f.calls.length;
    f.respond(() => { throw new Error(`network failed ${key}`); });
    await expect(f.relay.request(call("inkbox_email_send"), f.context)).rejects.toThrow(/uncertain/i);
    expect(f.calls.length - before).toBe(1);
  });
  it("retrieves issued protected file links through native and tool-only interfaces", async () => {
    const f = fixture(); await f.relay.request({ method: "tools/list" }, f.context);
    const uri = "inkbox://slack/files/document";
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/call"
      ? { content: [{ type: "resource_link", uri, name: "document.pdf" }] }
      : { contents: [{ uri, mimeType: "application/pdf", blob: "cGRm", text: key }] } }));
    const linked = await f.relay.request(call("inkbox_identity_get"), f.context) as any;
    expect(linked.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(uri) });
    const native = await f.relay.request({ method: "resources/read", params: { uri } }, f.context);
    expect(native).toMatchObject({ contents: [{ uri, blob: "cGRm", text: "[REDACTED]" }] });
    const tool = await f.relay.request(call("inkbox_resource_read", { uri }), f.context) as any;
    expect(tool.content[0].text).toBe("[REDACTED]");
    expect(f.calls.slice(-2).map(row => row.body.method)).toEqual(["resources/read", "resources/read"]);
    expect(f.approvals).toHaveLength(0);
  });
  it("grants only typed issued Inkbox URIs and rejects direct message-body JSON", async () => {
    const f = fixture(); await f.relay.request({ method: "tools/list" }, f.context);
    const uris = ["inkbox://files/embedded", "inkbox://files/typed?acting_identity_id=identity-one"];
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [
      { type: "resource", resource: { uri: uris[0], text: "preview" } },
      { type: "resource_link", uri: uris[1] },
      { type: "text", text: JSON.stringify({ resource_uri: "inkbox://files/direct-body" }) },
      { type: "text", text: "inkbox://files/plain" },
      { type: "text", text: JSON.stringify({ body: { resource_uri: "inkbox://files/body" }, messages: [{ type: "text", text: JSON.stringify({ resource_uri: "inkbox://files/injected" }) }] }) },
      { type: "resource_link", uri: "inkbox://files/foreign?acting_identity_id=other" },
      { type: "resource_link", uri: "https://evil.example/file" },
    ], structuredContent: { resource_uri: "inkbox://files/structured" } } }));
    await f.relay.request(call("inkbox_identity_get"), f.context);
    const beforeRefusals = f.calls.length;
    for (const uri of ["inkbox://files/direct-body", "inkbox://files/structured", "inkbox://files/unissued", "inkbox://files/plain", "inkbox://files/body", "inkbox://files/injected", "inkbox://files/foreign?acting_identity_id=other", "https://evil.example/file"]) {
      await expect(f.relay.request({ method: "resources/read", params: { uri } }, f.context)).rejects.toThrow(/resource/i);
    }
    expect(f.calls).toHaveLength(beforeRefusals);
    const beforeList = f.calls.length;
    await expect(f.relay.request({ method: "resources/list" }, f.context)).resolves.toEqual({ resources: uris.map(uri => ({ uri, name: uri })) });
    expect(f.calls).toHaveLength(beforeList);
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri: body.params.uri, text: "file" }] } }));
    for (const uri of uris) await expect(f.relay.request({ method: "resources/read", params: { uri } }, f.context)).resolves.toMatchObject({ contents: [{ text: "file" }] });
    await expect(f.relay.request({ method: "resources/read", params: { uri: uris[0] } }, { ...f.context, binding: "wrong" })).rejects.toThrow(/connection/i);
    f.active(false);
    await expect(f.relay.request(call("inkbox_resource_read", { uri: uris[0] }), f.context)).rejects.toThrow(/revoked/i);
  });
  it("bounds grants and renders text, image, and unparsed binary resources without pretending to parse documents", async () => {
    const f = fixture(); await f.relay.request({ method: "tools/list" }, f.context);
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: Array.from({ length: 257 }, (_, index) => ({ type: "resource_link", uri: `inkbox://files/${index}` })) } }));
    await f.relay.request(call("inkbox_identity_get"), f.context);
    await expect(f.relay.request(call("inkbox_resource_read", { uri: "inkbox://files/0" }), f.context)).rejects.toThrow(/resource/i);
    const uri = "inkbox://files/256";
    for (const [contents, expected] of [
      [{ uri, text: "full file text" }, { type: "text", text: "full file text" }],
      [{ uri, mimeType: "image/png", blob: "aW1hZ2U=" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      [{ uri, mimeType: "application/pdf", blob: "cGRm" }, { type: "text", text: expect.stringContaining("Unparsed binary file") }],
    ]) {
      f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [contents] } }));
      await expect(f.relay.request(call("inkbox_resource_read", { uri }), f.context)).resolves.toMatchObject({ content: [expected] });
    }
    f.respond(body => { f.active(false); return Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri, text: "must not escape" }] } }); });
    await expect(f.relay.request({ method: "resources/read", params: { uri } }, f.context)).rejects.toThrow(/revoked/i);
  });
  it("never grants failed result links and rejects upstream synthetic tool collisions", async () => {
    const f = fixture(); await f.relay.request({ method: "tools/list" }, f.context);
    const uri = "inkbox://files/failed";
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "resource_link", uri }] } }));
    await f.relay.request(call("inkbox_identity_get"), f.context);
    await expect(f.relay.request({ method: "resources/read", params: { uri } }, f.context)).rejects.toThrow(/resource/i);
    f.respond(body => Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [...tools, { name: "inkbox_resource_read", inputSchema: { type: "object" } }] } }));
    await expect(f.relay.request({ method: "tools/list" }, f.context)).rejects.toThrow(/catalog/i);
  });
  it("rejects oversized arguments and unsupported RPC methods before contacting the provider", async () => {
    const f = fixture();
    await expect(f.relay.request({ method: "resources/read", params: { uri: "https://evil.example" } }, f.context)).rejects.toThrow();
    await expect(f.relay.request(call("inkbox_email_send", { text: "x".repeat(1_048_577) }), f.context)).rejects.toThrow(/size/i);
    expect(f.calls).toHaveLength(0);
  });
});
