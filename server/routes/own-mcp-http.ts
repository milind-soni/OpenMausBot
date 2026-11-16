// OpenMausBot's own MCP servers (agents, browser, computer, data, Email, phone) over MCP's Streamable HTTP transport, for
// engines that reach MCP servers by URL: one endpoint in this process instead of a stdio proxy process per server in
// every session. The turn's capability rides the Authorization header, and the endpoints behind these answers check it,
// as they check the stdio proxies'. Each capability gets the stdio proxy's limits: 16 requests in flight per server, and
// no more than its output cap in one answer.
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

import { agentsMcp } from "../drivers/agents-mcp.ts";
import { AGENTS_MCP_ENV } from "../drivers/agents-mcp-env.ts";
import type { Json } from "../drivers/agents-client.ts";
import { failure, harnessMcpRequest, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, parseHarnessMcpKind, type RpcId } from "../harness-mcp-request.ts";
import { parseToolLimit, TOOL_LIMIT_HEADER } from "../tool-count-limit.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

import { AGENTS_ENV_HEADER, OWN_MCP_HTTP_PATH } from "./own-mcp-http-path.ts";

/** As each stdio proxy allows (harness-mcp-proxy.ts). */
const MAX_PENDING = 16;
/** Well inside the 300 s an engine's HTTP client may wait between bytes, headers included (Node's fetch, undici). */
const KEEPALIVE_MS = 15_000;

function agentsEnv(headers: IncomingHttpHeaders, token: string, harness: string): NodeJS.ProcessEnv {
  let settings: Record<string, unknown> = {};
  try {
    const raw = headers[AGENTS_ENV_HEADER];
    const parsed = typeof raw === "string" ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {}
  const env: NodeJS.ProcessEnv = { OMB_HARNESS_URL: harness, OMB_COMMS_TOKEN: token };
  for (const key of AGENTS_MCP_ENV) if (typeof settings[key] === "string") env[key] = settings[key];
  return env;
}

type Frame = { id?: RpcId; method?: unknown; params?: unknown } | null;
const isRequest = (frame: Frame) => frame !== null && typeof frame === "object" && Object.hasOwn(frame, "id");

/** A tool call may run for minutes; a client that takes server-sent events gets its headers at once and a comment now and
 * then, so its HTTP client never gives up waiting. Everything else is answered as one JSON body. */
function streams(headers: IncomingHttpHeaders, frames: Frame[]): boolean {
  return /\btext\/event-stream\b/.test(headers.accept ?? "") && frames.some((frame) => isRequest(frame) && frame!.method === "tools/call");
}

export function createOwnMcpHttpRoutes(options: { keepaliveMs?: number; maxPending?: number; maxOutputBytes?: number } = {}): RouteHandler {
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const maxPending = options.maxPending ?? MAX_PENDING;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  /** Requests in flight per server and capability: a bot's turn, as one stdio proxy serves. */
  const pending = new Map<string, number>();

  return async function ownMcpHttpRoutes({ req, res, path, method, json, readBody }: RouteContext): ReturnType<RouteHandler> {
    if (!path.startsWith(OWN_MCP_HTTP_PATH)) return PASS;
    const name = path.slice(OWN_MCP_HTTP_PATH.length);
    const kind = name === "agents" ? "agents" : parseHarnessMcpKind(name);
    if (!kind) return json(res, 404, { error: "no such MCP server" });
    // No stream to open on its own and no session to end: a client falls back to request and response.
    if (method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return json(res, 401, { error: "unauthorized" });
    const body = await readBody(req, MAX_INPUT_BYTES);
    const harness = `http://127.0.0.1:${req.socket.localPort}/`;
    const answer: (frame: Json) => Promise<unknown> = kind === "agents"
      ? agentsMcp(agentsEnv(req.headers, token, harness.slice(0, -1)))
      : (frame) => harnessMcpRequest(frame, { url: harness, token, kind, toolLimit: parseToolLimit(req.headers[TOOL_LIMIT_HEADER]) });
    const frames: Frame[] = Array.isArray(body) ? body : [body as Frame];
    const key = `${kind}\0${token}`;

    const run = async (frame: Frame): Promise<unknown> => {
      const id = isRequest(frame) ? frame!.id ?? null : null;
      if ((pending.get(key) ?? 0) >= maxPending) return isRequest(frame) ? failure(id, frame!.method, `Too many pending ${kind} requests.`) : undefined;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      try {
        const reply = await answer(frame as Json) as { result?: { protocolVersion?: unknown } } | undefined;
        // The version the client asked for: these servers answer the same way in every version.
        const asked = (frame?.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        if (frame?.method === "initialize" && typeof asked === "string" && reply?.result) reply.result.protocolVersion = asked;
        return reply;
      } catch (error) {
        return isRequest(frame) ? failure(id, frame!.method, error instanceof Error ? error.message : String(error)) : undefined;
      } finally {
        const left = (pending.get(key) ?? 1) - 1;
        if (left > 0) pending.set(key, left); else pending.delete(key);
      }
    };
    // The stdio proxy's output cap, over the whole answer: a reply that would pass it becomes a failure the bot can read.
    let sent = 0;
    const capped = (frame: Frame, reply: unknown): unknown => {
      if (reply === undefined) return undefined;
      const size = Buffer.byteLength(JSON.stringify(reply));
      const kept = sent + size > maxOutputBytes
        ? failure(isRequest(frame) ? frame!.id ?? null : null, frame?.method, `The ${kind} answer exceeded the size limit.`) : reply;
      sent += kept === reply ? size : Buffer.byteLength(JSON.stringify(kept));
      return kept;
    };

    if (streams(req.headers, frames)) return stream(res, frames, run, capped, keepaliveMs);
    const replies = (await Promise.all(frames.map(async (frame) => capped(frame, await run(frame))))).filter((reply) => reply !== undefined);
    if (!replies.length) {
      res.writeHead(202);
      res.end();
      return;
    }
    json(res, 200, Array.isArray(body) ? replies : replies[0]);
  };
}

/** One server-sent event per reply as each finishes, with a comment line in between to keep the connection busy. */
async function stream(res: ServerResponse, frames: Frame[], run: (frame: Frame) => Promise<unknown>, capped: (frame: Frame, reply: unknown) => unknown, keepaliveMs: number): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
  res.flushHeaders();
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, keepaliveMs);
  res.on("close", () => clearInterval(keepalive));
  try {
    await Promise.all(frames.map(async (frame) => {
      const reply = capped(frame, await run(frame));
      if (reply !== undefined && !res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    }));
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}

export const ownMcpHttpRoutes = createOwnMcpHttpRoutes();
