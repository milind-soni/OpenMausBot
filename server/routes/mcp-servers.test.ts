import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { listMcpServers } from "../mcp-registry.ts";
import { createMcpServerRoutes } from "./mcp-servers.ts";
import { dispatchRoutes } from "./table.ts";

let server: Server | undefined;
afterEach(async () => {
  const active = server;
  server = undefined;
  if (active) await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
});

async function serve() {
  const cfg: Pick<AppConfig, "mcpServers"> = { mcpServers: {} };
  let busy = false;
  const route = createMcpServerRoutes({
    cfg,
    sessions: { isLive: () => true },
    mcpOAuth: new McpOAuthManager({ file: join(DATA_DIR, "mcp-route-oauth.json") }),
    teamConnections: { personMcp: () => ["private"], people: {} as TeamConnectionsHost["people"] },
    cloudHome: null,
    fallbackPublicUrl: null,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpServerResponse: () => ({ servers: listMcpServers(cfg.mcpServers) }),
    mcpPolicyRefusal: () => undefined,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    savedCustomDomain: () => null,
  });
  const active = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes([route], {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
  });
  server = active;
  await new Promise<void>((ready) => active.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(active.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { cfg, post, get: () => fetch(`${base}/api/mcp/servers`) };
}

it.each([["private", "person"], ["public", "team"]])("lists the scope of %s in reads and mutation responses", async (name, scope) => {
  const { post, get } = await serve();
  const response = await post("/api/mcp/servers", { name, url: "https://mail.example.com/mcp", headers: { Authorization: "" } });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ servers: [{ name, scope }] });
  expect(await (await get()).json()).toMatchObject({ servers: [{ name, scope }] });
});

it.each(["create", "import"])("rejects personal header values on %s without saving any server", async (action) => {
  const { cfg, post } = await serve();
  const entry = { url: "https://mail.example.com/mcp", headers: { Authorization: "Bearer private-secret" } };
  const response = action === "create"
    ? await post("/api/mcp/servers", { name: "private", ...entry })
    : await post("/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: { public: { url: "https://public.example.com/mcp" }, private: entry } }) });

  expect(response.status).toBe(400);
  const body = await response.json() as { error: string };
  expect(body.error).toMatch(/personal.*header|header.*personal/i);
  expect(JSON.stringify(body)).not.toContain("private-secret");
  expect(cfg.mcpServers).toEqual({});
});

it.each(["create", "import"])("accepts blank personal headers on %s and retains team header values", async (action) => {
  const { cfg, post } = await serve();
  for (const [name, value] of [["private", ""], ["public", "Bearer team-secret"]] as const) {
    const entry = { type: "http", url: "https://mail.example.com/mcp", headers: { Authorization: value } };
    const response = action === "create"
      ? await post("/api/mcp/servers", { name, ...entry })
      : await post("/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: { [name]: entry } }) });
    expect(response.status).toBe(201);
    expect(cfg.mcpServers?.[name]).toMatchObject({ headers: { Authorization: value } });
  }
});
