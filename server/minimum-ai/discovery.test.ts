import { expect, it, vi } from "vitest";
import { discoverWorkflowTools, refreshWorkflowSchemas } from "./discovery.ts";

it("discovers only granted connected tools without executing them", async () => {
  const relay = vi.fn(async (frame: Record<string, unknown>) => {
    const name = (frame.params as { name?: string } | undefined)?.name;
    const tools = name === "COMPOSIO_SEARCH_TOOLS"
      ? [{ tool_slug: "MAIL_LIST", input_schema: { type: "object" } }, { tool_slug: "MAIL_DELETE", input_schema: { type: "object" } }]
      : [{ tool_slug: "MAIL_LIST", input_schema: { type: "object" }, output_schema: { type: "object", properties: { messages: { type: "array" } } } }];
    return { status: 200, transportSessionId: "fixture", bytes: new TextEncoder().encode(JSON.stringify(frame.method === "tools/call" ? { id: frame.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { tools } }) }] } } : { result: {} })) };
  });
  const catalog = await discoverWorkflowTools("Read mail", relay, (name) => name === "MAIL_LIST", new AbortController().signal);
  expect(catalog.map((tool) => tool.name)).toEqual(["MAIL_LIST"]);
  expect(catalog[0]?.outputSchema).toEqual({ type: "object", properties: { messages: { type: "array" } } });
  expect(relay.mock.calls[2]![0]).toMatchObject({ params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "Read mail" }] } } });
  expect(relay.mock.calls[3]![0]).toMatchObject({ params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: ["MAIL_LIST"], include: ["input_schema", "output_schema"] } } });
});

it("refreshes known schemas without model or tool search calls", async () => {
  const relay = vi.fn(async (frame: Record<string, unknown>) => {
    const data = { successful: true, data: { tools: [{ tool_slug: "MAIL_LIST", input_schema: { type: "object" } }] } };
    return { status: 200, transportSessionId: "fixture", bytes: new TextEncoder().encode(JSON.stringify(frame.method === "tools/call" ? { id: frame.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } } : { result: {} })) };
  });
  const result = await refreshWorkflowSchemas([{ name: "MAIL_LIST", inputSchema: { type: "object" } }], relay, new AbortController().signal);
  expect(result.map((tool) => tool.name)).toEqual(["MAIL_LIST"]);
  expect(relay.mock.calls[2]![0]).toMatchObject({ params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: ["MAIL_LIST"] } } });
});

it("fetches full schemas for referenced tools in the discovery session", async () => {
  const relay = vi.fn(async (frame: Record<string, unknown>) => {
    const params = frame.params as { name?: string } | undefined;
    const data = params?.name === "COMPOSIO_SEARCH_TOOLS"
      ? { successful: true, data: { session: { id: "search-session" }, tool_schemas: { mail: { tool_slug: "MAIL_LIST", hasFullSchema: false, schemaRef: {} } } } }
      : { successful: true, data: { tools: [{ tool_slug: "MAIL_LIST", input_schema: { type: "object" } }] } };
    return { status: 200, transportSessionId: "fixture", bytes: new TextEncoder().encode(JSON.stringify(frame.method === "tools/call" ? { id: frame.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } } : { result: {} })) };
  });
  const catalog = await discoverWorkflowTools("Read mail", relay, () => true, new AbortController().signal);
  expect(catalog.map((tool) => tool.name)).toEqual(["MAIL_LIST"]);
  expect(relay.mock.calls[3]![0]).toMatchObject({ params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { session_id: "search-session", tool_slugs: ["MAIL_LIST"] } } });
});
