import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionViewerRelay, type ControlCheck } from "../src/viewer-relay.ts";

const servers: Server[] = [];
const sockets: Duplex[] = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

const viewerFixture = async () => {
  let resolveUpstream: (socket: Duplex) => void = () => {};
  const upstream = new Promise<Duplex>((resolve) => {
    resolveUpstream = resolve;
  });
  const viewer = createServer();
  viewer.on("upgrade", (_req, socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nviewer-ready",
    );
    resolveUpstream(socket);
  });
  servers.push(viewer);
  const viewerPort = await listen(viewer);
  const relay = new CompanionViewerRelay();
  const rewritten = relay.rewriteJoinResponse(
    "/api/bots/bot-1/computer/join",
    { joinUrl: `http://127.0.0.1:${viewerPort}/vnc.html` },
    "device-1",
  ) as { joinUrl: string };
  const sessionPath = rewritten.joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
  const device = { id: "device-1", cloudDesktopAccess: true };
  const sidecar = createServer();
  sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, device));
  servers.push(sidecar);
  const sidecarPort = await listen(sidecar);
  return { relay, sessionPath, sidecar, sidecarPort, upstream };
};

const openViewer = (port: number, path: string, until?: string) =>
  new Promise<{ client: Socket; response: string }>((resolve, reject) => {
    const client = createConnection({ host: "127.0.0.1", port });
    sockets.push(client);
    let response = "";
    client.setEncoding("utf8");
    client.on("error", () => {});
    client.on("data", (chunk) => {
      response += chunk;
      if (until && response.includes(until)) resolve({ client, response });
    });
    client.once("close", () => resolve({ client, response }));
    client.once("connect", () => client.write(
      `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n"
        + "Sec-WebSocket-Key: dGVzdA==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
    ));
    client.setTimeout(2_000, () => reject(new Error("viewer WebSocket timed out")));
  });

describe("VPS companion viewer relay", () => {
  it("rewrites only a generated loopback noVNC URL and keeps its password in the fragment", () => {
    const relay = new CompanionViewerRelay();
    const rewritten = relay.rewriteJoinResponse(
      "/api/bots/bot-1/computer/join",
      { joinUrl: "http://127.0.0.1:45678/vnc.html#autoconnect=true&password=viewer-secret" },
      "device-1",
    ) as { joinUrl: string };
    expect(rewritten.joinUrl).toMatch(/^\/vps-viewer\/[A-Za-z0-9_-]{32}\/vnc\.html#/);
    expect(rewritten.joinUrl).toContain("password=viewer-secret");
    expect(rewritten.joinUrl).toContain("path=vps-viewer%2F");
    expect(rewritten.joinUrl).not.toContain("127.0.0.1");

    expect(relay.rewriteJoinResponse(
      "/api/bots/bot-1/computer/join",
      { joinUrl: "http://203.0.113.8:6901/vnc.html#password=stolen" },
      "device-1",
    )).toEqual({ joinUrl: "http://203.0.113.8:6901/vnc.html#password=stolen" });

    expect(relay.rewriteJoinResponse(
      "/api/bots/bot-1/local-computer/run",
      { joinUrl: "http://127.0.0.1:45679/vnc.html#password=vm-secret" },
      "device-1",
    )).toEqual({ joinUrl: "http://127.0.0.1:45679/vnc.html#password=vm-secret" });
  });

  it("binds a Local VM viewer to its control lease, checks it only while a socket is open, and closes it once that lease lets go", async () => {
    const viewer = createServer();
    viewer.on("upgrade", (_req, socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nviewer-ready");
    });
    servers.push(viewer);
    const vmJoin = { joinUrl: `http://127.0.0.1:${await listen(viewer)}/vnc.html#password=vm-secret` };
    // No lease, or nothing to check it with: never handed out.
    expect(() => new CompanionViewerRelay().rewriteJoinResponse(
      "/api/bots/bot-1/local-computer/join", vmJoin, "device-1", "phone-lease-0123456789",
    )).toThrow(/control lease/);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let owned = true;
      const asked: string[] = [];
      const relay = new CompanionViewerRelay({
        checkIntervalMs: 1_000,
        checkControl: async (deviceId, botId, lease) => {
          asked.push(`${deviceId}/${botId}/${lease}`);
          return owned;
        },
      });
      expect(() => relay.rewriteJoinResponse("/api/bots/bot-1/local-computer/join", vmJoin, "device-1", null)).toThrow();
      expect(() => relay.rewriteJoinResponse("/api/bots/bot-1/local-computer/join", vmJoin, "device-1", "short")).toThrow();

      const vm = relay.rewriteJoinResponse(
        "/api/bots/bot-1/local-computer/join", vmJoin, "device-1", "phone-lease-0123456789",
      ) as { joinUrl: string };
      expect(vm.joinUrl).toMatch(/^\/vps-viewer\/[A-Za-z0-9_-]{32}\/vnc\.html#/);
      expect(vm.joinUrl).not.toContain("127.0.0.1");
      const sessionPath = vm.joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(asked).toEqual([]);

      const device = { id: "device-1", cloudDesktopAccess: true };
      const sidecar = createServer();
      sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, device));
      servers.push(sidecar);
      const sidecarPort = await listen(sidecar);
      const { client, response } = await openViewer(sidecarPort, `${sessionPath}/websockify`, "viewer-ready");
      expect(response).toContain("101 Switching Protocols");
      expect(asked).toEqual(["device-1/bot-1/phone-lease-0123456789"]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(asked).toHaveLength(2);
      expect(client.destroyed).toBe(false);

      owned = false;
      const closed = once(client, "close");
      await vi.advanceTimersByTimeAsync(1_000);
      await closed;
      expect(asked).toHaveLength(3);
      // The session is gone: even a well-formed request for it is not found.
      expect((await openViewer(sidecarPort, `${sessionPath}/websockify`)).response).toContain("404 Not Found");
    } finally {
      vi.useRealTimers();
    }
  });

  /** A Local VM viewer behind the relay, asking `checkControl` about its lease; `upgrades` are the desktop's sockets and
   * `received` what reached it. The desktop answers once `answer` is called, or at once without `held`. */
  const localVmViewer = async (checkControl: ControlCheck, { held = false } = {}) => {
    const upgrades: Duplex[] = [];
    let received = "";
    let answer = () => {};
    const viewer = createServer();
    viewer.on("upgrade", (_req, socket) => {
      upgrades.push(socket);
      sockets.push(socket);
      socket.on("error", () => {});
      socket.on("end", () => socket.end());
      socket.on("data", (chunk) => { received += chunk; });
      answer = () => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nviewer-ready");
      if (!held) answer();
    });
    servers.push(viewer);
    const relay = new CompanionViewerRelay({ checkIntervalMs: 1_000, checkControl });
    const vm = relay.rewriteJoinResponse(
      "/api/bots/bot-1/local-computer/join",
      { joinUrl: `http://127.0.0.1:${await listen(viewer)}/vnc.html#password=vm-secret` },
      "device-1",
      "phone-lease-0123456789",
    ) as { joinUrl: string };
    const path = `${vm.joinUrl.split("#")[0].replace(/\/vnc\.html$/, "")}/websockify`;
    const device = { id: "device-1", cloudDesktopAccess: true };
    const sidecar = createServer();
    sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, device));
    servers.push(sidecar);
    const port = await listen(sidecar);
    /** Opens the viewer, and once the desktop answers, hangs up and waits until the desktop's socket has closed too. */
    const visit = async () => {
      const { client, response } = await openViewer(port, path, "viewer-ready");
      expect(response).toContain("101 Switching Protocols");
      const closed = once(upgrades.at(-1)!, "close");
      client.destroy();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    return { relay, path, port, upgrades, visit, received: () => received, answer: () => answer() };
  };
  const upgradeRequest = (path: string) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + "Sec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n";

  it("refuses a reconnect to a Local VM viewer whose lease has let go, before reaching the desktop", async () => {
    let owned = true;
    const vm = await localVmViewer(async () => owned);
    await vm.visit();
    owned = false;
    expect((await openViewer(vm.port, vm.path)).response).toContain("404 Not Found");
    owned = true;
    expect((await openViewer(vm.port, vm.path)).response).toContain("404 Not Found");
    expect(vm.upgrades).toHaveLength(1);
  });

  it("refuses a reconnect whose lease check fails", async () => {
    let checks = 0;
    const vm = await localVmViewer(async () => {
      if (checks++) throw new Error("the harness did not answer");
      return true;
    });
    await vm.visit();
    expect((await openViewer(vm.port, vm.path)).response).toContain("404 Not Found");
    expect(vm.upgrades).toHaveLength(1);
  });

  it("refuses a viewer ended while its lease check was on its way, even when the lease still holds", async () => {
    const answers: Array<(owned: boolean) => void> = [];
    const vm = await localVmViewer(() => new Promise((resolve) => answers.push(resolve)));
    const opened = openViewer(vm.port, vm.path);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    vm.relay.close("device-1", "bot-1");
    answers[0]!(true);
    expect((await opened).response).toContain("404 Not Found");
    expect(vm.upgrades).toHaveLength(0);
  });

  it("never reaches the desktop for a phone that hung up while its lease check was on its way, and stops checking", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const answers: Array<(owned: boolean) => void> = [];
      const vm = await localVmViewer(() => new Promise((resolve) => answers.push(resolve)));
      const client = createConnection({ host: "127.0.0.1", port: vm.port });
      sockets.push(client);
      client.on("error", () => {});
      client.write(upgradeRequest(vm.path));
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      const closed = once(client, "close");
      client.destroy();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      answers[0]!(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(vm.upgrades).toHaveLength(0);
      expect(answers).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reaches the desktop for a relayed phone stream that ended while its lease check was on its way", async () => {
    const answers: Array<(owned: boolean) => void> = [];
    const vm = await localVmViewer(() => new Promise((resolve) => answers.push(resolve)));
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const request = { url: vm.path, method: "GET", headers: { upgrade: "websocket", "sec-websocket-key": "dGVzdA==", "sec-websocket-version": "13" } };
    vm.relay.handleUpgrade(request as unknown as IncomingMessage, stream, Buffer.alloc(0), { id: "device-1", cloudDesktopAccess: true });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    stream.push(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    answers[0]!(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vm.upgrades).toHaveLength(0);
    expect(stream.destroyed).toBe(true);
  });

  it("delivers what the phone sent during its lease check and before the desktop answered, first and in order", async () => {
    const answers: Array<(owned: boolean) => void> = [];
    const vm = await localVmViewer(() => new Promise((resolve) => answers.push(resolve)), { held: true });
    const client = createConnection({ host: "127.0.0.1", port: vm.port });
    sockets.push(client);
    client.on("error", () => {});
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => { response += chunk; });
    client.write(`${upgradeRequest(vm.path)}one,`);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    client.write("two,");
    await new Promise((resolve) => setTimeout(resolve, 50));
    answers[0]!(true);
    await vi.waitFor(() => expect(vm.upgrades).toHaveLength(1));
    client.write("three,");
    await new Promise((resolve) => setTimeout(resolve, 50));
    vm.answer();
    await vi.waitFor(() => expect(response).toContain("viewer-ready"));
    client.write("four");
    await vi.waitFor(() => expect(vm.received()).toBe("one,two,three,four"));
  });

  it("pins HTTP and WebSocket traffic to the session, device, and loopback viewer", async () => {
    let upgradedPath = "";
    const viewer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`asset:${req.url}`);
    });
    viewer.on("upgrade", (req, socket) => {
      sockets.push(socket);
      upgradedPath = req.url ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: test\r\n\r\n"
          + "viewer-ready",
      );
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new CompanionViewerRelay();
    const rewritten = relay.rewriteJoinResponse(
      "/api/bots/bot-1/computer/join",
      { joinUrl: `http://127.0.0.1:${viewerPort}/vnc.html#password=viewer-secret` },
      "device-1",
    ) as { joinUrl: string };
    const sessionPath = rewritten.joinUrl.split("#")[0];
    const sessionId = sessionPath.split("/")[2];
    const device = { id: "device-1", cloudDesktopAccess: true };

    const sidecar = createServer((req, res) => relay.handleHttp(req, res, device));
    sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, device));
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    const asset = await fetch(`http://127.0.0.1:${sidecarPort}${sessionPath}`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("asset:/vnc.html");

    const wrongDevice = createServer((req, res) =>
      relay.handleHttp(req, res, { id: "device-2", cloudDesktopAccess: true }));
    servers.push(wrongDevice);
    const wrongPort = await listen(wrongDevice);
    expect((await fetch(`http://127.0.0.1:${wrongPort}${sessionPath}`)).status).toBe(404);

    let clientSocket: Socket | null = null;
    const received = await new Promise<string>((resolve, reject) => {
      clientSocket = createConnection({ host: "127.0.0.1", port: sidecarPort });
      sockets.push(clientSocket);
      let text = "";
      clientSocket.setEncoding("utf8");
      clientSocket.once("connect", () => clientSocket?.write(
        `GET /vps-viewer/${sessionId}/websockify HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${sidecarPort}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGVzdA==\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
      ));
      clientSocket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("viewer-ready")) resolve(text);
      });
      clientSocket.once("error", reject);
      clientSocket.setTimeout(2_000, () => reject(new Error("viewer WebSocket timed out")));
    });
    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("viewer-ready");
    expect(upgradedPath).toBe("/websockify");

    const closed = new Promise<void>((resolve) => clientSocket?.once("close", () => resolve()));
    relay.closeDevice("device-1");
    await expect(Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("viewer WebSocket stayed open")), 2_000)),
    ])).resolves.toBeUndefined();
  });

  it("refuses viewer request targets that are not URLs", async () => {
    const relay = new CompanionViewerRelay();
    const rewritten = relay.rewriteJoinResponse(
      "/api/bots/bot-1/computer/join",
      { joinUrl: "http://127.0.0.1:45678/vnc.html" },
      "device-1",
    ) as { joinUrl: string };
    const sessionPath = rewritten.joinUrl.split("#")[0].replace(/\/vnc\.html$/, "");
    const device = { id: "device-1", cloudDesktopAccess: true };
    expect(relay.isViewerPath("//[")).toBe(false);

    const sidecar = createServer((req, res) => relay.handleHttp(req, res, device));
    sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head, device));
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);
    expect((await fetch(`http://127.0.0.1:${sidecarPort}${sessionPath}//[`)).status).toBe(404);

    const { response } = await openViewer(sidecarPort, `${sessionPath}//[`);
    expect(response).toMatch(/^HTTP\/1\.1 404 /);
  });

  it("survives a reset on either end of a viewer WebSocket and closes the other end", async () => {
    for (const reset of ["phone", "viewer"] as const) {
      const { relay, sessionPath, sidecarPort, upstream } = await viewerFixture();
      const { client } = await openViewer(sidecarPort, `${sessionPath}/websockify`, "viewer-ready");
      const viewerSocket = await upstream;
      const survivor = reset === "phone" ? viewerSocket : client;
      // The viewer's server socket is half-open by default: its peer going away shows as `end`.
      const closed = Promise.race([once(survivor, "end"), once(survivor, "close")]);
      (reset === "phone" ? client : viewerSocket as Socket).resetAndDestroy();
      await expect(Promise.race([
        closed,
        new Promise((_, fail) => setTimeout(() => fail(new Error(`${reset} reset left the other end open`)), 2_000)),
      ])).resolves.toBeDefined();
      relay.closeAll();
    }
  });

  it("closes every viewer WebSocket at shutdown so the listener can close", async () => {
    const { relay, sessionPath, sidecar, sidecarPort } = await viewerFixture();
    const { client } = await openViewer(sidecarPort, `${sessionPath}/websockify`, "viewer-ready");
    const pending = createConnection({ host: "127.0.0.1", port: sidecarPort });
    sockets.push(pending);
    pending.on("error", () => {});
    pending.write(
      "GET /vps-viewer/abcdefghijklmnopqrstuvwxyz012345/websockify HTTP/1.1\r\n"
        + "Host: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    await once(pending, "data");
    const clientClosed = once(client, "close");
    const listenerClosed = new Promise<void>((resolve) => {
      sidecar.closeAllConnections();
      relay.closeAll();
      sidecar.close(() => resolve());
    });
    servers.splice(servers.indexOf(sidecar), 1);
    await expect(Promise.race([
      Promise.all([listenerClosed, clientClosed]),
      new Promise((_, fail) => setTimeout(() => fail(new Error("a viewer WebSocket kept the listener open")), 2_000)),
    ])).resolves.toBeDefined();
  });

  it("closes a viewer removed while its upstream WebSocket handshake is pending", async () => {
    let handshakeStarted: (() => void) | undefined;
    const handshake = new Promise<void>((resolve) => {
      handshakeStarted = resolve;
    });
    const viewer = createServer();
    viewer.on("upgrade", (_req, socket) => {
      sockets.push(socket);
      handshakeStarted?.();
      // Deliberately leave the handshake unanswered until the device is
      // removed. A late 101 must never resurrect this session.
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new CompanionViewerRelay();
    const rewritten = relay.rewriteJoinResponse(
      "/api/bots/bot-1/computer/join",
      { joinUrl: `http://127.0.0.1:${viewerPort}/vnc.html` },
      "device-1",
    ) as { joinUrl: string };
    const sessionId = rewritten.joinUrl.split("/")[2];
    const sidecar = createServer();
    sidecar.on("upgrade", (req, socket, head) => relay.handleUpgrade(
      req,
      socket,
      head,
      { id: "device-1", cloudDesktopAccess: true },
    ));
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    const client = createConnection({ host: "127.0.0.1", port: sidecarPort });
    sockets.push(client);
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.once("connect", () => client.write(
      `GET /vps-viewer/${sessionId}/websockify HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${sidecarPort}\r\n`
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n"
        + "Sec-WebSocket-Key: dGVzdA==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
    ));
    await handshake;
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    relay.closeDevice("device-1");
    await expect(Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("pending viewer stayed open")), 2_000)),
    ])).resolves.toBeUndefined();
    expect(response).not.toContain("101 Switching Protocols");
  });
});
