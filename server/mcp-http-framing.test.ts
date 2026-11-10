import { describe, expect, it } from "vitest";

import { RemoteMcpClient } from "./mcp-http.ts";

describe("MCP event stream framing", () => {
  it("cancels and unlocks an event stream rejected for exceeding the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(":".repeat(129))); },
      cancel() { cancelled = true; },
    });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      maxBytes: 128,
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      await expect(client.request("tools/list", {}, new AbortController().signal)).rejects.toThrow("event stream too large");
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally { await client.close(); }
  });

  it("closes an event stream when its notification handler throws", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n')); },
      cancel() { cancelled = true; },
    });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      onNotification: () => { throw new Error("notification failed"); },
    });
    try {
      await expect(client.request("tools/list", {}, new AbortController().signal)).rejects.toThrow("notification failed");
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally { await client.close(); }
  });

  it("releases a completed JSON response's reader", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'));
      controller.close();
    } });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    try {
      await expect(client.request("tools/list", {}, new AbortController().signal)).resolves.toEqual({ tools: [] });
      expect(body.locked).toBe(false);
    } finally { await client.close(); }
  });

  it.each([
    ["CRLF split across chunks", "\r\n", true],
    ["CRLF in one chunk", "\r\n", false],
    ["LF split across chunks", "\n", true],
    ["CR split across chunks", "\r", true],
  ] as const)("reads multiline data with %s", async (_label, newline, split) => {
    const text = [
      "event: message",
      'data: {"jsonrpc":"2.0",',
      'data: "id":1,"result":{"text":"日本語"}}',
      "",
      "",
    ].join(newline);
    const bytes = new TextEncoder().encode(text);
    const chunks = split ? Array.from(bytes, (byte) => Uint8Array.of(byte)) : [bytes];
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    });

    try {
      await expect(client.request("tools/call", { name: "read" }, new AbortController().signal))
        .resolves.toEqual({ text: "日本語" });
    } finally {
      await client.close();
    }
  });
});
