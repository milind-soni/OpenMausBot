import { describe, expect, it } from "vitest";

import { RemoteMcpClient } from "./mcp-http.ts";

describe("MCP event stream framing", () => {
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
