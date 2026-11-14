import { mkdtempSync, rmSync } from "node:fs";
import { createServer, IncomingMessage, request, ServerResponse, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { json } from "./http.ts";
import { acceptsGzip, GZIP_MIN_BYTES, gzipCandidate, gzipTunnelReplies, varyOnEncoding } from "./tunnel-gzip.ts";

const LARGE = { messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, text: `message ${i} — ünïcode 😀` })) };
const SMALL = { ok: true };

describe("acceptsGzip", () => {
  it.each([
    ["gzip", true], ["gzip, deflate, br", true], ["br;q=1.0, GZIP;q=0.5", true], ["x-gzip", true], ["*", true],
    ["*;q=0, gzip", true], [["br", "gzip"], true],
    ["gzip;q=0", false], ["gzip; q=0.0", false], ["gzip;q=0, *", false], ["*;q=0", false], ["br, deflate", false],
    ["identity", false], ["", false], [undefined, false],
  ] as const)("%j → %s", (header, expected) => {
    expect(acceptsGzip(header as string | string[] | undefined)).toBe(expected);
  });
});

describe("varyOnEncoding", () => {
  it.each([
    [undefined, "Accept-Encoding"], ["Authorization", "Authorization, Accept-Encoding"],
    [["Origin", "Cookie"], "Origin, Cookie, Accept-Encoding"], ["accept-encoding", "accept-encoding"], ["*", "*"],
  ] as const)("%j → %s", (vary, expected) => {
    expect(varyOnEncoding(vary as string | string[] | undefined)).toBe(expected);
  });
});

describe("gzipCandidate", () => {
  const reply = (method = "GET", onTunnel = true) => {
    const req = Object.assign(new IncomingMessage(new Socket()), { method });
    const res = new ServerResponse(req);
    if (onTunnel) gzipTunnelReplies(() => undefined)(req, res);
    return res;
  };
  const JSON_HEADERS = { "content-type": "application/json" };
  const BIG = "x".repeat(50_000);

  it("takes a large JSON reply on the tunnel, any charset, measured in bytes", () => {
    expect(gzipCandidate(reply(), 200, JSON_HEADERS, BIG)).toBe(true);
    expect(gzipCandidate(reply(), 404, { "content-type": "application/json; charset=utf-8" }, BIG)).toBe(true);
    expect(gzipCandidate(reply(), 200, JSON_HEADERS, "é".repeat(GZIP_MIN_BYTES / 2)), "512 characters, 1 KB").toBe(true);
  });

  it("leaves every other reply alone", () => {
    expect(gzipCandidate(reply("GET", false), 200, JSON_HEADERS, BIG), "local listener").toBe(false);
    expect(gzipCandidate(reply(), 200, JSON_HEADERS, "x".repeat(GZIP_MIN_BYTES - 1)), "under the threshold").toBe(false);
    expect(gzipCandidate(reply("HEAD"), 200, JSON_HEADERS, BIG), "HEAD").toBe(false);
    expect(gzipCandidate(reply(), 204, JSON_HEADERS, BIG), "204").toBe(false);
    expect(gzipCandidate(reply(), 304, JSON_HEADERS, BIG), "304").toBe(false);
    expect(gzipCandidate(reply(), 200, { "content-type": "text/event-stream" }, BIG), "SSE").toBe(false);
    expect(gzipCandidate(reply(), 200, { "content-type": "image/png" }, BIG), "image").toBe(false);
    expect(gzipCandidate(reply(), 200, { "content-type": "application/json-seq" }, BIG), "not JSON").toBe(false);
    expect(gzipCandidate(reply(), 200, { ...JSON_HEADERS, "content-encoding": "br" }, BIG), "encoded").toBe(false);
    const encoded = reply();
    encoded.setHeader("content-encoding", "identity");
    expect(gzipCandidate(encoded, 200, JSON_HEADERS, BIG), "encoded by setHeader").toBe(false);
  });
});

/** The tunnel listener's shape: a request handler, plus upgrades handed the same handler unwrapped. */
const handler: RequestListener = (req, res) => {
  switch (req.url) {
    case "/large": return json(res, 200, LARGE);
    case "/small": return json(res, 200, SMALL);
    case "/vary":
      res.setHeader("vary", "Origin");
      return json(res, 200, LARGE);
    case "/encoded":
      res.setHeader("content-encoding", "identity");
      return json(res, 200, LARGE);
    case "/text":
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(JSON.stringify(LARGE));
    case "/events":
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(LARGE)}\n\n`);
      return; // left open: the first event must arrive while the stream is still running
  }
};

function upgradeWith(server: Server): Server {
  server.on("upgrade", (req, socket) => {
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.once("finish", () => socket.end());
    handler(req, res);
  });
  return server;
}

type Reply = { status: number; headers: IncomingHttpHeaders; raw: Buffer; open: boolean };

let tunnel: Server;
let local: Server;
let tunnelPath = "";
let localPort = 0;
let socketDir = "";

beforeAll(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "omb-gzip-"));
  tunnelPath = process.platform === "win32" ? `\\\\.\\pipe\\omb-gzip-test-${process.pid}-${Date.now()}` : join(socketDir, "t.sock");
  tunnel = upgradeWith(createServer(gzipTunnelReplies(handler)));
  local = upgradeWith(createServer(handler));
  await new Promise<void>((resolve) => tunnel.listen(tunnelPath, resolve));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  localPort = (local.address() as { port: number }).port;
});

afterAll(async () => {
  tunnel.closeAllConnections();
  local.closeAllConnections();
  await new Promise((resolve) => tunnel.close(resolve));
  await new Promise((resolve) => local.close(resolve));
  rmSync(socketDir, { recursive: true, force: true });
});

/** Raw bytes as they left the server. A stream resolves once its first event is in, still open. */
function fetchRaw(path: string, headers: Record<string, string> = {}, { via = "tunnel", method = "GET" } = {}): Promise<Reply> {
  const target = via === "tunnel" ? { socketPath: tunnelPath } : { host: "127.0.0.1", port: localPort };
  return new Promise((resolve, reject) => {
    const req = request({ ...target, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      const done = (open: boolean) => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks), open });
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (path === "/events" && Buffer.concat(chunks).toString("utf8").endsWith("\n\n")) {
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

describe("JSON replies on the tunnel listener", () => {
  it("gzips a large reply, and it gunzips to exactly the original", async () => {
    const reply = await fetchRaw("/large", { "accept-encoding": "gzip, deflate, br" });
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(reply.headers.vary).toBe("Accept-Encoding");
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.raw.length).toBeLessThan(Buffer.byteLength(JSON.stringify(LARGE)) / 2);
    expect(gunzipSync(reply.raw).equals(Buffer.from(JSON.stringify(LARGE)))).toBe(true);
  });

  it("merges an existing Vary", async () => {
    const reply = await fetchRaw("/vary", { "accept-encoding": "gzip" });
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(reply.headers.vary).toBe("Origin, Accept-Encoding");
  });

  it.each([
    ["without Accept-Encoding", {}],
    ["when gzip has q=0", { "accept-encoding": "gzip;q=0, br" }],
  ])("sends the plain body %s", async (_, headers) => {
    const reply = await fetchRaw("/large", headers);
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.headers.vary).toBe("Accept-Encoding");
    expect(reply.headers["content-length"]).toBe(String(reply.raw.length));
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(LARGE));
  });

  it("leaves a reply under 1 KB untouched", async () => {
    const reply = await fetchRaw("/small", { "accept-encoding": "gzip" });
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.headers.vary).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(SMALL));
  });

  it("leaves an already-encoded reply untouched", async () => {
    const reply = await fetchRaw("/encoded", { "accept-encoding": "gzip" });
    expect(reply.headers["content-encoding"]).toBe("identity");
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(LARGE));
  });

  it("leaves a large non-JSON reply untouched", async () => {
    const reply = await fetchRaw("/text", { "accept-encoding": "gzip" });
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(LARGE));
  });

  it("sends a HEAD reply without an encoding", async () => {
    const reply = await fetchRaw("/large", { "accept-encoding": "gzip" }, { method: "HEAD" });
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.raw.length).toBe(0);
  });

  it("streams an event stream unbuffered and unencoded", async () => {
    const reply = await fetchRaw("/events", { "accept-encoding": "gzip" });
    expect(reply.open, "the first event arrived before the stream ended").toBe(true);
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(`data: ${JSON.stringify(LARGE)}\n\n`);
  });

  it("never reaches an upgrade request", async () => {
    const reply = await fetchRaw("/large", { "accept-encoding": "gzip", connection: "Upgrade", upgrade: "websocket" });
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(LARGE));
  });
});

describe("JSON replies on the local listener", () => {
  it("never compresses, whatever the client accepts", async () => {
    const reply = await fetchRaw("/large", { "accept-encoding": "gzip" }, { via: "local" });
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.headers.vary).toBeUndefined();
    expect(reply.raw.toString("utf8")).toBe(JSON.stringify(LARGE));
  });
});
