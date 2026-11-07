import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { LinkStream } from "../electron/device-link-protocol.mjs";
import { replayHttp, replayPath } from "./lent-mcp-link.ts";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
});

const within = <T>(promise: Promise<T>, ms = 3000): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, fail) => setTimeout(() => fail(new Error("timed out")), ms).unref())]);

const PREFIX = "/api/internal/lent/mcp/local";

/** A loopback MCP server on the lent computer. */
async function upstream(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => { seen.push(req.headers); answer(req, res); });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** The link as the computer serves it: the stream is a fresh TCP connection to the port. */
const stream = (port: number): LinkStream => ({
  join(socket) {
    const server = connect(port, "127.0.0.1");
    sockets.push(server);
    server.on("error", () => socket.destroy());
    server.pipe(socket);
    socket.pipe(server);
    socket.on("close", () => server.destroy());
  },
  cancel() {},
});

/** My Cloud's door: replays every request onto the computer's server. */
async function door(port: number, headers: Record<string, string> = {}) {
  const server = createServer((req, res) => replayHttp(req, res, stream(port), { port, path: "/mcp", prefix: PREFIX, headers }));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("replayHttp", () => {
  it("replays with the saved headers, Host rewritten and Connection close, and the engine's authorization never sent", async () => {
    const { port, seen } = await upstream((_req, res) => res.end("ok"));
    const base = await door(port, { authorization: "Bearer mac-header-key", "x-api-key": "k" });
    const answer = await within(fetch(`${base}/x`, { headers: { authorization: "Bearer turn-token", "x-engine": "e", "accept-encoding": "gzip" } }));
    expect(await answer.text()).toBe("ok");
    expect(seen[0]).toMatchObject({ authorization: "Bearer mac-header-key", "x-api-key": "k", "x-engine": "e", host: `127.0.0.1:${port}`, connection: "close" });
    expect(JSON.stringify(seen)).not.toContain("turn-token");
    expect(seen[0]?.["accept-encoding"]).toBeUndefined();
  });

  it("SSE streams through and Connection: close is not passed on", async () => {
    let finish!: () => void;
    const { port } = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      finish = () => res.end("data: second\n\n");
    });
    const answer = await within(fetch(await door(port)));
    expect(answer.headers.get("connection")).not.toBe("close");
    const reader = answer.body!.getReader();
    expect(new TextDecoder().decode((await within(reader.read())).value)).toBe("data: first\n\n");
    finish();
    expect(new TextDecoder().decode((await within(reader.read())).value)).toBe("data: second\n\n");
  });

  it("an SSE endpoint event is re-prefixed", async () => {
    const { port } = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages?sessionId=1\n\n");
      res.end(`event: endpoint\ndata: http://127.0.0.1:${port}/messages?sessionId=2\n\nevent: message\ndata: /untouched\n\n`);
    });
    const text = await within(fetch(await door(port)).then((answer) => answer.text()));
    expect(text).toBe(
      `event: endpoint\ndata: ${PREFIX}/messages?sessionId=1\n\n` +
      `event: endpoint\ndata: ${PREFIX}/messages?sessionId=2\n\n` +
      "event: message\ndata: /untouched\n\n",
    );
  });

  it("an endpoint event split across chunks is still re-prefixed", async () => {
    const { port } = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endp");
      res.write("oint\ndata: /mess");
      res.end("ages?sessionId=3\n\n");
    });
    const text = await within(fetch(await door(port)).then((answer) => answer.text()));
    expect(text).toBe(`event: endpoint\ndata: ${PREFIX}/messages?sessionId=3\n\n`);
  });

  it("a multibyte character split across chunks arrives intact", async () => {
    const bytes = Buffer.from("data: caf\u00e9 \u{1F600}\n\n");
    const cut = bytes.indexOf(0xc3) + 1;
    const { port } = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(bytes.subarray(0, cut));
      setImmediate(() => res.end(bytes.subarray(cut)));
    });
    expect(await within(fetch(await door(port)).then((answer) => answer.text()))).toBe("data: caf\u00e9 \u{1F600}\n\n");
  });

  it("an unparseable endpoint value passes through and later events still arrive", async () => {
    const { port } = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: endpoint\ndata: http://[\n\nevent: message\ndata: after\n\n");
    });
    expect(await within(fetch(await door(port)).then((answer) => answer.text()))).toBe("event: endpoint\ndata: http://[\n\nevent: message\ndata: after\n\n");
  });

  it("the engine closing its response mid-SSE closes the connection on the computer", async () => {
    let far!: Socket;
    const { port } = await upstream((req, res) => {
      far = req.socket;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
    });
    const abort = new AbortController();
    const answer = await within(fetch(await door(port), { signal: abort.signal }));
    await within(answer.body!.getReader().read());
    const closed = within(new Promise<void>((done) => far.once("close", () => done())));
    abort.abort();
    await closed;
  });
});

describe("replayPath", () => {
  const saved = { path: "/mcp", query: "" };
  it("maps the bare door to the saved path and query, a sub-path to the server root with its own query, and anything else to null", () => {
    expect(replayPath("/api/internal/lent/mcp/local", PREFIX, { path: "/mcp", query: "?a=1" })).toBe("/mcp?a=1");
    expect(replayPath("/api/internal/lent/mcp/local/messages?sessionId=1", PREFIX, saved)).toBe("/messages?sessionId=1");
    expect(replayPath("/api/internal/lent/mcp/localx", PREFIX, saved)).toBeNull();
  });
});
