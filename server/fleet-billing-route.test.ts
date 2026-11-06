import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnterpriseLayer } from "./enterprise.ts";
import { startFleetAgent } from "./fleet-agent.ts";
import { emptyRegistry, fleetLayout, workspaceDataDir } from "./fleet.ts";
import { json, readBody } from "./harness/http.ts";
import { requiredScope, type RequestAuth } from "./request-auth.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./routes/status.ts";
import { PASS } from "./routes/table.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const admin = { kind: "session", scopes: ["admin"] } as unknown as RequestAuth;

describe.skipIf(process.platform === "win32")("the operator app's fleet billing route", () => {
  let root: string;
  let agent: Server | null = null;
  let app: Server | null = null;
  let base = "";
  const savedSocket = process.env.OMB_FLEET_SOCKET;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omb-fleet-route-")); });
  afterEach(async () => {
    await Promise.all([agent, app].map((server) => server && new Promise<void>((resolve) => server.close(() => resolve()))));
    agent = null;
    app = null;
    if (savedSocket === undefined) delete process.env.OMB_FLEET_SOCKET; else process.env.OMB_FLEET_SOCKET = savedSocket;
    await loadEnterpriseLayer({ dir: join(root, "no-layer"), licenseKey: undefined });
    await removeTempDir(root);
  });

  async function layer(features: string[]) {
    const dir = join(root, "layer");
    mkdirSync(join(dir, "server"), { recursive: true });
    writeFileSync(join(dir, "server", "index.js"), `export async function register() { return { customer: "Fixture Co", features: ${JSON.stringify(features)}, expiresAt: "2099-01-01" }; }\n`);
    await loadEnterpriseLayer({ dir, licenseKey: "fixture-key" });
  }

  async function boot(options: { agent: boolean }) {
    const socketPath = join(root, "fleet.sock");
    process.env.OMB_FLEET_SOCKET = socketPath;
    if (options.agent) {
      const layout = fleetLayout(root);
      const machine = fleetMachine(root);
      const workspace = { slug: "acme", host: "acme.example.test", port: 8810, webhookPort: 8811, status: "running" as const, createdAt: "2026-08-01T00:00:00.000Z", events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" as const }] };
      machine.files.set(layout.registryFile, JSON.stringify({ ...emptyRegistry("example.test"), reseller: { name: "Acme Cloud", currency: "USD", wholesale: { workspaceMonthMinor: 2000, userMonthMinor: 500 }, retail: { workspaceMonthMinor: 5000, userMonthMinor: 1500 } }, workspaces: { acme: workspace } }));
      mkdirSync(join(workspaceDataDir(layout, "acme"), "usage"), { recursive: true });
      writeFileSync(join(workspaceDataDir(layout, "acme"), "usage", "2026-09.jsonl"), `${JSON.stringify({ at: "2026-09-10T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "c", driverKind: "d", model: "m", input: 1, output: 1, costUsd: 0.1, trigger: { kind: "user", email: "ada@x.test" } })}\n`);
      agent = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/cli.js", root, deps: machine.deps, auditFile: join(root, "audit.jsonl"), now: () => NOW }, { log: () => {} });
    }
    const routes = createStatusRoutes({} as unknown as StatusRouteDeps);
    app = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://app");
      void routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: admin, json, readBody }).then((outcome) => {
        if (outcome === PASS) { res.writeHead(418); res.end("{}"); }
      });
    });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(app!.address() as AddressInfo).port}`;
  }
  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, headers: response.headers, body: (await response.json()) as any };
  };

  it("is an admin-scope route, like the rest of the fleet screen", () => {
    expect(requiredScope("GET", "/api/fleet/billing")).toBe("admin");
    expect(requiredScope("GET", "/api/fleet")).toBe("admin");
  });

  it("refuses on the open-source edition", async () => {
    await boot({ agent: true });
    const reply = await get("/api/fleet/billing");
    expect(reply.status).toBe(403);
    expect(reply.body.error).toContain("admin feature");
  });

  it.each([
    [["billing"], "Workspaces need an enterprise licence with the admin feature"],
    [["admin"], "Billing by workspace needs an enterprise licence with the billing feature"],
    [["whitelabel", "budgets"], "Workspaces need an enterprise licence with the admin feature"],
  ])("refuses a licence granting %j", async (features, message) => {
    await layer(features);
    await boot({ agent: true });
    const reply = await get("/api/fleet/billing?month=2026-09");
    expect(reply.status).toBe(403);
    expect(reply.body.error).toContain(message);
  });

  it("lets the workspace list through with admin alone, because only billing needs the second feature", async () => {
    await layer(["admin"]);
    await boot({ agent: true });
    expect((await get("/api/fleet")).status).toBe(200);
    expect((await get("/api/fleet/billing")).status).toBe(403);
  });

  it("forwards the month and detail to the agent and returns its report, uncached", async () => {
    await layer(["admin", "billing"]);
    await boot({ agent: true });
    const plain = await get("/api/fleet/billing");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(plain.body).toMatchObject({ month: "2026-09", reseller: { name: "Acme Cloud" }, totals: { workspaces: 1, activeUsers: 1, wholesaleMinor: 2500, retailMinor: 6500 } });
    expect(plain.body.workspaces[0].users).toBeUndefined();
    const detailed = await get("/api/fleet/billing?month=2026-08&detail=true");
    expect(detailed.body).toMatchObject({ month: "2026-08", final: true });
    expect(detailed.body.workspaces[0].users).toEqual([]);
    expect((await get("/api/fleet/billing?detail=true")).body.workspaces[0].users).toEqual([{ id: "ada@x.test", kind: "email", asked: 1, attributed: 1, costUsd: 0.1 }]);
  });

  it("passes on only the two parameters it knows", async () => {
    await layer(["admin", "billing"]);
    await boot({ agent: true });
    const reply = await get("/api/fleet/billing?month=2026-09&maxUsers=1&root=/etc&detail=false");
    expect(reply.status).toBe(200);
    expect(reply.body.workspaces[0].users).toBeUndefined();
  });

  it("returns the agent's refusal of a bad month", async () => {
    await layer(["admin", "billing"]);
    await boot({ agent: true });
    for (const month of ["2026-13", "2027-01", "x"]) {
      const reply = await get(`/api/fleet/billing?month=${month}`);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toMatch(/YYYY-MM|has not started/);
    }
  });

  it("says plainly when this server has no fleet agent", async () => {
    await layer(["admin", "billing"]);
    await boot({ agent: false });
    const reply = await get("/api/fleet/billing");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toContain("No fleet agent");
  });

  it("allows nothing but a read", async () => {
    await layer(["admin", "billing"]);
    await boot({ agent: true });
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await get("/api/fleet/billing", { method, ...(method === "DELETE" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }) })).status).toBe(405);
    }
  });
});
