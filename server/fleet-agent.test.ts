import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFleetAgent } from "./fleet-agent.ts";
import { fleetAvailable, fleetRequest } from "./fleet-client.ts";
import type { FleetDeps } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, MANAGED_OPENROUTER } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { appendUsage, flushUsageLedger, readUsage, summarizeUsage } from "./usage-ledger.ts";

// A machine that records what the agent does to it, with a real temp root
// for the files the agent reads back (registry, ledgers). No systemd, nft,
// Caddy or user accounts are touched.
function machine(root: string, options: { failing?: string[]; beforeRun?: (argv: string[]) => Promise<void> } = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const deps: FleetDeps = {
    isRoot: () => true,
    run: async (argv) => {
      calls.push(argv.join(" "));
      await options.beforeRun?.(argv);
      if (argv[0] === "systemctl" && argv[1] === "is-active") return { code: 0, output: "active\n" };
      return options.failing?.some((prefix) => argv.join(" ").startsWith(prefix)) ? { code: 1, output: "unit failed: secret-token\n" } : { code: 0, output: "" };
    },
    readText: (path) => files.get(path) ?? (path.endsWith("fleet.json") ? null : null),
    pathExists: (path) => files.has(path),
    usage: (dataDir, owner, now) => {
      calls.push(`usage ${dataDir} as ${owner}`);
      const total = summarizeUsage(readUsage(dataDir, { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now }), "bot").total;
      return { turns: total.turns, costUsd: total.costUsd, billableUsd: null };
    },
    writeText: (path, content) => { files.set(path, content); },
    mkdir: () => {},
    appendOnce: () => {},
    remove: (path) => { files.delete(path); },
    health: async () => true,
  };
  return { deps, files, calls, root };
}

// The agent is a Linux service; Windows cannot bind a Unix socket in a temp folder.
describe.skipIf(process.platform === "win32")("fleet agent over its socket", () => {
  let root: string;
  let socketPath: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-fleet-agent-"));
    socketPath = join(root, "fleet.sock");
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    await removeTempDir(root);
  });

  async function boot(m: ReturnType<typeof machine>) {
    const logs: string[] = [];
    const server = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root: m.root, deps: m.deps, auditFile: join(m.root, "audit.jsonl"), licenseKey: "omb1.k", now: () => new Date("2026-09-10T12:00:00Z") }, { log: (line) => logs.push(line) });
    stop = () => new Promise((resolve) => server.close(() => resolve()));
    return logs;
  }

  it("creates an OpenRouter-only workspace and updates its catalog through the real isolated socket", async () => {
    const m = machine(root);
    m.files.set(fleetLayout(root).registryFile, JSON.stringify(emptyRegistry("example.test")));
    await boot(m);
    const created = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "acme", admins: ["owner@example.test"], portalUrl: "https://admin.example.test", openrouterKey: "scoped-secret", openrouterUrl: "https://admin.example.test/api/gateway/acme/openrouter/v1", openrouterModels: ["provider/first"], openrouterDefault: true });
    expect(created.status).toBe(200);
    const configPath = join(root, "var/lib/openmausbot/acme/.openmausbot/config.json");
    const original = m.files.get(configPath);
    expect(JSON.parse(original!).defaultModelSelection).toEqual({ instanceId: "opencodeGo", model: `${MANAGED_OPENROUTER}/provider/first` });
    const path = join(root, "var/lib/openmausbot/acme/.config/opencode/opencode.json");
    const count = m.calls.length;
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/providers", { models: ["provider/second"] })).status).toBe(200);
    expect(JSON.parse(m.files.get(path)!).provider[MANAGED_OPENROUTER]).toMatchObject({ options: { apiKey: "scoped-secret" }, models: { "provider/second": { name: "provider/second" } } });
    expect(m.calls.length).toBe(count); // no service restart or live process mutation
    expect(m.files.get(configPath)).toBe(original);
    for (const models of [undefined, "provider/model", [null], ["invalid\nmodel"]]) expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/providers", { models })).status).toBe(400);
    const saved = m.files.get(path);
    m.files.set(path, '{"private":"scoped-secret",');
    expect(await fleetRequest(socketPath, "POST", "/workspaces/acme/providers", { models: [] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("operator recovery") } });
    expect(m.files.get(path)).toBe('{"private":"scoped-secret",');
    expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain("scoped-secret");
    m.files.set(path, saved!);
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/providers", { models: [] })).status).toBe(200);
    expect(JSON.parse(m.files.get(path)!).provider[MANAGED_OPENROUTER].models).toEqual({});
  });

  it("creates, lists with this month's usage, edits users, suspends, deletes, and audits every action", async () => {
    const m = machine(root);
    const layout = fleetLayout(root);
    m.files.set(layout.registryFile, JSON.stringify({ ...emptyRegistry("agentada.cc"), operator: "maus" }));
    const logs = await boot(m);
    expect(logs[0]).toContain("fleet agent listening");
    expect(fleetAvailable(socketPath)).toBe(true);
    // the socket itself is the authorisation: owner and group only
    if (process.platform !== "win32") expect(statSync(socketPath).mode & 0o777).toBe(0o660);

    const created = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "acme", admins: ["ada@example.test"], members: ["@acme.test"], cap: 40, anthropicKey: "sk-ant-fixture", brandJson: '{"name":"Acme"}', portalUrl: "https://admin.example.test", anthropicUrl: "https://admin.example.test/api/gateway/acme/anthropic" });
    expect(created).toMatchObject({ status: 200, body: { ok: true, log: [expect.stringContaining("https://acme.agentada.cc is ready")] } });
    expect(m.calls).toContain("useradd --system --create-home --home-dir " + join(root, "var/lib/openmausbot/acme") + " --shell /usr/sbin/nologin --user-group omb-acme");
    expect(JSON.parse(m.files.get(join(root, "var/lib/openmausbot/acme/.openmausbot/config.json"))!)).toMatchObject({ anthropic: { key: "sk-ant-fixture", url: "https://admin.example.test/api/gateway/acme/anthropic" }, budgets: { monthlyUsd: 40 } });
    expect(m.files.get(join(root, "etc/openmausbot/instances/acme.env"))).toContain("OMB_LICENSE_KEY=omb1.k");
    expect(m.files.get(join(root, "etc/openmausbot/instances/acme.env"))).toContain("OMB_ADMIN_URL=https://admin.example.test");
    expect(m.files.get(join(root, "etc/openmausbot/instances/acme.env"))).toContain("OMB_ADMIN_WORKSPACE=acme");

    // The fixture's ledger is summarized by the mocked unprivileged-usage seam.
    // The filesystem suite exercises the real privilege-dropped child.
    const dataDir = join(root, "var/lib/openmausbot/acme/.openmausbot");
    mkdirSync(dataDir, { recursive: true });
    appendUsage(dataDir, { at: "2026-09-03T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd: 0.25, trigger: { kind: "owner" } });
    appendUsage(dataDir, { at: "2026-08-03T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd: 9, trigger: { kind: "owner" } });
    await flushUsageLedger(dataDir);
    const listed = await fleetRequest(socketPath, "GET", "/workspaces");
    expect(listed).toMatchObject({ status: 200, body: { domain: "agentada.cc", operator: "maus", workspaces: [{ slug: "acme", host: "acme.agentada.cc", port: 8810, live: "active", usage: { month: "2026-09", turns: 1, costUsd: 0.25 } }] } });
    expect(m.calls).toContain(`usage ${dataDir} as omb-acme`);

    const added = await fleetRequest(socketPath, "POST", "/workspaces/acme/users", { action: "add", email: "bob@acme.test", chatOnly: true });
    expect(added.status).toBe(200);
    expect(JSON.parse(m.files.get(join(dataDir, "config.json"))!).signIn).toEqual({ admins: ["ada@example.test"], members: ["@acme.test", "bob@acme.test"] });
    expect(await fleetRequest(socketPath, "POST", "/workspaces/acme/users", { action: "remove", email: "nobody@acme.test" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("not on the list") } });

    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/suspend")).status).toBe(200);
    expect(m.calls).toContain("systemctl disable --now openmausbot@acme.service");
    expect((await fleetRequest(socketPath, "DELETE", "/workspaces/acme", { keepData: true })).status).toBe(200);
    expect(m.calls.some((call) => call.startsWith("userdel"))).toBe(false);
    expect(m.files.get(layout.fenceFile)).toContain("omb-acme");
    expect(await fleetRequest(socketPath, "GET", "/workspaces")).toMatchObject({ status: 200, body: { workspaces: [{ slug: "acme", status: "retained", live: "retained" }] } });

    const audit = readFileSync(join(root, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((entry) => [entry.action, entry.ok])).toEqual([["create", true], ["users", true], ["users", false], ["suspend", true], ["delete", true]]);
    expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain("sk-ant-fixture");
  });

  it("refuses bad names and unknown operations, and reports a failed step without the tool's secrets", async () => {
    const m = machine(root, { failing: ["systemctl enable"] });
    m.files.set(fleetLayout(root).registryFile, JSON.stringify(emptyRegistry("agentada.cc")));
    await boot(m);
    expect(await fleetRequest(socketPath, "POST", "/workspaces", { slug: "Not Valid", admins: ["a@b.test"] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("not a workspace name") } });
    expect(await fleetRequest(socketPath, "POST", "/workspaces", { slug: "beta", admins: [] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("at least one admin") } });
    expect((await fleetRequest(socketPath, "GET", "/nothing")).status).toBe(404);
    expect((await fleetRequest(socketPath, "POST", "/workspaces/../etc", {})).status).toBe(404);
    const failed = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "beta", admins: ["b@example.test"] });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).toContain("could not start the workspace");
    expect(JSON.stringify(failed.body)).toContain("unit failed");
    expect(JSON.parse(m.files.get(fleetLayout(root).registryFile)!)).toMatchObject({ nextPort: 8820, workspaces: { beta: { status: "error", accountCreated: true } } });
    expect(await fleetRequest(socketPath, "POST", "/workspaces", { slug: "beta", admins: ["b@example.test"] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("already exists") } });
    expect(await fleetRequest(socketPath, "POST", "/workspaces/beta/resume")).toMatchObject({ status: 400, body: { error: expect.stringContaining("operator recovery") } });
    expect(await fleetRequest(socketPath, "GET", "/workspaces")).toMatchObject({ status: 200, body: { workspaces: [{ slug: "beta", status: "error", live: "error" }] } });
    expect(m.calls).not.toContain("systemctl is-active openmausbot@beta.service");
  });

  it("serializes complete mutations and exposes the reservation while creation is pending", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const m = machine(root, { beforeRun: async (argv) => {
      if (argv[0] === "useradd" && argv.at(-1) === "omb-alpha") await blocked;
    } });
    const layout = fleetLayout(root);
    m.files.set(layout.registryFile, JSON.stringify(emptyRegistry("agentada.cc")));
    await boot(m);
    const alpha = fleetRequest(socketPath, "POST", "/workspaces", { slug: "alpha", admins: ["a@example.test"] });
    try {
      await vi.waitFor(() => expect(m.calls.some((call) => call.endsWith("omb-alpha"))).toBe(true));
      expect(await fleetRequest(socketPath, "GET", "/workspaces")).toMatchObject({ status: 200, body: { workspaces: [{ slug: "alpha", status: "provisioning", accountCreated: false, live: "provisioning" }] } });
      const beta = fleetRequest(socketPath, "POST", "/workspaces", { slug: "beta", admins: ["b@example.test"] });
      // A health request reaches the server while the second mutation is queued.
      expect((await fleetRequest(socketPath, "GET", "/health")).status).toBe(200);
      expect(m.calls.some((call) => call.endsWith("omb-beta"))).toBe(false);
      release();
      expect((await alpha).status).toBe(200);
      expect((await beta).status).toBe(200);
      const registry = JSON.parse(m.files.get(layout.registryFile)!);
      expect(registry).toMatchObject({ nextPort: 8830, workspaces: { alpha: { port: 8810, status: "running" }, beta: { port: 8820, status: "running" } } });
      expect(m.files.get(layout.fenceFile)).toContain("omb-alpha");
      expect(m.files.get(layout.fenceFile)).toContain("omb-beta");
    } finally {
      release();
      await alpha;
    }
  });

  it("keeps a failed account reservation and continues the queue after a filesystem exception", async () => {
    const m = machine(root);
    const layout = fleetLayout(root);
    m.files.set(layout.registryFile, JSON.stringify(emptyRegistry("agentada.cc")));
    const writeText = m.deps.writeText;
    m.deps.writeText = (path, content, mode, owner) => {
      if (path.endsWith("/alpha/.openmausbot/config.json")) throw new Error("fixture write refused");
      writeText(path, content, mode, owner);
    };
    await boot(m);
    const [alpha, beta] = await Promise.all([
      fleetRequest(socketPath, "POST", "/workspaces", { slug: "alpha", admins: ["a@example.test"] }),
      fleetRequest(socketPath, "POST", "/workspaces", { slug: "beta", admins: ["b@example.test"] }),
    ]);
    expect(alpha).toMatchObject({ status: 500, body: { error: "fixture write refused" } });
    expect(beta.status).toBe(200);
    expect(JSON.parse(m.files.get(layout.registryFile)!)).toMatchObject({ nextPort: 8830, workspaces: { alpha: { status: "error", accountCreated: true, port: 8810 }, beta: { status: "running", port: 8820 } } });
    expect(m.files.get(layout.fenceFile)).toContain("omb-alpha");
    expect(await fleetRequest(socketPath, "POST", "/workspaces/alpha/users", { action: "add", email: "x@example.test" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("operator recovery") } });
  });

  it("tells the operator plainly when there is no agent to talk to", async () => {
    expect(fleetAvailable(join(root, "absent.sock"))).toBe(false);
    await expect(fleetRequest(join(root, "absent.sock"), "GET", "/workspaces")).rejects.toThrow("no fleet agent on this server");
    writeFileSync(join(root, "not-a-socket"), "");
    await expect(fleetRequest(join(root, "not-a-socket"), "GET", "/workspaces")).rejects.toThrow(/fleet agent|no fleet agent/);
  });

  it("reports unsafe usage as unavailable without failing the list or exposing ledger content", async () => {
    const m = machine(root);
    const entry = (slug: string, port: number) => ({ slug, host: `${slug}.agentada.cc`, port, webhookPort: port + 1, status: "running", createdAt: "" });
    m.files.set(fleetLayout(root).registryFile, JSON.stringify({ ...emptyRegistry("agentada.cc"), workspaces: { alpha: entry("alpha", 8810), beta: entry("beta", 8820) } }));
    m.deps.usage = (dataDir, owner, now) => {
      expect(owner).toBe(dataDir.includes("/alpha/") ? "omb-alpha" : "omb-beta");
      expect(now.toISOString()).toBe("2026-09-10T12:00:00.000Z");
      if (owner === "omb-alpha") throw new Error("unsafe fixture-secret ledger");
      return { turns: 2, costUsd: 0.5, billableUsd: null };
    };
    await boot(m);
    const listed = await fleetRequest(socketPath, "GET", "/workspaces");
    expect(listed).toMatchObject({ status: 200, body: { workspaces: [
      { slug: "alpha", usage: { month: "2026-09", turns: null, costUsd: null, billableUsd: null, unavailable: true } },
      { slug: "beta", usage: { month: "2026-09", turns: 2, costUsd: 0.5, billableUsd: null } },
    ] } });
    expect(JSON.stringify(listed)).not.toContain("fixture-secret");
    expect((await fleetRequest(socketPath, "GET", "/health")).status).toBe(200);
  });
});
