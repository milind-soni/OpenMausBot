// OpenMausBot's own MCP servers (agents, browser, computer, data, HighLevel) over MCP's Streamable HTTP transport, JSON
// responses only, for engines that reach MCP servers by URL: one endpoint in this process instead of a stdio proxy
// process per server in every session. The turn's capability rides the Authorization header, and the endpoints behind
// these answers check it, as they check the stdio proxies'.
import type { IncomingHttpHeaders } from "node:http";

import { agentsMcp } from "../drivers/agents-mcp.ts";
import { AGENTS_MCP_ENV } from "../drivers/agents-mcp-env.ts";
import type { Json } from "../drivers/agents-client.ts";
import { harnessMcpRequest, MAX_INPUT_BYTES, parseHarnessMcpKind } from "../harness-mcp-request.ts";
import { parseToolLimit, TOOL_LIMIT_HEADER } from "../tool-count-limit.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

import { AGENTS_ENV_HEADER, OWN_MCP_HTTP_PATH } from "./own-mcp-http-path.ts";

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

export async function ownMcpHttpRoutes({ req, res, path, method, json, readBody }: RouteContext): ReturnType<RouteHandler> {
  if (!path.startsWith(OWN_MCP_HTTP_PATH)) return PASS;
  const name = path.slice(OWN_MCP_HTTP_PATH.length);
  const kind = name === "agents" ? "agents" : parseHarnessMcpKind(name);
  if (!kind) return json(res, 404, { error: "no such MCP server" });
  // No server-sent stream and no session to end: a client falls back to plain request and response.
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
  const frames: Json[] = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(frames.map(async (frame) => {
    const reply = await answer(frame) as { result?: { protocolVersion?: unknown } } | undefined;
    // The version the client asked for: these servers answer the same way in every version.
    const asked = (frame?.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (frame?.method === "initialize" && typeof asked === "string" && reply?.result) reply.result.protocolVersion = asked;
    return reply;
  }))).filter((reply) => reply !== undefined);
  if (!replies.length) {
    res.writeHead(202);
    res.end();
    return;
  }
  json(res, 200, Array.isArray(body) ? replies : replies[0]);
}
