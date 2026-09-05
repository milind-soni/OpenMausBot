import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface ViewerDevice {
  id?: string;
  cloudDesktopAccess: boolean;
}

interface ViewerSession {
  id: string;
  botId: string;
  deviceId: string;
  origin: string;
  expiresAt: number;
  sockets: Set<{ destroy(): void }>;
}

const VIEWER_PATH = /^\/vps-viewer\/([A-Za-z0-9_-]{32})(\/.*)?$/;
const BOT_JOIN_PATH = /^\/api\/bots\/([\w-]+)\/computer\/join$/;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 64;

function safeLoopbackViewer(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
    || url.pathname !== "/vnc.html"
    || url.search
    || !Number.isSafeInteger(port)
    || port < 1024
    || port > 65_535
  ) {
    return null;
  }
  return url;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(text),
    "content-type": "application/json",
  });
  res.end(text);
}

function socketError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found"}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function websocketHeaders(req: IncomingMessage): Record<string, string> | null {
  if (req.method !== "GET" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  const headers: Record<string, string> = { connection: "Upgrade", upgrade: "websocket" };
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function acceptUpgrade(socket: Duplex, response: IncomingMessage): void {
  const headers: string[] = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") headers.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`
      + `${headers.join("\r\n")}\r\n\r\n`,
  );
}

export class CompanionViewerRelay {
  readonly #sessions = new Map<string, ViewerSession>();

  #prune(): void {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= now) this.#remove(session);
    }
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.values().next().value as ViewerSession | undefined;
      if (!oldest) break;
      this.#remove(oldest);
    }
  }

  #remove(session: ViewerSession): void {
    this.#sessions.delete(session.id);
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  }

  #isActive(session: ViewerSession): boolean {
    return this.#sessions.get(session.id) === session;
  }

  close(deviceId: string, botId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.deviceId === deviceId && session.botId === botId) this.#remove(session);
    }
  }

  closeDevice(deviceId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.deviceId === deviceId) this.#remove(session);
    }
  }

  rewriteJoinResponse(path: string, value: unknown, deviceId?: string): unknown {
    const botId = BOT_JOIN_PATH.exec(path)?.[1];
    if (!botId || !value || typeof value !== "object" || Array.isArray(value)) return value;
    const body = value as Record<string, unknown>;
    const viewer = safeLoopbackViewer(body.joinUrl);
    if (!viewer) return value;
    if (!deviceId) throw new Error("the paired device has no viewer identity");

    this.#prune();
    this.close(deviceId, botId);
    const id = randomBytes(24).toString("base64url");
    this.#sessions.set(id, {
      id,
      botId,
      deviceId,
      origin: viewer.origin,
      expiresAt: Date.now() + SESSION_TTL_MS,
      sockets: new Set(),
    });

    const settings = new URLSearchParams(viewer.hash.slice(1));
    settings.set("path", `vps-viewer/${id}/websockify`);
    return {
      ...body,
      joinUrl: `/vps-viewer/${id}${viewer.pathname}#${settings.toString()}`,
    };
  }

  #target(rawUrl: string | undefined, device: ViewerDevice | null): { session: ViewerSession; target: URL } | null {
    this.#prune();
    if (!device?.id || !device.cloudDesktopAccess) return null;
    const incoming = new URL(rawUrl ?? "/", "http://companion.invalid");
    const match = VIEWER_PATH.exec(incoming.pathname);
    if (!match) return null;
    const session = this.#sessions.get(match[1]);
    if (!session || session.deviceId !== device.id || session.expiresAt <= Date.now()) return null;
    const suffix = match[2] || "/";
    const target = new URL(`${suffix}${incoming.search}`, session.origin);
    if (target.origin !== session.origin) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { session, target };
  }

  isViewerPath(rawUrl: string | undefined): boolean {
    const pathname = new URL(rawUrl ?? "/", "http://companion.invalid").pathname;
    return pathname.startsWith("/vps-viewer/");
  }

  handleHttp(req: IncomingMessage, res: ServerResponse, device: ViewerDevice | null): void {
    const resolved = this.#target(req.url, device);
    if (!device) return sendJson(res, 401, { error: "pair this device first" });
    if (!device.cloudDesktopAccess) return sendJson(res, 403, { error: "cloud desktop access is off for this device" });
    if (!resolved || req.method !== "GET") return sendJson(res, 404, { error: "viewer session not found" });

    const headers: Record<string, string> = { accept: String(req.headers.accept ?? "*/*") };
    for (const name of ["range", "if-none-match", "if-modified-since"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = httpRequest(resolved.target, { method: "GET", headers }, (remote) => {
      upstream.setTimeout(0);
      const responseHeaders: Record<string, string | string[]> = {
        "cache-control": "private, no-store",
      };
      for (const name of [
        "content-type",
        "content-length",
        "content-encoding",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const value = remote.headers[name];
        if (value !== undefined) responseHeaders[name] = value;
      }
      res.writeHead(remote.statusCode ?? 502, responseHeaders);
      remote.once("error", () => res.destroy());
      remote.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("viewer did not answer")));
    upstream.once("error", () => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 502, { error: "the VPS viewer did not answer" });
    });
    res.once("close", () => upstream.destroy());
    upstream.end();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, device: ViewerDevice | null): void {
    if (!device) return socketError(socket, 401, "pair this device first");
    if (!device.cloudDesktopAccess) return socketError(socket, 403, "cloud desktop access is off for this device");
    const resolved = this.#target(req.url, device);
    const headers = websocketHeaders(req);
    if (!resolved || !headers) return socketError(socket, 404, "viewer session not found");

    const upstream = httpRequest(resolved.target, { method: "GET", headers });
    resolved.session.sockets.add(socket);
    resolved.session.sockets.add(upstream);
    socket.once("close", () => resolved.session.sockets.delete(socket));
    upstream.once("close", () => resolved.session.sockets.delete(upstream));
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("viewer upgrade timed out")));
    upstream.once("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(0);
      if (!this.#isActive(resolved.session) || socket.destroyed) {
        remote.destroy();
        socket.destroy();
        return;
      }
      resolved.session.sockets.delete(upstream);
      acceptUpgrade(socket, response);
      resolved.session.sockets.add(remote);
      const release = () => {
        resolved.session.sockets.delete(socket);
        resolved.session.sockets.delete(remote);
      };
      socket.once("close", release);
      remote.once("close", release);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (response) => {
      response.resume();
      socketError(socket, 404, "viewer WebSocket was refused");
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  }
}
