import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import type { RelayConfig } from "./config.ts";
import type { Context } from "./context.ts";
import { handleControl, handleData, HostBudgets, Hosts } from "./hosts.ts";
import { clientKey, IpLimiter } from "./limits.ts";
import { jsonLogger, type Logger } from "./log.ts";
import { bearerMatches, Metrics } from "./metrics.ts";
import { handlePhone } from "./phone.ts";
import { closeWith, Heartbeat, sendJson } from "./socket.ts";
import { Close, SUBPROTOCOL } from "./wire.ts";

type Route = "host" | "data" | "phone";

const ROUTES: Record<string, Route> = { "/v1/host": "host", "/v1/host/data": "data", "/v1/phone": "phone" };
const HANDLERS: Record<Route, (ctx: Context, ws: WebSocket) => void> = { host: handleControl, data: handleData, phone: handlePhone };
const SWEEP_MS = 60_000;
/** TCP connections Node accepts beyond the socket cap, so a refusal with a close code can still be delivered. */
const CONNECTION_HEADROOM = 1_024;

export interface Relay {
  port: number;
  ctx: Context;
  /** Sockets the relay holds, by route. */
  sockets: () => Map<WebSocket, Route>;
  /** SIGTERM: tell hosts the node is restarting, close phones with 4503, and resolve once every socket is gone. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

export interface RelayOptions {
  log?: Logger;
  now?: () => number;
  wallSeconds?: () => number;
}

function refuse(socket: Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function offersSubprotocol(header: string | undefined): boolean {
  return header !== undefined && header.split(",").some((value) => value.trim() === SUBPROTOCOL);
}

export async function startRelay(config: RelayConfig, options: RelayOptions = {}): Promise<Relay> {
  const { limits } = config;
  const now = options.now ?? (() => performance.now());
  const wallSeconds = options.wallSeconds ?? (() => Date.now() / 1000);
  const metrics = new Metrics(wallSeconds);
  const ctx = {
    node: config.node,
    limits,
    tokenKeys: config.tokenKeys,
    hosts: new Hosts(limits.admissionMax),
    budgets: new HostBudgets(limits.hostBytesPerDay, wallSeconds),
    metrics,
    log: options.log ?? jsonLogger(config.node),
    now,
    wallSeconds,
  } as Context;
  ctx.heartbeat = new Heartbeat(ctx);
  const ipLimiter = new IpLimiter(limits.ipNewPerMinute, limits.ipOpenMax, now);
  const sockets = new Map<WebSocket, Route>();
  let draining = false;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxPayloadBytes,
    perMessageDeflate: false,
    clientTracking: false,
    closeTimeout: limits.closeGraceMs,
    handleProtocols: () => SUBPROTOCOL,
  } as ConstructorParameters<typeof WebSocketServer>[0]);

  const gauges = () => {
    let pending = 0;
    for (const entry of ctx.hosts.all()) {
      for (const session of entry.sessions.values()) if (session.state === "pending") pending += 1;
    }
    return [
      { name: "relay_hosts_connected", help: "Hosts with a control socket on this node", value: ctx.hosts.connected },
      { name: "relay_sessions_pending", help: "Phones waiting for their host's data socket", value: pending },
      { name: "relay_sessions_spliced", help: "Phone sessions spliced to a host", value: ctx.hosts.spliced },
      { name: "relay_sockets_open", help: "WebSockets held, every route", value: sockets.size },
      { name: "relay_sockets_max", help: "WebSockets this node holds before answering 4503", value: limits.socketsMax },
      { name: "relay_ip_entries", help: "Client keys with limiter state", value: ipLimiter.size },
      { name: "relay_draining", help: "1 while the node is shutting down", value: draining ? 1 : 0 },
    ];
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(draining ? 503 : 200, { ...headers, "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: !draining, node: config.node }));
    }
    if (req.method === "GET" && req.url === "/metrics" && config.metricsToken) {
      if (!bearerMatches(req.headers.authorization, config.metricsToken)) {
        res.writeHead(401, { ...headers, "www-authenticate": "Bearer" });
        return void res.end();
      }
      res.writeHead(200, { ...headers, "content-type": "text/plain; version=0.0.4" });
      return void res.end(metrics.render(gauges()));
    }
    res.writeHead(404, headers);
    res.end();
  };

  // Node checks headersTimeout and requestTimeout only every connectionsCheckingInterval (30 s by default).
  const server = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 5_000,
    requestTimeout: 10_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  }, onRequest);
  server.maxConnections = limits.socketsMax + CONNECTION_HEADROOM;

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => {});
    const route = ROUTES[req.url ?? ""];
    if (!route) {
      metrics.inc("relay_refused_total", "path");
      return refuse(socket, 404, "Not Found");
    }
    if (req.headers.origin !== undefined) {
      metrics.inc("relay_refused_total", "origin");
      return refuse(socket, 403, "Forbidden");
    }
    if (!offersSubprotocol(req.headers["sec-websocket-protocol"])) {
      metrics.inc("relay_refused_total", "subprotocol");
      return refuse(socket, 400, "Bad Request");
    }
    const key = clientKey(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
    if (!key) {
      metrics.inc("relay_refused_total", "forwarded_for");
      return refuse(socket, 400, "Bad Request");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      if (draining) {
        metrics.inc("relay_refused_total", "draining");
        return closeWith(ctx, ws, Close.Unavailable, JSON.stringify({ retryInMs: limits.restartPhoneRetryMs }));
      }
      if (sockets.size >= limits.socketsMax) {
        metrics.inc("relay_refused_total", "full");
        return closeWith(ctx, ws, Close.Unavailable, JSON.stringify({ retryInMs: limits.fullRetryMs }));
      }
      const verdict = ipLimiter.admit(key);
      if (verdict !== "ok") {
        metrics.inc("relay_refused_total", `ip_${verdict}`);
        return closeWith(ctx, ws, Close.Limited);
      }
      metrics.inc("relay_upgrades_total", route);
      sockets.set(ws, route);
      metrics.peak("sockets_open", sockets.size);
      ws.once("close", () => {
        sockets.delete(ws);
        ipLimiter.release(key);
      });
      HANDLERS[route](ctx, ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  ctx.heartbeat.start();
  const sweeper = setInterval(() => {
    ipLimiter.sweep();
    ctx.budgets.sweep();
  }, SWEEP_MS);
  ctx.log({ ev: "start", port });

  const allClosed = (deadlineMs: number) =>
    new Promise<void>((resolve) => {
      const started = now();
      const poll = setInterval(() => {
        if (sockets.size > 0 && now() - started < deadlineMs) return;
        clearInterval(poll);
        for (const ws of sockets.keys()) ws.terminate();
        resolve();
      }, 50);
    });

  const drain = async () => {
    if (draining) return;
    draining = true;
    let sessions = 0;
    const hosts = ctx.hosts.connected;
    server.close();
    server.closeIdleConnections();
    const retry = JSON.stringify({ retryInMs: limits.restartPhoneRetryMs });
    for (const entry of ctx.hosts.all()) {
      for (const session of entry.sessions.values()) {
        sessions += 1;
        session.end(Close.Unavailable, retry);
      }
      if (entry.control) {
        sendJson(entry.control, { t: "restarting", reconnectInMs: limits.restartReconnectInMs, tryForMs: limits.restartTryForMs });
        closeWith(ctx, entry.control, 1001);
      }
    }
    for (const ws of sockets.keys()) closeWith(ctx, ws, Close.Unavailable, retry);
    ctx.log({ ev: "drain", hosts, sessions });
    await allClosed(Math.max(0, limits.shutdownMs - 1_000));
  };

  const close = async () => {
    clearInterval(sweeper);
    ctx.heartbeat.stop();
    for (const ws of sockets.keys()) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    metrics.close();
  };

  return { port, ctx, sockets: () => sockets, drain, close };
}
