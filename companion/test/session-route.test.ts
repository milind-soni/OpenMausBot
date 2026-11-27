import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createE2EOrigin } from "../src/e2e/origin.ts";
import type { E2EContext } from "../src/e2e/registry.ts";
import { createProxyHandler } from "../src/proxy.ts";

const servers: Server[] = [];
const closers: (() => void)[] = [];
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  return address.port;
}
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const DEVICE: E2EContext = { peer: { kind: "device", id: "web-1" }, route: "relay" };
const PAIRING: E2EContext = { peer: { kind: "pairing", admHash: "adm" }, route: "relay" };

async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function rig(harnessPortOverride?: number) {
  const received: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let hungClosed!: () => void;
  const hung = new Promise<void>((resolve) => { hungClosed = resolve; });
  const harness = createServer(async (req, res) => {
    if (req.url === "/api/cut") {
      // The harness goes away after half its reply.
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      return setImmediate(() => req.socket.destroy());
    }
    if (req.url === "/api/hop") {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: "" });
      return res.writeHead(200, { connection: "x-reply-hop", "x-reply-hop": "harness-local", "x-from": "server" }).end("ok");
    }
    if (req.url === "/api/hang") {
      req.socket.once("close", hungClosed);
      return received.push({ method: req.method, url: req.url, headers: req.headers, body: "" });
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json", "x-from": "server" }).end(JSON.stringify({ ok: req.url }));
  });
  const wss = new WebSocketServer({ noServer: true });
  harness.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/hop-upgrade") {
      closers.push(() => socket.destroy());
      return socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade, X-Reply-Hop\r\nX-Reply-Hop: harness-local\r\nX-From: server\r\n\r\n");
    }
    if (req.url === "/api/cut-upgrade") {
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 100\r\n\r\npartial");
      return setImmediate(() => socket.destroy());
    }
    received.push({ method: req.method, url: req.url, headers: req.headers, body: "" });
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo:${data}`)));
  });
  closers.push(() => wss.close());
  const harnessPort = harnessPortOverride ?? await listen(harness);
  const proxy = createProxyHandler({
    harnessPort, mutationToken: () => "private-relay-secret",
    authenticate: (token) => token === "phone-token" ? { id: "web-1", cloudDesktopAccess: false, browserControlAccess: false } : null,
    redeem: () => ({ error: "not pairing", code: "pairing_code_wrong" }), serverName: () => "Fixture",
  });
  const deviceSockets: Duplex[] = [];
  const origin = createE2EOrigin((req, res) => {
    deviceSockets.push(req.socket);
    proxy(req, res);
  }, (req, socket, head) => proxy.upgrade(req, socket, head));
  closers.push(() => origin.close());
  const lanPort = await listen(createServer((req, res) => proxy(req, res, "lan")));
  return { received, origin, lanPort, hung, deviceSockets };
}

function send(stream: Duplex | null, port: number | null, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({
      method, path, headers,
      ...(stream ? { createConnection: () => stream as never } : { host: "127.0.0.1", port: port!, agent: false }),
    }, async (res) => {
      let text = "";
      for await (const chunk of res) text += chunk;
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
    });
    req.once("error", reject);
    req.end(body);
  });
}

const FORGED = {
  cookie: "omb_session=owner-cookie",
  "x-openmausbot-companion-auth": "forged",
  "x-openmausbot-desktop-owner": "forged-owner",
  "x-forwarded-for": "127.0.0.1",
  "x-real-ip": "127.0.0.1",
  forwarded: "for=127.0.0.1",
};

it("carries a web server session over the encrypted route as a remote request, to any route the server allows", async () => {
  const { received, origin } = await rig();
  const res = await send(await origin.connect(DEVICE), null, "PUT", "/api/config?x=1", {
    authorization: "Bearer omb_sess_abc", "content-type": "application/json", ...FORGED,
  }, "{\"a\":1}");
  expect(res.status).toBe(200);
  expect(res.headers["x-from"]).toBe("server");
  expect(received).toHaveLength(1);
  const [seen] = received;
  expect(seen).toMatchObject({ method: "PUT", url: "/api/config?x=1", body: "{\"a\":1}" });
  expect(seen.headers.authorization).toBe("Bearer omb_sess_abc");
  expect(seen.headers.host).toBe("companion-relay.invalid");
  expect(seen.headers["x-forwarded-for"]).toBe("relay-web-1");
  for (const name of ["cookie", "origin", "x-real-ip", "forwarded", "x-openmausbot-companion-auth", "x-openmausbot-desktop-owner", "x-openmausbot-companion-device"]) {
    expect(seen.headers[name], name).toBeUndefined();
  }
});

it("lets a paired device sign in to the web server with its pairing code", async () => {
  const { received, origin } = await rig();
  const res = await send(await origin.connect(DEVICE), null, "POST", "/api/auth/pair", { "content-type": "application/json" }, "{\"code\":\"123456\"}");
  expect(res.status).toBe(200);
  expect(received[0]).toMatchObject({ url: "/api/auth/pair", body: "{\"code\":\"123456\"}" });
  expect(received[0].headers["x-forwarded-for"]).toBe("relay-web-1");
});

it("keeps the phone app's surface for everyone else", async () => {
  const { received, origin, lanPort } = await rig();
  // Not yet admitted: the pairing peer never reaches the web server.
  expect((await send(await origin.connect(PAIRING), null, "PUT", "/api/config", { authorization: "Bearer omb_sess_abc" })).status).not.toBe(200);
  // Not over the encrypted route: a session token on the LAN listener gets no pass-through.
  expect((await send(null, lanPort, "PUT", "/api/config", { authorization: "Bearer omb_sess_abc" })).status).toBe(401);
  // Other routes and other tokens keep the allowlist.
  expect((await send(await origin.connect(DEVICE), null, "PATCH", "/api/config", { authorization: "Bearer phone-token" })).status).toBe(403);
  expect((await send(await origin.connect(DEVICE), null, "POST", "/api/auth/pair", { authorization: "Bearer phone-token" })).status).not.toBe(200);
  expect(received).toHaveLength(0);
  // The phone app's own allowed route still gets the companion's capability, never the session route's marking.
  await send(await origin.connect(DEVICE), null, "POST", "/api/bots/b/read", { authorization: "Bearer phone-token" });
  expect(received).toHaveLength(1);
  expect(received[0].headers["x-openmausbot-companion-auth"]).toBe("private-relay-secret");
  expect(received[0].headers["x-forwarded-for"]).toBeUndefined();
});

it("carries the web server's live socket for a session", async () => {
  const { received, origin } = await rig();
  const stream = await origin.connect(DEVICE);
  const ws = new WebSocket("ws://desktop.invalid/api/events", {
    headers: { authorization: "Bearer omb_sess_abc", cookie: "omb_session=owner-cookie", "x-forwarded-for": "127.0.0.1" },
    createConnection: () => stream as never,
  });
  await once(ws, "open");
  ws.send("hi");
  const [reply] = await once(ws, "message");
  expect(String(reply)).toBe("echo:hi");
  ws.close();
  expect(received[0].headers).toMatchObject({ authorization: "Bearer omb_sess_abc", host: "companion-relay.invalid", "x-forwarded-for": "relay-web-1" });
  expect(received[0].headers.cookie).toBeUndefined();
});

it("closes the server's request when the device leaves before the reply", async () => {
  const { received, origin, hung, deviceSockets } = await rig();
  const stream = await origin.connect(DEVICE);
  const pending = send(stream, null, "GET", "/api/hang", { authorization: "Bearer omb_sess_abc" }).catch(() => null);
  await expect.poll(() => received.length).toBe(1);
  deviceSockets[0].destroy(); // the connection to the device is gone
  await hung;
  await pending;
});

it("says so when OpenMausBot is not running, for requests and live sockets", async () => {
  const { origin } = await rig(await closedPort());
  const res = await send(await origin.connect(DEVICE), null, "GET", "/api/bots", { authorization: "Bearer omb_sess_abc" });
  expect(res.status).toBe(502);
  expect(JSON.parse(res.body)).toEqual({ error: "OpenMausBot is not running on this computer" });
  const stream = await origin.connect(DEVICE);
  const ws = new WebSocket("ws://desktop.invalid/api/events", { headers: { authorization: "Bearer omb_sess_abc" }, createConnection: () => stream as never });
  ws.once("error", () => {});
  const [, refused] = await once(ws, "unexpected-response");
  expect((refused as { statusCode: number }).statusCode).toBe(502);
});

it("drops the headers a Connection header names, both ways", async () => {
  const { received, origin } = await rig();
  const res = await send(await origin.connect(DEVICE), null, "GET", "/api/hop", {
    authorization: "Bearer omb_sess_abc", connection: "x-hop-state", "x-hop-state": "device-local",
  });
  expect(res.status).toBe(200);
  expect(received[0].headers["x-hop-state"]).toBeUndefined();
  expect(received[0].headers.authorization).toBe("Bearer omb_sess_abc");
  expect(res.headers["x-reply-hop"]).toBeUndefined();
  expect(res.headers["x-from"]).toBe("server");
});

it("ends the device's reply when the harness drops mid-reply", async () => {
  const { origin } = await rig();
  const stream = await origin.connect(DEVICE);
  const req = request({ method: "GET", path: "/api/cut", headers: { authorization: "Bearer omb_sess_abc" }, createConnection: () => stream as never });
  req.once("error", () => {});
  req.end();
  const [res] = await once(req, "response") as [IncomingMessage];
  res.once("error", () => {}); // "aborted": the reply ends short
  res.resume();
  await new Promise((resolve) => res.once("close", resolve));
  expect(res.complete).toBe(false);
});

it("ends a refused live socket when the harness drops mid-reply", async () => {
  const { origin } = await rig();
  const stream = await origin.connect(DEVICE);
  let text = "";
  stream.on("data", (chunk) => { text += chunk; });
  stream.once("error", () => {});
  const ended = new Promise((resolve) => { stream.once("end", resolve); stream.once("close", resolve); });
  stream.write("GET /api/cut-upgrade HTTP/1.1\r\nHost: desktop.invalid\r\nAuthorization: Bearer omb_sess_abc\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await ended;
  expect(text).toMatch(/^HTTP\/1\.1 403/);
});

it("drops the headers a Connection header names from a live socket's 101 reply", async () => {
  const { origin } = await rig();
  const stream = await origin.connect(DEVICE);
  let text = "";
  const head = new Promise<void>((resolve) => stream.on("data", (chunk) => {
    text += chunk;
    if (text.includes("\r\n\r\n")) resolve();
  }));
  stream.write("GET /api/hop-upgrade HTTP/1.1\r\nHost: desktop.invalid\r\nAuthorization: Bearer omb_sess_abc\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await head;
  expect(text).toMatch(/^HTTP\/1\.1 101 /);
  expect(text).toMatch(/\r\nupgrade: websocket\r\n/i);
  expect(text).toMatch(/\r\nconnection: upgrade\r\n/i);
  expect(text).toMatch(/\r\nx-from: server\r\n/i);
  expect(text.toLowerCase()).not.toContain("x-reply-hop");
  stream.destroy();
});
