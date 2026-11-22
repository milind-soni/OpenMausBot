// Talks to Composio only when EDUBOT_COMPOSIO_TEST_KEY is an ak_ key from an empty project. Otherwise it skips.
// A throw-away user, one no-auth toolkit, one read, then that user's accounts are deleted. Never Gmail or a real account.
import { expect, it } from "vitest";

import { isReadOnlyTool } from "../packages/phone-protocol/src/outbound.ts";
import type { AppConfig } from "./config.ts";
import { listToolkits, prepareProjectSession } from "./composio.ts";
import { apiBase, projectHeaders, removeUserConnections } from "./composio-project.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const KEY = process.env.EDUBOT_COMPOSIO_TEST_KEY?.trim() ?? "";
const live = KEY.startsWith("ak_");
const reason = "EDUBOT_COMPOSIO_TEST_KEY is not an ak_ key from an empty Composio project";
const PREFERRED = ["hackernews", "composio_search", "codeinterpreter", "composio"];
const KNOWN_READS: Record<string, string[]> = {
  hackernews: ["HACKERNEWS_GET_FRONTPAGE"],
  composio_search: ["COMPOSIO_SEARCH_WEB"],
  composio: ["COMPOSIO_SEARCH_WEB"],
};
const META = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
  "COMPOSIO_PROXY_EXECUTE",
  "COMPOSIO_CHECK_ACTIVE_CONNECTION",
  "COMPOSIO_INITIATE_CONNECTION",
]);
const ACCOUNT = /gmail|google|slack|outlook|notion/i;

const quiet = (text: string) => (KEY ? text.split(KEY).join("[key]") : text);

function slugsIn(value: unknown, into = new Set<string>()): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b[A-Z][A-Z0-9_]{6,}\b/g)) into.add(match[0]);
    if (value.startsWith("{") || value.startsWith("[")) {
      try { slugsIn(JSON.parse(value), into); } catch { /* the string was not JSON */ }
    }
    return [...into];
  }
  if (Array.isArray(value)) {
    for (const item of value) slugsIn(item, into);
    return [...into];
  }
  if (value && typeof value === "object") for (const item of Object.values(value)) slugsIn(item, into);
  return [...into];
}

function readable(toolkit: string, candidates: readonly string[]): string | null {
  const prefix = `${toolkit.toUpperCase()}_`;
  return candidates.find((slug) => slug.startsWith(prefix) && !META.has(slug) && !ACCOUNT.test(slug) && isReadOnlyTool(slug)) ?? null;
}

async function composio(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: projectHeaders(KEY, init.body !== undefined),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} HTTP ${response.status}: ${quiet(text).slice(0, 300)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function sessionMcp(url: string, method: string, params: unknown) {
  let session: string | undefined;
  const send = async (body: unknown) => {
    const headers = projectHeaders(KEY, true);
    headers.set("accept", "application/json, text/event-stream");
    if (session) headers.set("mcp-session-id", session);
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const next = response.headers.get("mcp-session-id");
    if (next) session = next;
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${quiet(text).slice(0, 300)}`);
    if (!text.trim()) return null;
    const frame = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim())).find((item) => item.id !== undefined)
      : JSON.parse(text);
    if (frame?.error) throw new Error(`${method}: ${quiet(JSON.stringify(frame.error)).slice(0, 300)}`);
    return frame as { result?: { tools?: Array<{ name?: string }>; isError?: boolean; content?: unknown } } | null;
  };
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "edubot-live", version: "1" } } });
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return send({ jsonrpc: "2.0", id: 3, method, params });
}

it.skipIf(!live)(
  live ? "lists a no-auth toolkit, opens a session, runs one read and removes the throw-away user's accounts" : `skipped: ${reason}`,
  async () => {
    const previousApi = process.env.OMB_COMPOSIO_API;
    const previousToolkits = process.env.OMB_COMPOSIO_TOOLKITS_API;
    delete process.env.OMB_COMPOSIO_API;
    delete process.env.OMB_COMPOSIO_TOOLKITS_API;
    let userId = "";
    let bodyError: unknown;
    try {
      expect(apiBase().startsWith("https://backend.composio.dev/")).toBe(true);
      const cfg = { composio: { apiKey: KEY } } as AppConfig;
      const catalog = await listToolkits(cfg);
      expect(catalog.source).toBe("api");
      const noAuth = catalog.cards.filter((card) => card.noAuth && !ACCOUNT.test(card.slug));
      const toolkit = PREFERRED.map((slug) => noAuth.find((card) => card.slug === slug)).find(Boolean)?.slug ?? noAuth[0]?.slug;
      if (!toolkit) throw new Error(`no no-auth toolkit; saw ${catalog.cards.slice(0, 20).map((card) => card.slug).join(", ")}`);

      const prepared = await prepareProjectSession(KEY, undefined, {}, { reuseEarlierUser: false });
      userId = prepared.userId;
      expect(userId.startsWith("openmausbot_")).toBe(true);
      const session = await composio(`/tool_router/session/${encodeURIComponent(prepared.sessionId)}`);
      const mcp = session.mcp && typeof session.mcp === "object" ? (session.mcp as { url?: unknown }).url : undefined;
      if (typeof mcp !== "string") throw new Error("Composio Session named no MCP URL");
      const mcpUrl = new URL(mcp);
      if (mcpUrl.protocol !== "https:" || (mcpUrl.hostname !== "composio.dev" && !mcpUrl.hostname.endsWith(".composio.dev"))) {
        throw new Error("Composio Session MCP URL is not on a Composio host");
      }
      const link = await composio(`/tool_router/session/${encodeURIComponent(prepared.sessionId)}/link`, {
        method: "POST",
        body: JSON.stringify({ toolkit }),
      });
      const redirect = link.redirect_url ?? link.url;
      if (typeof redirect !== "string" || !redirect.startsWith("https://")) throw new Error(`no connect link for ${toolkit}`);

      const listed = await sessionMcp(mcpUrl.toString(), "tools/list", {});
      const names = (listed?.result?.tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string");
      const execute = names.find((name) => name === "COMPOSIO_MULTI_EXECUTE_TOOL" || name.endsWith("__COMPOSIO_MULTI_EXECUTE_TOOL")) ?? "COMPOSIO_MULTI_EXECUTE_TOOL";
      const search = names.find((name) => name === "COMPOSIO_SEARCH_TOOLS" || name.endsWith("__COMPOSIO_SEARCH_TOOLS"));
      const discovered = search
        ? slugsIn(await sessionMcp(mcpUrl.toString(), "tools/call", { name: search, arguments: { queries: [{ use_case: `read public data from ${toolkit}` }] } }))
        : [];
      const candidates = [...(KNOWN_READS[toolkit] ?? []), ...discovered];
      const attempts: string[] = [];
      let ran: string | null = null;
      for (const slug of candidates) {
        if (attempts.includes(slug) || !readable(toolkit, [slug])) continue;
        attempts.push(slug);
        if (attempts.length > 3) break;
        const reply = await sessionMcp(mcpUrl.toString(), "tools/call", { name: execute, arguments: { tools: [{ tool_slug: slug, arguments: {} }] } });
        const text = JSON.stringify(reply?.result?.content ?? "");
        if (reply?.result?.isError || /"successful"\s*:\s*false/.test(text)) continue;
        ran = slug;
        break;
      }
      if (!ran) throw new Error(`no read on ${toolkit}; saw ${[...names, ...discovered].slice(0, 30).join(", ")}`);
      expect(ACCOUNT.test(ran)).toBe(false);
    } catch (error) {
      bodyError = error instanceof Error ? new Error(quiet(error.message)) : new Error(quiet(String(error)));
    } finally {
      if (previousApi === undefined) delete process.env.OMB_COMPOSIO_API;
      else process.env.OMB_COMPOSIO_API = previousApi;
      if (previousToolkits === undefined) delete process.env.OMB_COMPOSIO_TOOLKITS_API;
      else process.env.OMB_COMPOSIO_TOOLKITS_API = previousToolkits;
      if (userId) {
        try {
          await removeUserConnections(KEY, userId);
        } catch (error) {
          const message = `could not delete the throw-away user's accounts: ${quiet(error instanceof Error ? error.message : String(error))}`;
          if (!bodyError) bodyError = new Error(message);
        }
      }
    }
    if (bodyError) throw bodyError;
  },
  hostTimeout(180_000),
);
