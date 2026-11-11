import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

import { parseJson, type JsonValue } from "./schema.ts";
import type { WebhookManager } from "./webhooks.ts";
import { IDLE_HTTP_SERVER } from "./due-timer.ts";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const statusErrorSchema = z.object({ status: z.number().int().optional() });
const serverAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) });

export interface WebhookIngress {
  server: Server;
  /** The same receiver on a Unix socket (OMB_WEBHOOK_SOCKET), for a proxy in another container: the compose files' Caddy. */
  socketServer?: Server;
  host: string;
  port: number;
  baseUrl: string;
}

export function json(res: ServerResponse, status: number, body: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_WEBHOOK_BODY_BYTES) {
        throw Object.assign(new Error("Webhook body is too large"), { status: 413 });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    const parsed = statusErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.status === 413) throw error;
    throw Object.assign(new Error("Could not read webhook body"), { status: 400 });
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parsePayload(raw: string, contentType: string): JsonValue {
  if (!raw) return {};
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return parseJson(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON webhook body"), { status: 400 });
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function bearerSecret(req: IncomingMessage): string {
  const authorization = header(req, "authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || header(req, "x-openmaus-secret")?.trim() || "";
}

function deliveryId(req: IncomingMessage): string | undefined {
  return (
    header(req, "idempotency-key") ??
    header(req, "x-webhook-id") ??
    header(req, "x-github-delivery") ??
    header(req, "webhook-id")
  )?.trim() || undefined;
}

function eventName(req: IncomingMessage): string | undefined {
  return (
    header(req, "x-github-event") ??
    header(req, "x-webhook-event") ??
    header(req, "x-event-type") ??
    header(req, "ce-type")
  )?.trim() || undefined;
}

/** Another public door on this receiver (a bot's API): true when it answered the request. */
export type IngressDoor = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export function createWebhookIngressHandler(manager: WebhookManager, claimRequest?: () => () => void, door?: IngressDoor) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return json(res, 400, { error: "Invalid request URL" });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { app: "openmausbot-webhooks", ready: true });
    }
    if (door && await door(req, res, url)) return;
    const match = url.pathname.match(/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
    if (!match) return json(res, 404, { error: "Unknown webhook endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Webhooks accept POST requests" });

    let release: (() => void) | undefined;
    try {
      release = claimRequest?.();
      let secret = "";
      try {
        secret = (match[2] ? decodeURIComponent(match[2]) : "") || bearerSecret(req);
      } catch {
      }
      // Reject bad capability URLs before buffering or parsing attacker input.
      if (!manager.authorize(match[1], secret)) {
        manager.recordUnauthorized(match[1], {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
        return json(res, 401, { error: "Invalid webhook URL or secret" });
      }
      const raw = await readRawBody(req);
      const contentType = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
      const payload = parsePayload(raw, contentType);
      const result = await manager.receive(match[1], secret, {
        payload,
        contentType,
        eventName: eventName(req),
        userAgent: header(req, "user-agent"),
        deliveryId: deliveryId(req),
      });
      return json(res, 202, { accepted: true, ...result });
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 400 || status === 413) {
        manager.recordRejected(match[1], status, message, {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
      }
      return json(res, status, { error: message });
    } finally {
      release?.();
    }
  };
}

export function advertisedWebhookBase(raw: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(
      `webhook public base URL must be an absolute http(s) URL such as https://bots.example.com, got "${raw}"`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/** A TCP port on `host`, or a Unix socket's path when `host` is omitted. */
function listenOn(server: Server, where: number | string, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const listening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    if (typeof where === "number") server.listen(where, host, listening);
    else server.listen(where, listening);
  });
}

export async function listenWebhookIngress(
  manager: WebhookManager,
  options: { host?: string; port: number; socketPath?: string; publicBaseUrl?: string; claimRequest?: () => () => void; door?: IngressDoor },
): Promise<WebhookIngress> {
  const host = options.host ?? "127.0.0.1";
  const advertised = options.publicBaseUrl === undefined ? undefined : advertisedWebhookBase(options.publicBaseUrl);
  const handle = createWebhookIngressHandler(manager, options.claimRequest, options.door);
  const receive = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      console.error("webhooks: receiver failed", error);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: "Webhook receiver failed" });
    });
  };
  const server = createServer(IDLE_HTTP_SERVER, receive);
  await listenOn(server, options.port, host);
  const address = serverAddressSchema.safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("Webhook receiver did not get a TCP address");
  }
  let socketServer: Server | undefined;
  if (options.socketPath) {
    // A socket left by a server that stopped without closing it would refuse the listen.
    if (process.platform !== "win32") rmSync(options.socketPath, { force: true });
    socketServer = createServer(IDLE_HTTP_SERVER, receive);
    try {
      await listenOn(socketServer, options.socketPath);
    } catch (error) {
      server.close();
      throw error;
    }
  }
  return {
    server,
    ...(socketServer ? { socketServer } : {}),
    host,
    port: address.data.port,
    baseUrl: advertised ?? `http://${host}:${address.data.port}`,
  };
}

export function webhookCredential(baseUrl: string, endpointId: string, secret: string) {
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
  return {
    endpointUrl,
    secret,
    url: `${endpointUrl}/${encodeURIComponent(secret)}`,
  };
}
