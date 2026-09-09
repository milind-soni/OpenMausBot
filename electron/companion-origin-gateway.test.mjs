import { EventEmitter } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupCompanionOriginEndpoint,
  companionOriginHealth,
  createCompanionOriginEndpoint,
  createCompanionOriginGateway,
  validCompanionOriginTarget,
} from "./companion-origin-gateway.mjs";

const allocations = [];
const servers = [];
const sockets = [];

const listen = (server, options) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });

const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

function endpoint() {
  const allocated = createCompanionOriginEndpoint();
  allocations.push(allocated);
  return allocated;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    if (server.listening) await close(server);
  }
  for (const allocated of allocations.splice(0)) cleanupCompanionOriginEndpoint(allocated);
});

describe("managed Companion origin endpoint", () => {
  it("allocates a private generation-specific UDS or named pipe", () => {
    const first = endpoint();
    const second = endpoint();
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(validCompanionOriginTarget(first)).toBe(true);
    expect(validCompanionOriginTarget({ pid: process.pid, socketPath: "http://127.0.0.1:8810" })).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(first.directory).mode & 0o777).toBe(0o700);
      expect(path.dirname(first.socketPath)).toBe(first.directory);
      expect(path.dirname(first.directory)).toBe(fs.realpathSync("/tmp"));
    }
  });

  it("cleans only the exact endpoint it allocated", () => {
    const allocated = endpoint();
    if (process.platform === "win32") return;
    const foreign = path.join(allocated.directory, "keep-me");
    fs.writeFileSync(foreign, "safe");
    cleanupCompanionOriginEndpoint(allocated);
    expect(fs.readFileSync(foreign, "utf8")).toBe("safe");
    fs.unlinkSync(foreign);
  });

  it("settles an origin health probe when its request times out or closes", async () => {
    const probe = (terminalEvent) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = () => {};
      outgoing.end = () => queueMicrotask(() => outgoing.emit(terminalEvent));
      return companionOriginHealth(
        { socketPath: "/unused/private-origin.sock" },
        { request: () => outgoing, timeoutMs: 10 },
      );
    };

    await expect(probe("timeout")).resolves.toBe(false);
    await expect(probe("close")).resolves.toBe(false);
  });

  it("accepts the exact identity from a healthy private origin", async () => {
    const allocated = endpoint();
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ app: "openmausbot" }));
    });
    servers.push(target);
    await listen(target, allocated.socketPath);

    await expect(companionOriginHealth(allocated)).resolves.toBe(true);
  });
});

describe("managed Companion loopback gateway", () => {
  it("forwards only to the closed-over private socket and strips hop-by-hop headers", async () => {
    const allocated = endpoint();
    const target = createHttpServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "application/json",
          connection: "x-private-hop",
          "x-private-hop": "remove-me",
        });
        response.end(JSON.stringify({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
          path: request.url,
          privateHop: request.headers["x-private-hop"],
        }));
      });
    });
    servers.push(target);
    await listen(target, allocated.socketPath);

    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
    });
    const address = await gateway.start();
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/echo?one=1",
        method: "POST",
        headers: {
          authorization: "Bearer paired-device",
          connection: "x-private-hop",
          "content-length": 7,
          "x-private-hop": "remove-me",
        },
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolve({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          headers: incoming.headers,
        }));
      });
      outgoing.once("error", reject);
      outgoing.end("payload");
    });
    expect(response.body).toEqual({
      authorization: "Bearer paired-device",
      body: "payload",
      path: "/echo?one=1",
    });
    expect(response.headers["x-private-hop"]).toBeUndefined();
    await gateway.close();
  });

  it("carries an authenticated viewer WebSocket to the private companion origin", async () => {
    const allocated = endpoint();
    let received = null;
    const target = createHttpServer();
    target.on("upgrade", (request, socket) => {
      sockets.push(socket);
      received = {
        authorization: request.headers.authorization,
        path: request.url,
        upgrade: request.headers.upgrade,
      };
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: test\r\n\r\n"
          + "private-origin-ready",
      );
    });
    servers.push(target);
    await listen(target, allocated.socketPath);

    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
    });
    const address = await gateway.start();
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      sockets.push(socket);
      let text = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(
        "GET /vps-viewer/session/websockify HTTP/1.1\r\n"
          + `Host: 127.0.0.1:${address.port}\r\n`
          + "Authorization: Bearer paired-device\r\n"
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGVzdA==\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
      ));
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("private-origin-ready")) resolve(text);
      });
      socket.once("error", reject);
      socket.setTimeout(2_000, () => reject(new Error("managed viewer WebSocket timed out")));
    });

    expect(response).toContain("101 Switching Protocols");
    expect(received).toEqual({
      authorization: "Bearer paired-device",
      path: "/vps-viewer/session/websockify",
      upgrade: "websocket",
    });
    await gateway.close();
  });

  it("invalidates a viewer socket while its upstream upgrade is still pending", async () => {
    const allocated = endpoint();
    let receivedUpgrade;
    const receivedUpgradePromise = new Promise((resolve) => {
      receivedUpgrade = resolve;
    });
    const target = createHttpServer();
    target.on("upgrade", (_request, socket) => {
      sockets.push(socket);
      receivedUpgrade();
    });
    servers.push(target);
    await listen(target, allocated.socketPath);

    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
      upstreamTimeoutMs: 2_000,
    });
    const address = await gateway.start();
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    sockets.push(socket);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.once("connect", () => socket.write(
      "GET /vps-viewer/session/websockify HTTP/1.1\r\n"
        + `Host: 127.0.0.1:${address.port}\r\n`
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n"
        + "Sec-WebSocket-Key: dGVzdA==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
    ));
    await receivedUpgradePromise;

    gateway.invalidate();
    await expect(Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("pending viewer socket stayed open")), 2_000)),
    ])).resolves.not.toBe("timeout");
    await gateway.close();
  });

  it("fails closed when the exact sidecar pid is no longer alive", async () => {
    const allocated = endpoint();
    const target = createHttpServer((_request, response) => response.end("must not be reached"));
    servers.push(target);
    await listen(target, allocated.socketPath);
    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
      isTargetAlive: () => false,
    });
    const address = await gateway.start();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(response.status).toBe(503);
    await gateway.close();
  });

  it("invalidates live traffic while retaining its loopback port until close", async () => {
    const allocated = endpoint();
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
    });
    servers.push(target);
    await listen(target, allocated.socketPath);
    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
    });
    const address = await gateway.start();
    const streaming = await fetch(`http://127.0.0.1:${address.port}/api/events`);
    expect(await streaming.body.getReader().read()).toMatchObject({ done: false });

    gateway.invalidate();
    const unavailable = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(unavailable.status).toBe(503);

    const competitor = createHttpServer();
    servers.push(competitor);
    await expect(listen(competitor, { host: "127.0.0.1", port: address.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });

    await gateway.close();
    const rebound = await listen(competitor, { host: "127.0.0.1", port: address.port });
    expect(rebound.port).toBe(address.port);
  });

  it("ends downstream traffic when the private origin closes mid-response", async () => {
    const allocated = endpoint();
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-length": "100000",
        "content-type": "application/octet-stream",
      });
      response.write(Buffer.alloc(1000, 1));
      setTimeout(() => response.socket?.destroy(), 20);
    });
    servers.push(target);
    await listen(target, allocated.socketPath);

    const gateway = createCompanionOriginGateway({
      target: { pid: process.pid, socketPath: allocated.socketPath },
      originPort: 0,
    });
    const address = await gateway.start();
    const outcome = await Promise.race([
      new Promise((resolve) => {
        const outgoing = httpRequest({ host: "127.0.0.1", port: address.port }, (incoming) => {
          incoming.resume();
          incoming.once("aborted", () => resolve("aborted"));
          incoming.once("error", () => resolve("error"));
          incoming.once("end", () => resolve("ended"));
          incoming.once("close", () => resolve("closed"));
        });
        outgoing.once("error", () => resolve("request-error"));
        outgoing.end();
      }),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);

    expect(outcome).not.toBe("hung");
    await gateway.close();
  });
});
