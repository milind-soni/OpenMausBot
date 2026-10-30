// The managed HTTPS origin gzips large JSON; the LAN listener, sharing the same handler, never does.
import { readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { gzipTunnelReplies } from "../src/tunnel-gzip.ts";

const TOKEN = "omb_test_token";
const BOTS = { bots: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}` })), resumeCursors: { agent: "secret" } };
const SCRUBBED = JSON.stringify({ bots: BOTS.bots });
/** Long enough that the sidecar's own endpoints reply passes 1 KB. */
const ENDPOINTS = Array.from({ length: 8 }, (_, i) => ({
  url: `https://c-${i}-${"x".repeat(50)}.${"y".repeat(50)}.example.com`, kind: "hosted" as const, priority: i,
}));

let harness: Server;
let origin: Server;
let lan: Server;
const ports = { origin: 0, lan: 0 };

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

beforeAll(async () => {
  harness = createServer((req, res) => {
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ bots: BOTS.bots })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(BOTS));
  });
  const proxy = createProxyHandler({
    harnessPort: await listen(harness),
    authenticate: (t) => (t === TOKEN ? { id: "phone-1", cloudDesktopAccess: true, browserControlAccess: false } : null),
    redeem: () => ({ error: "not used here" }),
    serverName: () => "Test computer",
    endpoints: () => ENDPOINTS,
  });
  origin = createServer(gzipTunnelReplies(proxy));
  lan = createServer(proxy);
  ports.origin = await listen(origin);
  ports.lan = await listen(lan);
});

afterAll(async () => {
  for (const server of [origin, lan, harness]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Raw bytes as the sidecar sent them; a stream resolves on its first whole event, still open. */
function phone(port: number, path: string): Promise<{ headers: IncomingHttpHeaders; raw: Buffer; open: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip, br" } }, (res) => {
      const chunks: Buffer[] = [];
      const done = (open: boolean) => resolve({ headers: res.headers, raw: Buffer.concat(chunks), open });
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (path === "/api/events" && Buffer.concat(chunks).toString("utf8").endsWith("\n\n")) {
          done(true);
          req.destroy();
        }
      });
      res.on("end", () => done(false));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("gzip on the managed HTTPS origin", () => {
  it("is the same file as the server's", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(read("../src/tunnel-gzip.ts")).toBe(read("../../server/harness/tunnel-gzip.ts"));
  });

  it("gzips the scrubbed JSON and keeps the private headers", async () => {
    const reply = await phone(ports.origin, "/api/bots");
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(reply.headers.vary).toBe("Authorization, Accept-Encoding");
    expect(reply.headers["cache-control"]).toBe("private, no-store");
    expect(gunzipSync(reply.raw).toString("utf8")).toBe(SCRUBBED);
  });

  it("gzips a large reply the sidecar answers itself", async () => {
    const reply = await phone(ports.origin, "/api/companion/endpoints");
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(reply.headers.vary).toBe("Authorization, Accept-Encoding");
    expect(JSON.parse(gunzipSync(reply.raw).toString("utf8")).endpoints).toHaveLength(8);
  });

  it("streams events unbuffered and unencoded", async () => {
    const reply = await phone(ports.origin, "/api/events");
    expect(reply.open).toBe(true);
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(`data: ${SCRUBBED}\n\n`);
  });

  it("never compresses on the LAN listener", async () => {
    const reply = await phone(ports.lan, "/api/bots");
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.headers.vary).toBe("Authorization");
    expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength(SCRUBBED)));
    expect(reply.raw.toString("utf8")).toBe(SCRUBBED);
    const endpoints = await phone(ports.lan, "/api/companion/endpoints");
    expect(endpoints.headers["content-encoding"]).toBeUndefined();
    expect(endpoints.headers["content-length"]).toBe(String(endpoints.raw.length));
    expect(endpoints.raw.length).toBeGreaterThan(1024);
  });
});
