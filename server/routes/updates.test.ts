import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { WorkspaceBackupMaintenance } from "../workspace-backup-maintenance.ts";
import { createUpdateRoutes, updateCandidates, type UpdateProvider } from "./updates.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const provider = (overrides: Partial<UpdateProvider> = {}): UpdateProvider => ({ instanceId: "codex", driverKind: "codex", displayName: "Codex", cliCandidates: ["/fixture/codex"], cliDefault: "codex", install: { server: { package: "@openai/codex" } }, ...overrides });

it("selects installed writable providers, deduplicates packages, never replaces custom paths", () => {
  expect(updateCandidates([provider(), provider({ instanceId: "second" }), provider({ instanceId: "custom", cli: "/custom/codex" }),
    provider({ instanceId: "absent", cliCandidates: [] }), provider({ instanceId: "managed", readOnly: true }), provider({ instanceId: "policy", policy: {} }),
    provider({ instanceId: "claude", driverKind: "claudeAgent", cliDefault: "claude", install: {} })]).map(p => p.instanceId)).toEqual(["codex", "claude"]);
});

async function fixture() {
  const state = { admin: true, live: true, idle: true, providers: [provider()], desktop: { status: "downloaded", version: "2.0", installMode: "restart" } };
  const install = vi.fn(async () => {});
  const desktop = vi.fn(async () => state.desktop);
  const lock = new WorkspaceBackupMaintenance();
  const route = createUpdateRoutes({ environmentId: "fixture", version: () => "1.0", providers: async () => state.providers,
    idle: () => state.idle && !lock.active, authorized: () => state.live,
    install, desktop, exclusive: work => lock.run(work, { idle: () => state.idle, pause: () => {}, resume: () => {}, flush: async () => {} }) });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    try {
      if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method!, auth: { kind: "loopback", scopes: state.admin ? ["admin", "client"] : ["client"] }, json, readBody })) json(res, 404, {});
    } catch (error) { if (!res.headersSent) json(res, (error as { status?: number }).status ?? 500, { error: String(error) }); }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (suffix: string, body: { instances?: (string | { instanceId: string; key: string })[]; [key: string]: unknown } = {}) => fetch(`${origin}/api/updates/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environmentId: "fixture", ...body,
    ...(body.instances ? { instances: body.instances.map(p => typeof p === "string" ? { instanceId: p, key: "npm:@openai/codex" } : p) } : {}) }), signal: AbortSignal.timeout(5000) });
  return { state, install, desktop, lock, post, origin };
}

it("uses the real HTTP route, proves provider update inside the exclusive lease", async () => {
  const f = await fixture();
  f.install.mockImplementation(async () => { expect(f.lock.active).toBe(true); });
  const response = await f.post("providers", { instances: ["codex"] });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ updated: ["codex"] });
  expect(f.install).toHaveBeenCalledWith("codex", "npm"); expect(f.lock.active).toBe(false);
  expect(await (await fetch(`${f.origin}/api/updates`)).json()).toMatchObject({ environmentId: "fixture", version: "1.0", idle: true });
});

it("rejects non-admins, revoked sessions, changed identity, unknown providers and active work", async () => {
  const f = await fixture();
  for (const method of ["GET", "POST"]) expect(requiredScope(method, "/api/updates/providers")).toBe("admin");
  f.state.admin = false; expect((await f.post("providers", { instances: ["codex"] })).status).toBe(403);
  f.state.admin = true; f.state.live = false; expect((await f.post("providers", { instances: ["codex"] })).status).toBe(403);
  f.state.live = true; expect((await f.post("providers", { environmentId: "other", instances: ["codex"] })).status).toBe(409);
  expect((await f.post("providers", { instances: ["unknown"] })).status).toBe(409);
  expect((await f.post("providers", { instances: [{ instanceId: "codex", key: "npm:changed-package" }] })).status).toBe(409);
  f.state.idle = false; expect((await f.post("providers", { instances: ["codex"] })).status).toBe(409);
  expect(f.install).not.toHaveBeenCalled();
});

it("rejects overlapping writes and releases maintenance after a failed installer", async () => {
  const f = await fixture(); let release!: () => void;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  f.install.mockImplementation(() => new Promise<void>(resolve => { release = resolve; started(); }));
  const first = f.post("providers", { instances: ["codex"] }); await ready;
  expect((await f.post("providers", { instances: ["codex"] })).status).toBe(503);
  release(); expect((await first).status).toBe(200);
  f.install.mockRejectedValue(new Error("fake installer failed"));
  expect((await f.post("providers", { instances: ["codex"] })).status).toBe(500);
  expect(f.lock.active).toBe(false);
});

it("requires reviewed downloaded version and acknowledges before restart", async () => {
  const f = await fixture();
  expect((await f.post("install", { version: "old" })).status).toBe(409);
  const response = await f.post("install", { version: "2.0" });
  expect(response.status).toBe(202); expect(await response.json()).toEqual({ version: "2.0" });
  await vi.waitFor(() => expect(f.desktop).toHaveBeenCalledWith("install", "2.0"));
  f.state.desktop.installMode = "handoff";
  expect((await f.post("install", { version: "2.0" })).status).toBe(409);
});

it("refuses non-JSON mutations before parsing", async () => {
  const f = await fixture();
  expect((await fetch(`${f.origin}/api/updates/providers`, { method: "POST", body: "bad" })).status).toBe(415);
  expect(f.install).not.toHaveBeenCalled();
});
