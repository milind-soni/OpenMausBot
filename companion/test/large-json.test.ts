// A bot list past the whole-body ceiling (a long history: about 52 MiB in the field) reaches a paired device
// scrubbed, instead of a 502. One test crosses the real 32 MiB ceiling; the rest lower it, so each body stays small.
import { createServer, request, type IncomingHttpHeaders, type RequestListener, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler, type ProxyOptions } from "../src/proxy.ts";
import { gzipTunnelReplies } from "../src/tunnel-gzip.ts";
import { scrub } from "../src/wire.ts";

const TOKEN = "omb_test_token";
const MiB = 1024 * 1024;
const LOW_CEILING = 256 * 1024;

/** Multi-byte characters, quotes and escapes, so chunk edges land inside all of them. */
const LINE = 'A long reply with "quotes", a back\\slash, é, 😀 and a\nnew line. ';
function snapshot(bots: number, messages: number, lines: number) {
  const text = LINE.repeat(lines);
  return {
    bots: Array.from({ length: bots }, (_, b) => ({
      id: `b${b}`,
      name: `Bot ${b}`,
      sshAlias: "my-server",
      tasks: [{ id: `t${b}`, title: "Main", resumeCursors: { claude: `cursor-value-${b}` } }],
      messages: Array.from({ length: messages }, (_, m) => ({ id: `m${b}-${m}`, role: m % 2 ? "bot" : "user", text })),
      hasMore: true,
    })),
    groups: [],
    sections: [],
    resumeCursors: { agent: "cursor-value" },
  };
}
/** About 1.3 MiB: five times the lowered ceiling. */
const SMALL = snapshot(25, 20, 40);
const BODY = Buffer.from(JSON.stringify(SMALL));
const SCRUBBED = JSON.stringify(scrub(SMALL));

let harness: Server;
const servers: Server[] = [];
const ports = { real: 0, lan: 0, origin: 0 };
let respond: (res: ServerResponse) => void = (res) => res.end();

/** Written in odd-sized slices, as a socket would deliver them. */
const send = (res: ServerResponse, body: Buffer): void => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  for (let i = 0; i < body.length; i += 65_521) res.write(body.subarray(i, i + 65_521));
  res.end();
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

/** Whatever bytes arrived, and whether the response ended cleanly or was cut. A connection the proxy neither
 * finishes nor closes fails here by name, rather than as a test timeout. */
function device(port: number, path = "/api/bots", method = "GET", slow = false): Promise<{ status: number; headers: IncomingHttpHeaders; raw: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "gzip" } }, (res) => {
      const chunks: Buffer[] = [];
      let complete = false;
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        // A reader slower than the proxy, so the device's socket backs up and the proxy has to wait for it.
        if (slow) {
          res.pause();
          setTimeout(() => res.resume(), 1);
        }
      });
      res.on("end", () => {
        complete = true;
      });
      res.on("error", () => {});
      res.on("close", () => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks), complete });
      });
    });
    const deadline = setTimeout(() => {
      req.destroy();
      reject(new Error("the proxy neither finished nor closed the connection"));
    }, 15_000);
    req.on("error", () => {
      clearTimeout(deadline);
      resolve({ status: 0, headers: {}, raw: Buffer.alloc(0), complete: false });
    });
    req.end();
  });
}

beforeAll(async () => {
  harness = createServer((_req, res) => respond(res));
  const options = (extra: Partial<ProxyOptions> = {}): ProxyOptions => ({
    harnessPort: 0,
    authenticate: (t) => (t === TOKEN ? { id: "phone-1", cloudDesktopAccess: true, browserControlAccess: true } : null),
    redeem: () => ({ error: "not used here", code: "pairing_code_wrong" }),
    serverName: () => "Test computer",
    ...extra,
  });
  const harnessPort = await listen(harness);
  const real = createProxyHandler(options({ harnessPort }));
  const lowered = createProxyHandler(options({ harnessPort, wholeJsonBodyBytes: LOW_CEILING }));
  const make = (handler: RequestListener) => {
    const server = createServer(handler);
    servers.push(server);
    return listen(server);
  };
  ports.real = await make(real);
  ports.lan = await make(lowered);
  ports.origin = await make(gzipTunnelReplies(lowered));
});

afterAll(async () => {
  for (const server of [...servers, harness]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("a JSON reply past the whole-body ceiling", () => {
  it("crosses the real 32 MiB ceiling and still arrives, scrubbed", async () => {
    // One shared message text keeps the heap small; only the serialised body is this large.
    const big = snapshot(25, 140, 150);
    const body = Buffer.from(JSON.stringify(big));
    expect(body.length).toBeGreaterThan(34 * MiB);
    respond = (res) => send(res, body);
    const { status, raw, complete } = await device(ports.real, "/api/bots", "GET", true);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    const text = raw.toString("utf8");
    expect(text === JSON.stringify(scrub(big))).toBe(true);
    expect(text).not.toContain("cursor-value");
  });

  it("reaches a paired device whole, with the withheld fields gone", async () => {
    expect(BODY.length).toBeGreaterThan(4 * LOW_CEILING);
    respond = (res) => send(res, BODY);
    const { status, headers, raw, complete } = await device(ports.lan);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["content-length"]).toBeUndefined();
    const text = raw.toString("utf8");
    expect(text === SCRUBBED).toBe(true);
    expect(text).not.toContain("cursor-value");
    expect(text).not.toContain("my-server");
    expect((JSON.parse(text) as { bots: unknown[] }).bots).toHaveLength(25);
  });

  it("keeps going to a reader slower than the proxy, long after the socket buffers fill", async () => {
    // Several MiB past the ceiling: on Linux the device's socket backs up many times over. Waiting on the
    // response's 'drain' there stalled for good; this reply must still finish.
    const long = snapshot(25, 40, 150);
    const body = Buffer.from(JSON.stringify(long));
    expect(body.length).toBeGreaterThan(8 * MiB);
    respond = (res) => send(res, body);
    const { status, raw, complete } = await device(ports.lan, "/api/bots", "GET", true);
    expect(status).toBe(200);
    expect(complete).toBe(true);
    expect(raw.toString("utf8") === JSON.stringify(scrub(long))).toBe(true);
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
    const notJson = Buffer.from(`not JSON ${"x".repeat(2 * LOW_CEILING)}`);
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
