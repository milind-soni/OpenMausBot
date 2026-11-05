import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createOpenConnector } from "../openconnector/service.ts";
import { OPENCONNECTOR_SERVER } from "../../shared/openconnector.ts";
import { createOpenConnectorRoutes } from "./openconnector.ts";
import { dispatchRoutes } from "./table.ts";

let dir: string;
let cfg: Pick<AppConfig, "openconnector" | "mcpServers">;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-openconnector-routes-"));
  cfg = { openconnector: { url: "http://127.0.0.1:3000/mcp", command: "", args: [] }, mcpServers: {} };
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(scopes: string[]): Promise<string> {
  const openconnector = createOpenConnector({
    cfg: () => cfg,
    persistMcpServers: (next) => { cfg = { ...cfg, mcpServers: next }; },
    mcpConfigBusy: { get: () => false, set: () => {} },
    mcpPolicyRefusal: () => undefined,
    dataDir: dir,
    loopback: true,
    probe: () => Promise.resolve({ ok: true, tools: [{ name: "list_apps" }, { name: "search_actions" }, { name: "get_action_guide" }, { name: "execute_action" }, { name: "list_connections" }] }),
    launch: () => ({ pid: 1, once: () => {} }) as unknown as ChildProcess,
    autoHealth: false,
  });
  const routes = [createOpenConnectorRoutes({ openconnector })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("OpenConnector routes", () => {
  it("are for admins only", () => {
    expect(requiredScope("GET", "/api/openconnector")).toBe("admin");
    expect(requiredScope("POST", "/api/openconnector/connect")).toBe("admin");
    expect(requiredScope("POST", "/api/openconnector/check")).toBe("admin");
    expect(requiredScope("DELETE", "/api/openconnector")).toBe("admin");
  });

  it("refuses a non-admin caller", async () => {
    const base = await serve(["client"]);
    const response = await fetch(`${base}/api/openconnector`);
    expect(response.status).toBe(403);
  });

  it("connects, reports the status and disconnects", async () => {
    const base = await serve(["admin"]);
    const connect = await fetch(`${base}/api/openconnector/connect`, { method: "POST" });
    expect(connect.status).toBe(200);
    const connected = await connect.json();
    expect(connected.state).toBe("connected");
    expect(connected.tools).toBe(5);
    expect(connected.managed).toBe(false);

    const status = await (await fetch(`${base}/api/openconnector`)).json();
    expect(status.state).toBe("connected");

    const check = await fetch(`${base}/api/openconnector/check`, { method: "POST" });
    expect(check.status).toBe(200);

    const disconnect = await fetch(`${base}/api/openconnector`, { method: "DELETE" });
    expect(disconnect.status).toBe(200);
    expect(cfg.mcpServers?.[OPENCONNECTOR_SERVER]).toBeUndefined();
    expect((await (await fetch(`${base}/api/openconnector`)).json()).state).toBe("not-connected");
  });

  it("never answers with anything secret-shaped", async () => {
    const base = await serve(["admin"]);
    const response = await fetch(`${base}/api/openconnector/connect`, { method: "POST" });
    const text = await response.text();
    expect(text).not.toMatch(/token|bearer|authorization|key/iu);
  });
});
