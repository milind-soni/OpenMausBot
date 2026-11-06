import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { AuditEvent } from "../src/audit.ts";
import { parseHead, RequestGate, serveRequest } from "../src/home-requests.ts";
import { MuxSession, type MuxStream } from "../src/mux.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The Admin's side and the connector's, joined in memory: each frame one sends, the other receives. */
function joined(incoming: (stream: MuxStream, accept: () => void) => void) {
  const failures: string[] = [];
  let admin!: MuxSession;
  let box!: MuxSession;
  const to = (peer: () => MuxSession) => ({ send: (frame: Uint8Array) => queueMicrotask(() => peer().receive(frame)), bufferedAmount: 0, onceDrained: (listener: () => void) => queueMicrotask(listener) });
  admin = new MuxSession("phone", to(() => box), { failed: (reason) => failures.push(`admin: ${reason}`) });
  box = new MuxSession("computer", to(() => admin), { incoming, failed: (reason) => failures.push(`box: ${reason}`) });
  return { admin, box, failures };
}

const read = (stream: Duplex) => new Promise<string>((resolve) => {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
  stream.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
});

async function home() {
  const requests: string[] = [];
  const counts = { opened: 0, closed: 0 };
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "text/plain", connection: "close" }).end("ok"));
  });
  server.on("connection", (socket) => {
    counts.opened += 1;
    socket.on("close", () => { counts.closed += 1; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  const connectHome = () => new Promise<Duplex>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  return { requests, connectHome, counts };
}

describe("the Admin's requests to the home", () => {
  it("takes one HTTP/1.1 request a stream, with a plain body, and nothing that changes the protocol", () => {
    expect(parseHead("GET /api/cloud/health HTTP/1.1\r\nhost: a.example")).toEqual({ ok: true, head: { method: "GET", target: "/api/cloud/health", length: 0 } });
    expect(parseHead("POST /api/cloud/pairing HTTP/1.1\r\nContent-Length: 42")).toEqual({ ok: true, head: { method: "POST", target: "/api/cloud/pairing", length: 42 } });
    for (const head of [
      "CONNECT example.com:443 HTTP/1.1", "GET http://elsewhere.example/ HTTP/1.1", "GET / HTTP/1.0", "GET /\tx HTTP/1.1",
      "GET / HTTP/1.1\r\nUpgrade: websocket", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked", "POST / HTTP/1.1\r\nContent-Length: -1", "GET / HTTP/1.1\r\nno colon",
    ]) expect(parseHead(head).ok, head).toBe(false);
  });

  it("passes the first request through and refuses a second one on the same stream", async () => {
    const heads: string[] = [];
    const bodies: (string | null)[] = [];
    const gate = new RequestGate((head) => heads.push(`${head.method} ${head.target}`), (body) => bodies.push(body));
    const out: Buffer[] = [];
    gate.on("data", (chunk: Buffer) => out.push(chunk));
    const failed = new Promise<Error>((resolve) => gate.on("error", resolve));
    gate.write("POST /api/cloud/pairing HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}");
    gate.write("GET /api/bots HTTP/1.1\r\n\r\n");
    expect((await failed).message).toBe("a second request on one stream");
    expect(heads).toEqual(["POST /api/cloud/pairing"]);
    expect(bodies).toEqual(["{}"]);
    expect(Buffer.concat(out).toString()).toBe("POST /api/cloud/pairing HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}");
  });

  it("over the channel: the home answers the first request, a pipelined second never reaches it, and both ends hold the profile", async () => {
    const { requests, connectHome, counts } = await home();
    const audits: AuditEvent[] = [];
    const { admin, failures } = joined((stream, accept) => serveRequest(stream, accept, { connectHome, record: (event) => audits.push(event) }));
    const one = admin.openStream();
    const answer = read(one);
    one.write("GET /api/cloud/health?token=secret HTTP/1.1\r\nhost: home.example\r\n\r\nGET /api/bots HTTP/1.1\r\nhost: home.example\r\n\r\n");
    const text = await answer;
    expect(text).toBe("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    expect(requests).toEqual([]);
    // The home's connection, asked for when the first head arrived, is dropped once the stream was refused.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts.opened).toBe(counts.closed);
    const two = admin.openStream();
    const second = read(two);
    two.end("GET /api/cloud/health?token=secret HTTP/1.1\r\nhost: home.example\r\n\r\n");
    expect(await second).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n[\s\S]*ok/);
    expect(requests).toEqual(["GET /api/cloud/health?token=secret"]);
    expect(audits).toEqual([
      { event: "request", by: "admin", method: "GET", path: "/api/cloud/health", status: 400 },
      { event: "request", by: "admin", method: "GET", path: "/api/cloud/health", status: 200 },
    ]);
    expect(JSON.stringify(audits)).not.toContain("secret");
    expect(failures).toEqual([]);
  });

  it("refuses a stream the connector opened: only the Admin opens streams", () => {
    const { box } = joined(() => {});
    expect(() => box.openStream()).toThrow("yamux: computer_open");
  });

  it("is the phone relay's yamux profile, byte for byte", () => {
    const relay = readFileSync(new URL("../../companion/src/e2e/yamux.ts", import.meta.url), "utf8");
    expect(readFileSync(new URL("../src/yamux.ts", import.meta.url), "utf8")).toBe(relay);
  });
});
