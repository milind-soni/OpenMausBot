import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFleetAgent } from "./fleet-agent.ts";
import { fleetRequest } from "./fleet-client.ts";
import { emptyRegistry, fleetLayout, type FleetRegistry } from "./fleet.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe.skipIf(process.platform === "win32")("fleet agent and web addresses", () => {
  let root: string;
  let socketPath: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-fleet-agent-host-"));
    socketPath = join(root, "fleet.sock");
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    await removeTempDir(root);
  });

  async function boot(registry: FleetRegistry = emptyRegistry("example.test")) {
    const m = fleetMachine(root);
    const layout = fleetLayout(root);
    m.files.set(layout.registryFile, JSON.stringify(registry));
    const server = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root, deps: m.deps, auditFile: join(root, "audit.jsonl"), now: () => new Date("2026-09-10T12:00:00Z") }, { log: () => {} });
    stop = () => new Promise((resolve) => server.close(() => resolve()));
    const saved = (): FleetRegistry => JSON.parse(m.files.get(layout.registryFile)!);
    return { ...m, layout, saved };
  }

  it("ignores a host in the request body: the agent only serves the default address", async () => {
    const m = await boot();
    const created = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "acme", admins: ["owner@acme.test"], host: "chat.acme.com" });
    expect(created).toMatchObject({ status: 200, body: { ok: true, log: [expect.stringContaining("https://acme.example.test is ready")] } });
    expect(m.saved().workspaces.acme?.host).toBe("acme.example.test");
    expect(m.files.get(join(root, "etc/caddy/omb.d/acme.caddy"))).toMatch(/^acme\.example\.test \{/);
    expect(m.files.get(join(root, "etc/openmausbot/instances/acme.env"))).toContain("OMB_PUBLIC_URL=https://acme.example.test\n");
    expect([...m.files.values()].some((content) => content.includes("chat.acme.com"))).toBe(false);
    expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain("chat.acme.com");
  });

  it("lets exactly one of two concurrent creates of the same name win", async () => {
    const m = await boot();
    const replies = await Promise.all([1, 2].map(() => fleetRequest(socketPath, "POST", "/workspaces", { slug: "acme", admins: ["owner@acme.test"], host: "chat.acme.com" })));
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 400]);
    expect(replies.find((reply) => reply.status === 400)?.body).toMatchObject({ error: expect.stringContaining("already exists") });
    expect(Object.keys(m.saved().workspaces)).toEqual(["acme"]);
    expect(m.calls.filter((call) => call.startsWith("useradd"))).toHaveLength(1);
  });

  it("keeps two concurrent creates that both ask for one host on their own default addresses", async () => {
    const m = await boot();
    const replies = await Promise.all(["alpha", "beta"].map((slug) => fleetRequest(socketPath, "POST", "/workspaces", { slug, admins: ["owner@acme.test"], host: "chat.acme.com" })));
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const hosts = Object.values(m.saved().workspaces).map((workspace) => workspace.host).sort();
    expect(hosts).toEqual(["alpha.example.test", "beta.example.test"]);
  });

  it("refuses a name whose default address a custom-host workspace already holds", async () => {
    const held = { ...emptyRegistry("example.test"), workspaces: { acme: { slug: "acme", host: "newco.example.test", port: 8810, webhookPort: 8811, status: "retained" as const, createdAt: "2026-09-01T00:00:00.000Z" } } };
    const m = await boot(held);
    const refused = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "newco", admins: ["owner@acme.test"] });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining('workspace "acme"') } });
    expect(m.calls).toEqual([]);
    expect(Object.keys(m.saved().workspaces)).toEqual(["acme"]);
  });

  it("lists a workspace created on a custom host with that host and serves its site", async () => {
    const custom = { ...emptyRegistry("example.test"), workspaces: { acme: { slug: "acme", host: "chat.acme.com", port: 8810, webhookPort: 8811, status: "running" as const, createdAt: "2026-09-01T00:00:00.000Z" } } };
    const m = await boot(custom);
    expect(await fleetRequest(socketPath, "GET", "/workspaces")).toMatchObject({ status: 200, body: { workspaces: [{ slug: "acme", host: "chat.acme.com" }] } });
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/suspend")).status).toBe(200);
    expect(m.files.get(join(root, "etc/caddy/omb.d/acme.caddy"))).toBe('chat.acme.com {\n\trespond "This workspace is suspended." 503\n}\n');
    expect((await fleetRequest(socketPath, "DELETE", "/workspaces/acme", {})).status).toBe(200);
    expect(m.files.has(join(root, "etc/caddy/omb.d/acme.caddy"))).toBe(false);
  });
});
