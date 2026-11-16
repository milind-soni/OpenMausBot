import {
  GROK_LINK_BODY_MAX,
  GROK_LINK_PING,
  GROK_LINK_PONG,
  GROK_LINK_SECRET_HEADER,
  isLinkSecret,
  linkKey,
  type LinkManifest,
} from "../../../shared/grok-link";
import { DAY_MS, json, readBoundedBody, sha256 } from "./common";
import { LinkRelay } from "./grok-link-relay";

const IDLE_DAYS = 30;
/** Workers Free allows 50 subrequests a request: the hourly run purges at most this many objects. */
const SWEEP_BATCH = 20;
const MANIFEST = "manifest";

/** Security: the key in a link's address is all a caller needs, so it never reaches a log. */
export const redactPath = (pathname: string) => pathname.replace(/^\/mcp\/move\/.*/, "/mcp/move/[key]");

const object = (env: Env, keyHash: string) => env.GROK_LINK.get(env.GROK_LINK.idFromName(keyHash));
const purge = (env: Env, keyHash: string) => object(env, keyHash).fetch("https://grok-link/purge", { method: "POST" });

/** POST /mcp/move/<key>, public: Grok Bot's MCP call. The object is reached only for a link that is on, so an
 *  unknown key creates nothing. */
export async function grokLinkCall(request: Request, key: string, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "content-type must be application/json" }, 415);
  }
  const keyHash = await sha256(key);
  if (!(await env.LINK_LIMITER.limit({ key: keyHash })).success) return json({ error: "too many requests" }, 429, { "retry-after": "60" });
  if (!await env.DB.prepare("SELECT 1 FROM grok_links WHERE key_hash = ?").bind(keyHash).first()) return json({ error: "not found" }, 404);
  // Workers Free allows 10 ms of CPU a request here, so the body is counted and handed on unparsed.
  const body = await readBoundedBody(request, GROK_LINK_BODY_MAX);
  if (!body) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "The request is larger than 4 MB. Split the Bot into several documents with the same bot name and send each one with send_export." } }, 413);
  }
  return object(env, keyHash).fetch("https://grok-link/call", { method: "POST", body });
}

/** /v1/grok-link, public: the secret in its header is the credential. GET with Upgrade attaches the desktop's socket,
 *  making the link's row when there is none; DELETE turns the link off. */
export async function grokLinkRoute(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get(GROK_LINK_SECRET_HEADER);
  if (!isLinkSecret(secret)) return json({ error: "unauthorized" }, 401);
  const keyHash = await sha256(await linkKey(secret));
  if (request.method === "DELETE") {
    const gone = await env.DB.prepare("DELETE FROM grok_links WHERE key_hash = ?").bind(keyHash).run();
    if (gone.meta.changes) await purge(env, keyHash);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "method not allowed" }, 405, { allow: "GET, DELETE" });
  }
  const now = Date.now();
  const kept = await env.DB.prepare("UPDATE grok_links SET attached_at = ? WHERE key_hash = ?").bind(now, keyHash).run();
  if (!kept.meta.changes) {
    if (env.REGISTRATION_MODE !== "open") return json({ error: "registration is temporarily closed" }, 503);
    const fingerprint = `${request.headers.get("cf-connecting-ip") ?? "unknown"}|${request.headers.get("user-agent") ?? "unknown"}`;
    if (!(await env.REGISTRATION_LIMITER.limit({ key: await sha256(fingerprint.slice(0, 512)) })).success) {
      return json({ error: "too many new links" }, 429, { "retry-after": "60" });
    }
    await env.DB.prepare(
      "INSERT INTO grok_links (key_hash, created_at, attached_at) VALUES (?, ?, ?) ON CONFLICT (key_hash) DO UPDATE SET attached_at = excluded.attached_at",
    ).bind(keyHash, now, now).run();
    console.log(JSON.stringify({ message: "grok link made" }));
  }
  // Security: the object never sees the secret.
  return object(env, keyHash).fetch("https://grok-link/attach", { headers: { upgrade: "websocket" } });
}

/** Hourly: a link no desktop attached to for 30 days goes, and its object with it. A desktop still attached is closed,
 *  attaches again and gets the same row and address back. */
export async function sweepGrokLinks(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "DELETE FROM grok_links WHERE key_hash IN (SELECT key_hash FROM grok_links WHERE attached_at < ? ORDER BY attached_at LIMIT ?) RETURNING key_hash",
  ).bind(now - IDLE_DAYS * DAY_MS, SWEEP_BATCH).all<{ key_hash: string }>();
  await Promise.all(results.map((row) => purge(env, row.key_hash)));
}

const OPEN = 1;

/** One link's Durable Object: the Workers side of LinkRelay. A plain class, with no `cloudflare:workers` import, so
 *  the Node test harness can load this file. Its sockets hibernate: an idle link bills nothing. */
export class GrokLinkObject {
  private readonly relay: LinkRelay;

  constructor(private readonly ctx: DurableObjectState) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(GROK_LINK_PING, GROK_LINK_PONG));
    this.relay = new LinkRelay({
      read: async () => await ctx.storage.get<LinkManifest>(MANIFEST) ?? null,
      write: (manifest) => ctx.storage.put(MANIFEST, manifest),
      clear: () => ctx.storage.deleteAll(),
    }, () => ctx.getWebSockets().filter((socket) => socket.readyState === OPEN));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/call") return this.relay.call(await request.text());
    if (pathname === "/purge") {
      await this.relay.purge();
      return new Response(null, { status: 204 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.relay.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.relay.received(socket, typeof message === "string" ? message : "");
  }

  webSocketClose(socket: WebSocket): void {
    this.relay.closed(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.relay.closed(socket);
  }
}
