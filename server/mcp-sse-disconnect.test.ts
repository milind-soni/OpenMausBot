import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { McpHttpError, RemoteMcpClient } from "./mcp-http.ts";

describe("a disconnected legacy MCP event stream", () => {
  it.each([
    ["EOF", "request"], ["EOF", "notification"],
    ["reset", "request"], ["reset", "notification"],
  ] as const)("refuses a later %s %s without posting to the orphaned endpoint", async (end, operation) => {
    let stream: ServerResponse | undefined;
    const posted: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const frame = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
      posted.push(frame.method);
      res.writeHead(202).end();
      if (frame.method === "initialize") {
        stream!.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } })}\n\n`);
      } else if (frame.method === "tools/call") {
        if (end === "EOF") stream!.end();
        else stream!.destroy();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new RemoteMcpClient({ type: "sse", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`, headers: {} });
    try {
      await client.initialize("fixture", AbortSignal.timeout(5_000));
      const failure: unknown = await client.request("tools/call", { name: "first" }, AbortSignal.timeout(5_000)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpHttpError);
      expect(failure).toMatchObject({ kind: "network", message: end === "EOF" ? "event stream ended" : "event stream failed" });
      const before = [...posted];
      const signal = AbortSignal.timeout(1_000);
      const later = operation === "request"
        ? client.request("tools/call", { name: "later" }, signal)
        : client.notify("notifications/tools/list_changed", undefined, signal);
      await expect(later).rejects.toBe(failure);
      expect(posted).toEqual(before);
    } finally {
      await client.close();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });
});
