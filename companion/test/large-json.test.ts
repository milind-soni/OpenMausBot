// A bot list past the whole-body ceiling (a long history: 25 bots of 200 recent messages, about 52 MiB) reaches a
// paired device scrubbed, instead of a 502.
import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { gzipTunnelReplies } from "../src/tunnel-gzip.ts";
import { scrub } from "../src/wire.ts";

const TOKEN = "omb_test_token";
const MiB = 1024 * 1024;

/** Multi-byte characters, quotes and escapes, so chunk edges land inside all of them. */
const LINE = 'A long reply with "quotes", a back\\slash, é, 😀 and a\nnew line. ';
const bots = Array.from({ length: 25 }, (_, b) => ({
  id: `b${b}`,
  name: `Bot ${b}`,
  sshAlias: "my-server",
  tasks: [{ id: `t${b}`, title: "Main", resumeCursors: { claude: `cursor-value-${b}` } }],
  messages: Array.from({ length: 200 }, (_, m) => ({ id: `m${b}-${m}`, role: m % 2 ? "bot" : "user", text: LINE.repeat(150) })),
  hasMore: true,
}));
const BODY = Buffer.from(JSON.stringify({ bots, groups: [], sections: [], resumeCursors: { agent: "cursor-value" } }));
const SCRUBBED = JSON.stringify(scrub(JSON.parse(BODY.toString("utf8"))));

let harness: Server;
let lan: Server;
let origin: Server;
const ports = { lan: 0, origin: 0 };
let respond: (res: ServerResponse) => void = (res) => res.end();

/** Written in odd-sized slices, as a socket would deliver them. */
const send = (res: ServerResponse, body: Buffer): void => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  for (let i = 0; i < body.length; i += 65_521) res.write(body.subarray(i, i + 65_521));
  res.end();
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

/** Whatever bytes arrived, and whether the response ended cleanly or was cut. */
function device(port: number, path = "/api/bots", method = "GET"): Promise<{ status: number; headers: IncomingHttpHeaders; raw: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip" } }, (res) => {
      const chunks: Buffer[] = [];
      let complete = false;
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        complete = true;
      });
      res.on("error", () => {});
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks), complete }));
    });
    req.on("error", () => resolve({ status: 0, headers: {}, raw: Buffer.alloc(0), complete: false }));
    req.end();
  });
}

beforeAll(async () => {
  harness = createServer((_req, res) => respond(res));
  const proxy = createProxyHandler({
    harnessPort: await listen(harness),
    authenticate: (t) => (t === TOKEN ? { id: "phone-1", cloudDesktopAccess: true, browserControlAccess: true } : null),
    redeem: () => ({ error: "not used here" }),
    serverName: () => "Test computer",
  });
  lan = createServer(proxy);
  origin = createServer(gzipTunnelReplies(proxy));
  ports.lan = await listen(lan);
  ports.origin = await listen(origin);
});

afterAll(async () => {
  for (const server of [lan, origin, harness]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("a JSON reply past the whole-body ceiling", () => {
  it("is the size of a long history", () => {
    expect(BODY.length).toBeGreaterThan(48 * MiB);
  });

  it("reaches a paired device whole, with the withheld fields gone", async () => {
    respond = (res) => send(res, BODY);
    const { status, headers, raw, complete } = await device(ports.lan);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    expect(headers["cache-control"]).toBe("private, no-store");
    const text = raw.toString("utf8");
    expect(text.length).toBe(SCRUBBED.length);
    expect(text === SCRUBBED).toBe(true);
    expect(text).not.toContain("cursor-value");
    expect(text).not.toContain("my-server");
    expect((JSON.parse(text) as { bots: unknown[] }).bots).toHaveLength(25);
  });

  it("is gzipped as it streams on the phone tunnel", async () => {
    respond = (res) => send(res, BODY);
    const { status, headers, raw, complete } = await device(ports.origin);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers.vary).toContain("Accept-Encoding");
    expect(raw.length).toBeLessThan(BODY.length / 10);
    expect(gunzipSync(raw).toString("utf8") === SCRUBBED).toBe(true);
  });

  it("passes through verbatim when it was never JSON, as a small body does", async () => {
    const notJson = Buffer.from(`not JSON ${"x".repeat(40 * MiB)}`);
    respond = (res) => send(res, notJson);
    const { status, raw, complete } = await device(ports.lan);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    expect(raw.equals(notJson)).toBe(true);
  });

  it("is cut off, never finished unscrubbed, when it stops being JSON after its start went out", async () => {
    const tail = Buffer.from(' {"resumeCursors":{"agent":"late-cursor"}}');
    respond = (res) => send(res, Buffer.concat([BODY, tail]));
    const { raw, complete } = await device(ports.lan);
    expect(complete).toBe(false);
    expect(raw.toString("utf8")).not.toContain("late-cursor");
  });

  it("still refuses an oversized answer that must be checked whole", async () => {
    respond = (res) => send(res, BODY);
    const { status, raw } = await device(ports.lan, "/api/bots/b1/browser/action", "POST");
    expect(status).toBe(502);
    expect(raw.toString("utf8")).toContain("too large");
  });
});
