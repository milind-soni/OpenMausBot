import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { CompanionViewerRelay } from "../src/viewer-relay.ts";

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
