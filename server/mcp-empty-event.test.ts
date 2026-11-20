import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeMcpServer } from "./mcp-probe.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function serverWithEvent(transport: "http" | "sse", fields: string, ignoredFields?: string) {
  let stream: ServerResponse | undefined;
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const frame = JSON.parse(body) as { id?: number; method: string };
    methods.push(frame.method);
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    const listed = frame.method === "tools/list";
    const result = listed
      ? { tools: [{ name: "read_notes", description: "Read saved notes" }] }
      : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    const reply = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result });
    if (transport === "http" && !listed) {
      res.writeHead(200, { "content-type": "application/json" }).end(reply);
      return;
    }
    const target = transport === "sse" ? stream! : res;
    if (transport === "sse") res.writeHead(202).end();
    else res.writeHead(200, { "content-type": "text/event-stream" });
    if (listed && ignoredFields !== undefined) {
      target.write(`${ignoredFields}data: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "wrong_event" }] } })}\n\n`);
    }
    const event = `${listed ? fields : "event: message\n"}data: ${reply}\n\n`;
    if (listed) target.end(event);
    else target.write(event);
  });
  cleanups.push(async () => {
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    spec: { type: transport, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { authorization: "Bearer synthetic-fixture" }, enabled: true },
    methods,
  };
}

describe.each(["http", "sse"] as const)("MCP default event type over %s", (transport) => {
  it.each([
    ["empty event", "event:\n"],
    ["empty event after its optional space", "event: \r\n"],
    ["colonless event field", "event\r"],
    ["empty last event field", "event: custom\nevent:\n"],
    ["explicit message control", "event: message\n"],
    ["omitted event control", ""],
  ])("connects and exposes the tool catalog with an %s", async (_name, fields) => {
    const fixture = await serverWithEvent(transport, fields);
    await expect(probeMcpServer(fixture.spec, 5_000)).resolves.toEqual({
      ok: true, tools: [{ name: "read_notes", description: "Read saved notes" }],
    });
    expect(fixture.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it.each([
    ["a nonempty custom event type", "event: custom\n"],
    ["one remaining literal space", "event:  \n"],
  ])("still ignores %s and reads the subsequent message", async (_name, fields) => {
    const fixture = await serverWithEvent(transport, "event: message\n", fields);
    await expect(probeMcpServer(fixture.spec, 5_000)).resolves.toEqual({
      ok: true, tools: [{ name: "read_notes", description: "Read saved notes" }],
    });
  });
});
