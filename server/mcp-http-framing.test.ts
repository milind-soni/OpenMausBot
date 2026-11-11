import { describe, expect, it, vi } from "vitest";

import { RemoteMcpClient } from "./mcp-http.ts";

describe("MCP event stream framing", () => {
  it.each([
    { name: "SSE byte limit", type: "text/event-stream", text: ":".repeat(129), error: "event stream too large" },
    { name: "notification failure", type: "text/event-stream", text: 'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n', error: "notification failed" },
    { name: "JSON byte limit", type: "application/json", text: " ".repeat(129), error: "response too large" },
    { name: "matched SSE response", type: "text/event-stream", text: 'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', error: undefined },
  ])("settles a cloned response after $name while its sibling remains open", async ({ type, text, error }) => {
    let sourceCancelled = false;
    const original = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
      cancel() { sourceCancelled = true; },
    }), { headers: { "content-type": type } });
    const response = original.clone();
    const body = response.body!;
    const getReader = body.getReader.bind(body);
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { markCancellationStarted = resolve; });
    const readerSpy = vi.spyOn(body, "getReader").mockImplementation(() => {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      reader.cancel = (reason?: unknown) => {
        const pending = cancel(reason);
        markCancellationStarted();
        return pending;
      };
      return reader;
    });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      maxBytes: 128,
      fetch: async () => response,
      onNotification: () => { throw new Error("notification failed"); },
    });
    const result = client.request("tools/list", {}, new AbortController().signal).then(
      (value) => ({ value, error: undefined }),
      (failure: unknown) => ({ value: undefined, error: failure }),
    );
    try {
      await cancellationStarted;
      expect(body.locked).toBe(false);
      const settled = await result;
      if (error) expect(settled.error).toEqual(expect.objectContaining({ message: error }));
      else expect(settled).toEqual({ value: { tools: [] }, error: undefined });
      expect(sourceCancelled).toBe(false);
    } finally {
      await original.body!.cancel();
      await result;
      readerSpy.mockRestore();
      await client.close();
    }
  });

  it.each(["text/event-stream", "application/json"])("keeps the %s size error when cancellation rejects", async (type) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(129))); },
      cancel() { return Promise.reject(new Error("cancellation failed")); },
    });
    const client = new RemoteMcpClient({ type: "http", url: "https://fixture.example/mcp", headers: {} }, {
      maxBytes: 128,
      fetch: async () => new Response(body, { headers: { "content-type": type } }),
    });
    try {
      await expect(client.request("tools/list", {}, new AbortController().signal)).rejects.toThrow(
        type === "text/event-stream" ? "event stream too large" : "response too large",
      );
      expect(body.locked).toBe(false);
    } finally { await client.close(); }
  });

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
