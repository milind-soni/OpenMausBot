import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFleetAgent } from "./fleet-agent.ts";
import { fleetAvailable, fleetRequest } from "./fleet-client.ts";
import type { FleetDeps } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { appendUsage, flushUsageLedger } from "./usage-ledger.ts";

// A machine that records what the agent does to it, with a real temp root
// for the files the agent reads back (registry, ledgers). No systemd, nft,
// Caddy or user accounts are touched.
function machine(root: string, options: { failing?: string[] } = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const deps: FleetDeps = {
    isRoot: () => true,
    run: async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "systemctl" && argv[1] === "is-active") return { code: 0, output: "active\n" };
      return options.failing?.some((prefix) => argv.join(" ").startsWith(prefix)) ? { code: 1, output: "unit failed: secret-token\n" } : { code: 0, output: "" };
    },
    readText: (path) => files.get(path) ?? (path.endsWith("fleet.json") ? null : null),
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

  it("creates, lists with this month's usage, edits users, suspends, deletes, and audits every action", async () => {
    const m = machine(root);
    const layout = fleetLayout(root);
    m.files.set(layout.registryFile, JSON.stringify({ ...emptyRegistry("agentada.cc"), operator: "maus" }));
    const logs = await boot(m);
    expect(logs[0]).toContain("fleet agent listening");
    expect(fleetAvailable(socketPath)).toBe(true);
    // the socket itself is the authorisation: owner and group only
    if (process.platform !== "win32") expect(statSync(socketPath).mode & 0o777).toBe(0o660);

    const created = await fleetRequest(socketPath, "POST", "/workspaces", { slug: "acme", admins: ["ada@example.test"], members: ["@acme.test"], cap: 40, anthropicKey: "sk-ant-fixture", brandJson: '{"name":"Acme"}' });
    expect(created).toMatchObject({ status: 200, body: { ok: true, log: [expect.stringContaining("https://acme.agentada.cc is ready")] } });
    expect(m.calls).toContain("useradd --system --create-home --home-dir " + join(root, "var/lib/openmausbot/acme") + " --shell /usr/sbin/nologin --user-group omb-acme");
    expect(JSON.parse(m.files.get(join(root, "var/lib/openmausbot/acme/.openmausbot/config.json"))!)).toMatchObject({ anthropic: { key: "sk-ant-fixture" }, budgets: { monthlyUsd: 40 } });
    expect(m.files.get(join(root, "etc/openmausbot/instances/acme.env"))).toContain("OMB_LICENSE_KEY=omb1.k");

    // The workspace's own ledger, as its server would write it; the agent reads it as root.
    const dataDir = join(root, "var/lib/openmausbot/acme/.openmausbot");
    mkdirSync(dataDir, { recursive: true });
    appendUsage(dataDir, { at: "2026-09-03T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd: 0.25, trigger: { kind: "owner" } });
    appendUsage(dataDir, { at: "2026-08-03T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd: 9, trigger: { kind: "owner" } });
    await flushUsageLedger(dataDir);
    const listed = await fleetRequest(socketPath, "GET", "/workspaces");
    expect(listed).toMatchObject({ status: 200, body: { domain: "agentada.cc", operator: "maus", workspaces: [{ slug: "acme", host: "acme.agentada.cc", port: 8810, live: "active", usage: { month: "2026-09", turns: 1, costUsd: 0.25 } }] } });

    const added = await fleetRequest(socketPath, "POST", "/workspaces/acme/users", { action: "add", email: "bob@acme.test", chatOnly: true });
    expect(added.status).toBe(200);
    expect(JSON.parse(m.files.get(join(dataDir, "config.json"))!).signIn).toEqual({ admins: ["ada@example.test"], members: ["@acme.test", "bob@acme.test"] });
    expect(await fleetRequest(socketPath, "POST", "/workspaces/acme/users", { action: "remove", email: "nobody@acme.test" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("not on the list") } });

    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/suspend")).status).toBe(200);
    expect(m.calls).toContain("systemctl disable --now openmausbot@acme.service");
    expect((await fleetRequest(socketPath, "DELETE", "/workspaces/acme", { keepData: true })).status).toBe(200);
    expect(m.calls).toContain("userdel omb-acme");
    expect(await fleetRequest(socketPath, "GET", "/workspaces")).toMatchObject({ status: 200, body: { workspaces: [] } });

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
    expect(m.files.get(fleetLayout(root).registryFile)).toBe(JSON.stringify(emptyRegistry("agentada.cc")));
  });

  it("tells the operator plainly when there is no agent to talk to", async () => {
    expect(fleetAvailable(join(root, "absent.sock"))).toBe(false);
    await expect(fleetRequest(join(root, "absent.sock"), "GET", "/workspaces")).rejects.toThrow("no fleet agent on this server");
    writeFileSync(join(root, "not-a-socket"), "");
    await expect(fleetRequest(join(root, "not-a-socket"), "GET", "/workspaces")).rejects.toThrow(/fleet agent|no fleet agent/);
  });
});
