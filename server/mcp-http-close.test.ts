import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RemoteMcpClient } from "./mcp-http.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function heldOperation(mode: "headers" | "json" | "sse", notification = false) {
  const received = gate(), headersReceived = gate(), disconnected = gate();
  let deletes = 0;
  const server = createServer((req, res) => {
    if (req.method === "DELETE") { deletes++; res.writeHead(204).end(); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const frame = JSON.parse(body) as { id?: number; method: string };
      if (frame.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18" } }));
      } else if (frame.method === "notifications/initialized" || frame.method === "notifications/cancelled") {
        res.writeHead(202).end();
      } else {
        res.once("close", () => disconnected.resolve());
        if (mode === "json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write(`{"jsonrpc":"2.0","id":${frame.id},"result":`);
        } else if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: message\ndata: ");
        }
        received.resolve();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const client = new RemoteMcpClient({ type: "http", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: {} }, {
    fetch: async (url, init) => {
      const tracked = init?.method === "POST" && JSON.parse(String(init.body)).method === "fixture/held";
      if (tracked) requestSignal = init?.signal;
      const response = await fetch(url, init);
      if (tracked) headersReceived.resolve();
      return response;
    },
  });
  cleanup.push(async () => { caller.abort(); await client.close(); });
  await client.initialize("fixture", AbortSignal.timeout(5_000));
  const pending = notification ? client.notify("fixture/held", {}, caller.signal) : client.request("fixture/held", {}, caller.signal);
  const outcome = pending.then(() => "fulfilled", () => "rejected");
  await received.promise;
  if (mode !== "headers") await headersReceived.promise;
  return { client, caller, outcome, disconnected: disconnected.promise, signal: () => requestSignal, deletes: () => deletes };
}

describe("closing a remote MCP client", () => {
  it.each(["headers", "json", "sse"] as const)("aborts an HTTP call waiting for %s without aborting its caller", async (mode) => {
    const held = await heldOperation(mode);
    expect(held.signal()?.aborted).toBe(false);
    await held.client.close();
    expect(held.signal()?.aborted).toBe(true);
    expect(held.caller.signal.aborted).toBe(false);
    expect(await held.outcome).toBe("rejected");
    await held.disconnected;
    expect(held.deletes()).toBe(1);
    await held.client.close();
    expect(held.deletes()).toBe(1);
  });

  it("aborts an HTTP notification awaiting response headers", async () => {
    const held = await heldOperation("headers", true);
    await held.client.close();
    expect(held.signal()?.aborted).toBe(true);
    expect(await held.outcome).toBe("rejected");
    await held.disconnected;
    expect(held.deletes()).toBe(1);
  });

  it("preserves caller cancellation before close", async () => {
    const held = await heldOperation("json");
    held.caller.abort();
    expect(await held.outcome).toBe("rejected");
    expect(held.signal()?.aborted).toBe(true);
    await held.disconnected;
    expect(held.deletes()).toBe(0);
    await held.client.close();
    expect(held.deletes()).toBe(1);
  });
});
