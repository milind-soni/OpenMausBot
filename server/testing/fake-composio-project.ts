// A loopback stand-in for a team's own Composio project, as OMB_COMPOSIO_API names it: Tool Router Sessions, connect
// links, connected accounts and each Session's MCP endpoint, kept per Composio user. Every request is recorded with the
// user it was made for, so a test can say whose connection a call used. Nothing leaves the machine.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeComposioAccount { id: string; user_id: string; toolkit: { slug: string }; status: string; updated_at: string }

export interface FakeComposioProject {
  /** What OMB_COMPOSIO_API is set to. */
  api: string;
  origin: string;
  accounts: FakeComposioAccount[];
  /** Session id → the Composio user it was made for. */
  sessions: Map<string, string>;
  /** Every request, in order: `user` is the Composio user it named or whose Session it used. */
  requests: Array<{ method: string; path: string; apiKey: string | null; user?: string }>;
  /** Each tools/call that reached a Session's MCP endpoint. */
  toolCalls: Array<{ user: string; tool: string; slugs: string[] }>;
  /** Each connect link asked for. */
  links: Array<{ user: string; toolkit: string }>;
  /** The person finished the sign-in: an active account for that user. */
  connect(userId: string, toolkit: string): string;
  /** While true, every request answers 503. */
  down: boolean;
  close(): Promise<void>;
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { return {}; }
}

export async function startFakeComposioProject(apiKey: string): Promise<FakeComposioProject> {
  let serial = 0;
  const fake: Omit<FakeComposioProject, "api" | "origin" | "close"> = {
    accounts: [], sessions: new Map(), requests: [], toolCalls: [], links: [], down: false,
    connect(userId, toolkit) {
      const id = `ca_fake${String(++serial).padStart(4, "0")}`;
      fake.accounts.push({ id, user_id: userId, toolkit: { slug: toolkit }, status: "ACTIVE", updated_at: new Date(serial * 1000).toISOString() });
      return id;
    },
  };
  let origin = "";
  const session = (id: string) => ({
    session_id: id, mcp: { type: "http", url: `${origin}/mcp/${id}` },
    config: { user_id: fake.sessions.get(id), multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    const key = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : null;
    const record: FakeComposioProject["requests"][number] = { method: req.method ?? "GET", path, apiKey: key };
    fake.requests.push(record);
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (fake.down) return send(503, { message: "Composio is unavailable" });
    if (key !== apiKey) return send(401, { message: "Invalid API key" });
    const body = req.method === "POST" || req.method === "PATCH" ? await json(req) : {};

    if (path === "/auth_configs") return send(200, { items: [] });
    if (path === "/tool_router/session" && req.method === "POST") {
      const id = `trs_fake${++serial}`;
      record.user = String(body.user_id);
      fake.sessions.set(id, record.user);
      return send(201, session(id));
    }
    const routed = /^\/tool_router\/session\/([^/]+)(\/toolkits|\/link)?$/.exec(path);
    if (routed) {
      const id = decodeURIComponent(routed[1]!), user = fake.sessions.get(id);
      if (!user) return send(404, { message: "Session not found" });
      record.user = user;
      if (!routed[2]) return send(200, session(id));
      if (routed[2] === "/link") {
        fake.links.push({ user, toolkit: String(body.toolkit) });
        return send(200, { redirect_url: `https://backend.composio.dev/link/lk_fake${++serial}` });
      }
      const wanted = url.searchParams.get("toolkits")?.split(",").filter(Boolean);
      const items = fake.accounts.filter((account) => account.user_id === user && (!wanted || wanted.includes(account.toolkit.slug)))
        .map((account) => ({ slug: account.toolkit.slug, connected_account: { id: account.id, status: account.status } }));
      return send(200, { items });
    }
    if (path === "/connected_accounts" && req.method === "GET") {
      const user = url.searchParams.get("user_ids"), slugs = url.searchParams.get("toolkit_slugs")?.split(",").filter(Boolean);
      if (user) record.user = user;
      return send(200, { items: fake.accounts.filter((account) => (!user || account.user_id === user) && (!slugs || slugs.includes(account.toolkit.slug))) });
    }
    const account = /^\/connected_accounts\/([^/]+)$/.exec(path);
    if (account && req.method === "DELETE") {
      const index = fake.accounts.findIndex((entry) => entry.id === decodeURIComponent(account[1]!));
      if (index < 0) return send(404, { message: "Connected account not found" });
      record.user = fake.accounts[index]!.user_id;
      fake.accounts.splice(index, 1);
      return send(200, { success: true });
    }
    const mcp = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (mcp && req.method === "POST") {
      const user = fake.sessions.get(decodeURIComponent(mcp[1]!));
      if (!user) return send(404, { message: "Session not found" });
      record.user = user;
      const frame = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: { tools?: Array<{ tool_slug?: string }> } } };
      if (frame.id === undefined) { res.writeHead(202); return res.end(); }
      if (frame.method === "initialize") return send(200, { jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-composio", version: "1" } } });
      if (frame.method === "tools/list") return send(200, { jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } }] } });
      if (frame.method === "tools/call") {
        const slugs = (frame.params?.arguments?.tools ?? []).map((tool) => String(tool.tool_slug));
        fake.toolCalls.push({ user, tool: String(frame.params?.name), slugs });
        const mine = fake.accounts.filter((entry) => entry.user_id === user).map((entry) => entry.id);
        return send(200, { jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { as: user, accounts: mine } }) }] } });
      }
      return send(200, { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } });
    }
    return send(404, { message: `no fake for ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    api: `${origin}/api/v3.1`, origin,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}
