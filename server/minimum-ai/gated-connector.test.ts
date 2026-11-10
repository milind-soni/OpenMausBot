import { expect, it, vi } from "vitest";
import { createGatedWorkflowConnector } from "./gated-connector.ts";

it("rejects non-loopback endpoints so a capability cannot be leaked", () => {
  expect(() => createGatedWorkflowConnector({ endpoint: "https://example.com/api/internal/connectors/mcp", bearer: "secret", authorize: async () => true })).toThrow();
  expect(() => createGatedWorkflowConnector({ endpoint: "http://127.0.0.1:1234/anything", bearer: "secret", authorize: async () => true })).toThrow();
});
it("sends each call through the internal gate and stops when it refuses", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "tools/call") return new Response(JSON.stringify({ id: "minimum-ai-call", result: { isError: true, content: [{ type: "text", text: "Access denied" }] } }), { status: 200 });
    return new Response(JSON.stringify({ id: body.id, result: {} }), { status: 200, headers: { "mcp-session-id": "fake-session" } });
  });
  const invoke = createGatedWorkflowConnector({ endpoint: "http://127.0.0.1:1234/api/internal/connectors/mcp", bearer: "secret", authorize: async () => true, fetcher });
  await expect(invoke("NOTION_DELETE_BLOCK", {}, new AbortController().signal)).rejects.toThrow("Access denied");
  expect(fetcher).toHaveBeenCalledTimes(3);
  const headers = fetcher.mock.calls[2]![1]?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer secret");
  expect(headers["mcp-session-id"]).toBe("fake-session");
});
