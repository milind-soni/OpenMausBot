import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionRegistry } from "../sessions.ts";
import { resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { json, readBody } from "../harness/http.ts";
import { SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget, poolLocalVmTarget, type ContainerComputerStatus } from "../container-computer.ts";
import { createDesktopViewer, desktopViewerUrl, type DesktopTarget } from "./desktop-viewer.ts";
import { localDesktopTarget, localVmViewerStatus, viewerTargetId } from "../desktop-viewer-targets.ts";

let dir: string;
let sessions: SessionRegistry;
let viewer: ReturnType<typeof createDesktopViewer>;
let app: Server;
let desktop: Server;
let appPort: number;
let desktopPort: number;
let admin: ReturnType<SessionRegistry["issue"]>;
let member: ReturnType<SessionRegistry["issue"]>;
let vpsTarget: DesktopTarget | undefined;
let inspected: string[];
let seenHeaders: IncomingHttpHeaders;
let seenPath: string | undefined;
let touched: string[];
let statusOverrides: Partial<ContainerComputerStatus>;
let inspection: Promise<void> | undefined;
let now: number;
let targetLookups: number;
let handled: () => void;
let targets = [SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget("test-bot"), poolLocalVmTarget(1)];
const peers = new Set<Duplex>();
const base = "/api/desktop-viewer/local/shared";
const remoteHeaders = { host: "workspace.example", origin: "https://workspace.example", "x-forwarded-proto": "https" };

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function headers(token = admin.token) { return { ...remoteHeaders, cookie: `test_session=${token}` }; }

function get(path: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path, headers: { ...headers(), ...extra } }, res => {
      let text = "";
      res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end();
  });
}

function open(path = `${base}/websockify`, overrides: Record<string, string> = {}, rawKey = "dGhlIHNhbXBsZSBub25jZQ==") {
  return new Promise<{ status: number; socket?: Duplex; body?: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path, headers: {
      ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": rawKey, "Sec-WebSocket-Version": "13", ...overrides,
    } });
    req.once("upgrade", (res, socket) => { peers.add(socket); resolve({ status: res.statusCode!, socket }); });
    req.once("response", res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-viewer-"));
  now = Date.now();
  sessions = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => now });
  admin = sessions.issue({ label: "Mac", scopes: ["admin", "client"] });
  member = sessions.issue({ label: "Member", scopes: ["client"] });
  inspected = []; touched = []; statusOverrides = {}; inspection = undefined; seenPath = undefined;
  vpsTarget = undefined;
  targetLookups = 0; handled = () => {};
  targets = [SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget("test-bot"), poolLocalVmTarget(1)];
  desktop = createServer((_req, res) => res.writeHead(404).end());
  desktop.on("upgrade", (req, socket) => {
    peers.add(socket);
    seenHeaders = req.headers; seenPath = req.url;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Bytes are opaque to the proxy; echo them to check both directions.
    socket.on("data", data => socket.write(data));
    socket.on("error", () => {});
  });
  desktopPort = await listen(desktop);
  viewer = createDesktopViewer({
    target: id => {
      targetLookups++;
      if (id === "vps/test-bot") return vpsTarget;
      const target = targets.find(target => viewerTargetId(target) === id);
      return target && localDesktopTarget(target, {
        status: async target => {
          inspected.push(target.key);
          await inspection;
          return {
            managed: true, imageMatches: true, network: "loopback", container: "running", viewer_port: desktopPort,
            viewer_url: `http://127.0.0.1:${desktopPort}/vnc.html#password=fixture-secret`, ...statusOverrides,
          } as ContainerComputerStatus;
        },
        touch: target => touched.push(target.key),
      });
    },
    live: auth => auth.kind === "loopback" || sessions.isLive(auth.session.id),
  });
  sessions.onSessionRevoked(id => viewer.closeForOwner(id));
  const handle = async (req: Parameters<typeof resolveRequestAuth>[0], res: Parameters<typeof json>[0]) => {
    const url = new URL(req.url!, "http://localhost");
    const gate = resolveRequestAuth(req, { sessions, cookieName: "test_session", url, streamPath: "/api/events", loopbackTrust: "service" });
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    await viewer.route({ req, res, url, path: url.pathname, method: req.method!, auth: gate.auth, json, readBody });
    handled();
  };
  app = createServer((req, res) => void handle(req, res));
  viewer.attach(app, handle);
  appPort = await listen(app);
});

afterEach(async () => {
  viewer.closeAll();
  for (const peer of peers) peer.destroy();
  peers.clear();
  await Promise.all([app, desktop].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  rmSync(dir, { recursive: true, force: true });
});

it("proxies opaque bytes and keeps workspace credentials out of the VM", async () => {
  const answer = await open(`${base}/websockify?host=evil.example&token=do-not-forward`, { authorization: `Bearer ${admin.token}`, "sec-websocket-protocol": "binary" });
  expect(answer.status).toBe(101);
  const socket = answer.socket!;
  const echo = new Promise<Buffer>(resolve => socket.once("data", resolve));
  const bytes = Buffer.from([0, 255, 12, 13, 127]);
  socket.write(bytes);
  expect(await echo).toEqual(bytes);
  expect(seenPath).toBe("/websockify");
  expect(seenHeaders.cookie).toBeUndefined();
  expect(seenHeaders.authorization).toBeUndefined();
  expect(seenHeaders["x-forwarded-proto"]).toBeUndefined();
  expect(seenHeaders["sec-websocket-protocol"]).toBeUndefined();
  expect(touched).toContain("shared");
});

it("protects HTTP and upgrade requests with the existing session and scope checks", async () => {
  for (const [extra, expected] of [
    [{ cookie: "" }, 403], [{ cookie: `test_session=${member.token}` }, 403],
    [{ origin: "https://evil.example" }, 403], [{ cookie: "test_session=revoked" }, 401],
  ] as const) {
    expect((await open(undefined, extra)).status).toBe(expected);
    expect((await get(base, extra)).status).toBe(expected);
  }
  expect(inspected).toEqual([]);
});

it("returns fresh credentials only to admins and selects shared, per-bot and pool targets", async () => {
  for (const target of targets) {
    const path = `/api/desktop-viewer/${viewerTargetId(target)}`;
    const response = await get(path);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({ password: "fixture-secret" });
    expect((await open(`${path}/websockify`)).status).toBe(101);
  }
  expect(inspected).toContain(targets[1].key);
  expect(inspected).toContain("pool:1");
  expect((await open("/api/desktop-viewer/local/pool-999/websockify")).status).toBe(404);
  expect((await open("/api/desktop-viewer/local/127.0.0.1:22/websockify")).status).toBe(404);
});

it.each([
  { managed: false }, { imageMatches: false }, { network: "unsafe" }, { container: "stopped" },
  { viewer_port: null }, { viewer_port: null, viewer_url: "" }, { viewer_port: 0 }, { viewer_port: 65536 },
])("refuses unavailable or untrusted containers: %j", async override => {
  statusOverrides = override as Partial<ContainerComputerStatus>;
  expect((await open()).status).toBe(409);
});

it("rejects ordinary HTTP on the socket path and invalid WebSocket handshakes", async () => {
  expect((await get(`${base}/websockify`)).status).toBe(426);
  expect((await open(undefined, {}, "invalid")).status).toBe(400);
  expect((await open(undefined, { "sec-websocket-version": "12" })).status).toBe(400);
});

it("closes an established viewer when its paired session is revoked", async () => {
  const socket = (await open()).socket!;
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  sessions.revoke(admin.session.id);
  await closed;
  expect((await open()).status).toBe(401);
});

it("expires an open viewer without renewing its session in the background", async () => {
  const socket = (await open()).socket!;
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  now = sessions.list().find(session => session.id === admin.session.id)!.expiresAt + 1;
  await closed;
  expect((await open()).status).toBe(401);
}, 8000);

it("rechecks access after asynchronous container inspection", async () => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const result = get(base);
  await expect.poll(() => inspected.length).toBe(1);
  sessions.revoke(admin.session.id);
  inspectedDone();
  expect((await result).status).toBe(401);
  expect(seenPath).toBeUndefined();
});

it.each(["shutdown", "revocation"])("closes a pending upgrade immediately on %s", async action => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const accepted = once(app, "connection");
  const completed = new Promise<void>(resolve => { handled = resolve; });
  const rejected = expect(open()).rejects.toThrow();
  await expect.poll(() => inspected.length).toBe(1);
  const [socket] = await accepted;
  try {
    if (action === "shutdown") viewer.closeAll();
    else sessions.revoke(admin.session.id);
    await expect.poll(() => socket.destroyed, { timeout: 1000 }).toBe(true);
    await rejected;
  } finally {
    inspectedDone();
  }
  await completed;
  expect(seenPath).toBeUndefined();
  if (action === "shutdown") await expect(open()).rejects.toThrow();
});

it("closes established viewers during shutdown", async () => {
  const socket = (await open()).socket!;
  const closed = once(socket, "close");
  viewer.closeAll();
  await closed;
  await expect(open()).rejects.toThrow();
});

it("does not connect upstream after the waiting browser disconnects", async () => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const accepted = once(app, "connection");
  const completed = new Promise<void>(resolve => { handled = resolve; });
  const req = request({ hostname: "127.0.0.1", port: appPort, path: `${base}/websockify`, headers: {
    ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
  } });
  req.on("error", () => {});
  req.end();
  await expect.poll(() => inspected.length).toBe(1);
  const [serverSocket] = await accepted;
  const closed = once(serverSocket, "close");
  req.destroy();
  await closed;
  inspectedDone();
  await completed;
  expect(targetLookups).toBe(1);
  expect(seenPath).toBeUndefined();
});

it("closes viewers whose target disappears, and keeps active viewers from idle removal", async () => {
  const socket = (await open()).socket!;
  await expect.poll(() => touched.length, { timeout: 7000 }).toBeGreaterThan(1);
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  targets = [];
  await closed;
}, 15_000);

it("returns a bounded error when the viewer refuses an upgrade", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  expect((await open()).status).toBe(502);
});

it("refuses forged upstream handshakes and does not forward upstream cookies", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => {
    peers.add(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: forged\r\nSet-Cookie: injected=true\r\n\r\n");
  });
  expect((await open()).status).toBe(502);
});

it("times out an upstream that never answers the handshake", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => { peers.add(socket); });
  expect((await open()).status).toBe(502);
}, 13_000);

it("preserves local desktop URLs and removes passwords from paired viewer links", () => {
  const original = { target_key: targets[1].key, viewer_url: "http://127.0.0.1:49152/vnc.html#password=secret" };
  const local: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  expect(localVmViewerStatus(original, local)).toBe(original);
  const remote: RequestAuth = { kind: "session", session: sessions.authenticate(admin.token)!, via: "cookie", scopes: admin.session.scopes };
  expect(localVmViewerStatus(original, remote).viewer_url).toBe(desktopViewerUrl(viewerTargetId(targets[1])));
});

it("uses the same authenticated proxy for VPS and releases only its own connection", async () => {
  let holds = 0;
  vpsTarget = { key: "vps/test-bot", resolve: async () => ({
    port: desktopPort, password: "fixture-secret",
    retain: () => { holds++; return () => { holds--; }; },
  }) };
  const path = "/api/desktop-viewer/vps/test-bot";
  expect((await get(path)).body).toEqual({ password: "fixture-secret" });
  expect(holds).toBe(0);
  const first = (await open(`${path}/websockify`)).socket!;
  const second = (await open(`${path}/websockify`)).socket!;
  expect(holds).toBe(2);
  first.destroy();
  await expect.poll(() => holds).toBe(1);
  expect(second.destroyed).toBe(false);
  const closed = once(second, "close");
  sessions.revoke(admin.session.id);
  await closed;
  expect(holds).toBe(0);
});
