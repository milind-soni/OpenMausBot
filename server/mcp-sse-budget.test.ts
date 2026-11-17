import { describe, expect, it } from "vitest";

import { RemoteMcpClient } from "./mcp-http.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const reply = (id: number) => event({ jsonrpc: "2.0", id, result: { tools: [] } });

function legacy(chunks: (id: number) => string[], maxBytes: number, onNotification?: () => void) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; stream.enqueue(encode("event: endpoint\ndata: /messages\n\n")); },
    cancel() { cancelled = true; },
  });
  const client = new RemoteMcpClient({ type: "sse", url: "https://fixture.example/sse", headers: {} }, {
    maxBytes, onNotification,
    fetch: async (_url, init) => {
      if (init?.method === "GET") return new Response(body, { headers: { "content-type": "text/event-stream" } });
      const frame = JSON.parse(String(init?.body)) as { id?: number };
      if (frame.id !== undefined) for (const chunk of chunks(frame.id)) stream.enqueue(encode(chunk));
      return new Response(null, { status: 202 });
    },
  });
  return { client, body, get cancelled() { return cancelled; } };
}

describe("a persistent MCP SSE connection's byte budget", () => {
  it.each(["\n", "\r\n", "\r"])("allows many small events in one chunk with %j line endings", async (newline) => {
    let notifications = 0;
    const batch = Array.from({ length: 20 }, (_, i) => event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: i } })).join("");
    const fixture = legacy((id) => [(batch + reply(id)).replaceAll("\n", newline)], 128, () => { notifications++; });
    try {
      await expect(fixture.client.request("tools/list", {}, AbortSignal.timeout(1_000))).resolves.toEqual({ tools: [] });
      expect(notifications).toBe(20);
    } finally { await fixture.client.close(); }
  });

  it.each([
    { name: "complete oversized event", chunks: () => [":".repeat(129) + "\n\n"] },
    { name: "split unterminated event", chunks: () => [":".repeat(70), ":".repeat(70)] },
    { name: "UTF-8 bytes exceeding the character count", chunks: (id: number) => [event({ jsonrpc: "2.0", id, result: "界".repeat(40) })] },
  ])("still rejects and releases a $name", async ({ chunks }) => {
    const fixture = legacy(chunks, 128);
    try {
      await expect(fixture.client.request("tools/list", {}, AbortSignal.timeout(1_000))).rejects.toThrow("event stream too large");
      expect(fixture.cancelled).toBe(true);
      expect(fixture.body.locked).toBe(false);
    } finally { await fixture.client.close(); }
  });

  it("accepts an event exactly at its byte limit and rejects one byte more", async () => {
    for (const extra of [0, 1]) {
      const fixture = legacy((id) => [reply(id)], encode(reply(1)).byteLength - extra);
      try {
        const pending = fixture.client.request("tools/list", {}, AbortSignal.timeout(1_000));
        if (extra) await expect(pending).rejects.toThrow("event stream too large");
        else await expect(pending).resolves.toEqual({ tools: [] });
      } finally { await fixture.client.close(); }
    }
  });

  it("keeps the aggregate byte limit for one streamable HTTP response", async () => {
    const notification = event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      maxBytes: 128,
      fetch: async () => new Response(notification.repeat(20) + reply(1), { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      await expect(client.request("tools/list", {}, AbortSignal.timeout(1_000))).rejects.toThrow("event stream too large");
    } finally { await client.close(); }
  });
});
