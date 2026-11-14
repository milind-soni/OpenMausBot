import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { RemoteMcpClient, plainHttpProxyFetch } from "./mcp-http.ts";
import { probeMcpServer } from "./mcp-probe.ts";

const TARGET = "http://mcp.example.test/mcp";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function proxy(answer: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer(answer);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return plainHttpProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, async () => {
    throw new Error("fixture must use the actual local HTTP proxy");
  })!;
}

function encode(text: string, coding: string) {
  let bytes: Buffer = Buffer.from(text);
  for (const name of coding.toLowerCase().split(",").map((value) => value.trim())) {
    if (name === "gzip") bytes = gzipSync(bytes);
    else if (name === "deflate") bytes = deflateSync(bytes);
    else if (name === "br") bytes = brotliCompressSync(bytes);
  }
  return bytes;
}

describe.each(["application/json", "text/event-stream"])("proxied MCP %s decoding", (type) => {
  it.each(["gzip", "deflate", "br", "gzip, br", "GZip", "identity"])("discovers tools through a %s encoded response", async (coding) => {
    const methods: string[] = [];
    const via = await proxy(async (req, res) => {
      expect(req.url).toBe(TARGET);
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const frame = JSON.parse(body) as { id?: number; method: string };
      methods.push(frame.method);
      if (frame.id === undefined) { res.writeHead(202).end(); return; }
      const result = frame.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [{ name: "read_notes", description: "读取笔记 🐭" }] };
      const reply = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result });
      res.writeHead(200, { "content-type": type, "content-encoding": coding });
      res.end(encode(type === "application/json" ? reply : `data: ${reply}\n\n`, coding));
    });
    await expect(probeMcpServer({ type: "http", url: TARGET, headers: { authorization: "Bearer synthetic-fixture" }, enabled: true }, 2_000, undefined, {
      via: { url: TARGET, fetch: via },
    })).resolves.toEqual({ ok: true, tools: [{ name: "read_notes", description: "读取笔记 🐭" }] });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("applies the MCP byte limit to decoded content", async () => {
    const via = await proxy((_req, res) => {
      const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(2_000) } });
      const bytes = encode(type === "application/json" ? reply : `data: ${reply}\n\n`, "gzip");
      expect(bytes.length).toBeLessThan(128);
      res.writeHead(200, { "content-type": type, "content-encoding": "gzip" }).end(bytes);
    });
    const client = new RemoteMcpClient({ type: "http", url: TARGET, headers: {} }, { fetch: via, maxBytes: 128 });
    cleanups.push(() => client.close());
    await expect(client.request("tools/list", {}, AbortSignal.timeout(2_000))).rejects.toThrow(
      type === "application/json" ? "response too large" : "event stream too large",
    );
  });
});

it("delivers a compressed SSE reply before EOF and releases the proxy connection", async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const via = await proxy((_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
    res.write(gzipSync('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'));
  });
  const client = new RemoteMcpClient({ type: "http", url: TARGET, headers: {} }, { fetch: via });
  cleanups.push(() => client.close());
  await expect(client.request("tools/list", {}, AbortSignal.timeout(2_000))).resolves.toEqual({ tools: [] });
  await disconnected;
});

it("surfaces corrupt compression as a response-body error", async () => {
  const via = await proxy((_req, res) => { res.writeHead(200, { "content-encoding": "gzip" }).end("not gzip"); });
  const response = await via(TARGET);
  await expect(response.text()).rejects.toBeInstanceOf(Error);
});

it("does not partially decode an unknown content-coding stack", async () => {
  const bytes = gzipSync("opaque bytes");
  const via = await proxy((_req, res) => { res.writeHead(200, { "content-encoding": "gzip, unknown" }).end(bytes); });
  expect(Buffer.from(await (await via(TARGET)).arrayBuffer())).toEqual(bytes);
});

it.each([204, 205, 304])("keeps an encoded %i response body null", async (status) => {
  const via = await proxy((_req, res) => { res.writeHead(status, { "content-encoding": "gzip" }).end(); });
  const response = await via(TARGET);
  expect(response.status).toBe(status);
  expect(response.body).toBeNull();
});

it("keeps HEAD responses empty even when a content encoding is advertised", async () => {
  const via = await proxy((_req, res) => { res.writeHead(200, { "content-encoding": "gzip" }).end(); });
  const response = await via(TARGET, { method: "HEAD" });
  expect(response.body).toBeNull();
});

it("aborts a partially decoded event stream and closes its proxy connection", async () => {
  let started!: () => void;
  let closed!: () => void;
  const received = new Promise<void>((resolve) => { started = resolve; });
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const via = await proxy((_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
    res.write(gzipSync("data: incomplete"));
    started();
  });
  const client = new RemoteMcpClient({ type: "http", url: TARGET, headers: {} }, { fetch: via });
  cleanups.push(() => client.close());
  const controller = new AbortController();
  const reply = client.request("tools/list", {}, controller.signal);
  const rejected = expect(reply).rejects.toBeInstanceOf(Error);
  await received;
  controller.abort();
  await rejected;
  await disconnected;
});
