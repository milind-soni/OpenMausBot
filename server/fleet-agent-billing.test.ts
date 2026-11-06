import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetBillingReport } from "../shared/fleet-billing.ts";
import { startFleetAgent } from "./fleet-agent.ts";
import { fleetRequest } from "./fleet-client.ts";
import type { FleetDeps } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, parseRegistry, workspaceDataDir, type FleetRegistry, type FleetWorkspace } from "./fleet.ts";
import type { FleetReseller } from "./fleet-reseller.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { UsageRow, UsageTrigger } from "./usage-ledger.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const reseller: FleetReseller = { name: "Acme Cloud", currency: "USD", wholesale: { workspaceMonthMinor: 2000, userMonthMinor: 500 }, retail: { workspaceMonthMinor: 5000, userMonthMinor: 1500 } };
const workspace = (slug: string): FleetWorkspace => ({
  slug, host: `${slug}.example.test`, port: 8810, webhookPort: 8811, status: "running", createdAt: "2026-08-01T00:00:00.000Z", events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" }],
});
const row = (trigger: UsageTrigger): UsageRow => ({
  at: "2026-09-10T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd: 0.25, trigger,
});

describe.skipIf(process.platform === "win32")("fleet agent billing over its socket", () => {
  let root: string;
  let socketPath: string;
  let stop: (() => Promise<void>) | null = null;
  const layout = () => fleetLayout(root);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-fleet-agent-billing-"));
    socketPath = join(root, "fleet.sock");
  });
  afterEach(async () => {
    await stop?.();
    stop = null;
    await removeTempDir(root);
  });

  const ledger = (slug: string, rows: unknown[]) => {
    const directory = join(workspaceDataDir(layout(), slug), "usage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "2026-09.jsonl"), rows.map((item) => JSON.stringify(item)).join("\n") + "\n");
  };
  async function boot(options: Parameters<typeof fleetMachine>[1] = {}, registry: Partial<FleetRegistry> = {}, wrap: (deps: FleetDeps) => FleetDeps = (deps) => deps) {
    const machine = fleetMachine(root, options);
    machine.files.set(layout().registryFile, JSON.stringify({ ...emptyRegistry("example.test"), reseller, workspaces: { acme: workspace("acme"), beta: workspace("beta") }, ...registry }));
    const server = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/cli.js", root, deps: wrap(machine.deps), auditFile: join(root, "audit.jsonl"), now: () => NOW }, { log: () => {} });
    stop = () => new Promise((resolve) => server.close(() => resolve()));
    return machine;
  }
  const billing = async (query = "") => {
    const reply = await fleetRequest(socketPath, "GET", `/billing${query}`);
    return { status: reply.status, body: reply.body as FleetBillingReport & { error?: string } };
  };

  it("answers with counts only by default, and names people only when asked", async () => {
    ledger("acme", [row({ kind: "user", email: "ada@private.test" }), row({ kind: "user", label: "Bo's phone" }), row({ kind: "owner" })]);
    ledger("beta", [row({ kind: "owner" })]);
    await boot();
    const plain = await billing();
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ month: "2026-09", complete: true, final: false, currency: "USD", totals: { workspaces: 2, activeUsers: 2, wholesaleMinor: 5000, retailMinor: 13000, marginMinor: 8000 } });
    expect(plain.body.workspaces.map((line) => [line.slug, line.activeUsers, line.turns])).toEqual([["acme", 2, 3], ["beta", 0, 1]]);
    expect(JSON.stringify(plain.body)).not.toContain("private.test");
    expect(plain.body.workspaces.every((line) => line.users === undefined)).toBe(true);
    const detailed = await billing("?detail=true");
    expect(detailed.body.workspaces[0]!.users!.map((user) => user.id)).toEqual(["ada@private.test", "device:bo's phone"]);
    expect((await billing("?detail=1")).body.workspaces[0]!.users).toBeUndefined();
  });

  it("reads another month when asked, and refuses a malformed or future one", async () => {
    await boot();
    expect((await billing("?month=2026-08")).body).toMatchObject({ month: "2026-08", final: true });
    for (const month of ["2026-13", "2026-9", "next", "2026-10"]) {
      const reply = await billing(`?month=${month}`);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toMatch(/YYYY-MM|has not started/);
    }
  });

  it("keeps one workspace's failure from failing the others", async () => {
    ledger("beta", [row({ kind: "user", email: "bo@x.test" })]);
    await boot({ unmeterable: ["omb-acme"] });
    const reply = await billing();
    expect(reply.status).toBe(200);
    expect(reply.body.complete).toBe(false);
    const [acme, beta] = reply.body.workspaces;
    expect(acme).toMatchObject({ slug: "acme", ledger: "unavailable", unavailableReason: "unsafe workspace file or directory", activeUsers: null, turns: null, wholesale: { totalMinor: null }, marginMinor: null });
    expect(beta).toMatchObject({ slug: "beta", ledger: "ok", activeUsers: 1, wholesale: { totalMinor: 2500 }, retail: { totalMinor: 6500 } });
    expect(reply.body.totals).toEqual({ workspaces: 2, activeUsers: null, wholesaleMinor: null, retailMinor: null, marginMinor: null });
  });

  it("needs no licence state: the socket's permissions are the gate", async () => {
    await boot({ features: [] });
    expect((await billing()).status).toBe(200);
  });

  it("says so when the fleet has no reseller, and when there is no fleet", async () => {
    await boot({}, { reseller: undefined });
    const reply = await billing();
    expect(reply.status).toBe(409);
    expect(reply.body.error).toContain("no reseller");
    await stop?.();
    stop = null;
    const bare = fleetMachine(root);
    const server = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/cli.js", root, deps: bare.deps, auditFile: join(root, "audit.jsonl"), now: () => NOW }, { log: () => {} });
    stop = () => new Promise((resolve) => server.close(() => resolve()));
    expect((await billing()).status).toBe(500);
  });

  it("refuses other methods on the billing path", async () => {
    await boot();
    expect((await fleetRequest(socketPath, "POST", "/billing", {})).status).toBe(404);
    expect((await fleetRequest(socketPath, "DELETE", "/billing")).status).toBe(404);
  });

  it("audits each read without a person's address", async () => {
    ledger("acme", [row({ kind: "user", email: "ada@private.test" })]);
    await boot();
    await billing("?detail=true&month=2026-09");
    await billing("?month=bad");
    const lines = readFileSync(join(root, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { at: NOW.toISOString(), action: "billing", month: "2026-09", ok: true },
      { at: NOW.toISOString(), action: "billing", month: "bad", ok: false },
    ]);
    expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain("private.test");
  });

  describe("deleting a workspace", () => {
    const closing = (slug: string) => join(layout().billingDir, "closing", `${slug}@2026-08-01T00:00:00.000Z.json`);

    it("writes the closing snapshot first, and the report keeps the workspace afterwards", async () => {
      ledger("acme", [row({ kind: "user", email: "ada@private.test" })]);
      const steps: string[] = [];
      const machine = await boot({ beforeRun: async (argv) => { if (argv[0] === "userdel") steps.push(`userdel snapshot=${machine.files.has(closing("acme"))}`); } });
      const gone = await fleetRequest(socketPath, "DELETE", "/workspaces/acme", {});
      expect(gone.status).toBe(200);
      expect(steps).toEqual(["userdel snapshot=true"]);
      expect(JSON.parse(machine.files.get(closing("acme"))!).workspace).toMatchObject({ status: "deleted", activeUsers: 1 });
      expect(parseRegistry(machine.files.get(layout().registryFile)!).workspaces).not.toHaveProperty("acme");
      const after = await billing();
      expect(after.body.workspaces.map((line) => [line.slug, line.status])).toEqual([["acme", "deleted"], ["beta", "running"]]);
      expect(after.body.totals).toMatchObject({ workspaces: 2, activeUsers: 1 });
      expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain("private.test");
    });

    it("does not delete when the snapshot cannot be written", async () => {
      ledger("acme", [row({ kind: "user", email: "ada@private.test" })]);
      const machine = await boot({}, {}, (deps) => ({ ...deps, writeText: (path, content, mode, owner) => { if (path.includes("closing")) throw new Error("disk full"); deps.writeText(path, content, mode, owner); } }));
      const reply = await fleetRequest(socketPath, "DELETE", "/workspaces/acme", {});
      expect(reply.status).toBe(400);
      expect((reply.body as { error: string }).error).toContain("the workspace was not deleted");
      expect(machine.calls.filter((call) => /^(systemctl|userdel|nft)/.test(call))).toEqual([]);
      expect(parseRegistry(machine.files.get(layout().registryFile)!).workspaces).toHaveProperty("acme");
      expect(readFileSync(join(root, "audit.jsonl"), "utf8")).toContain('"ok":false');
    });

    it("keeps a retired workspace's data and takes no snapshot, because its ledger stays readable", async () => {
      const machine = await boot();
      expect((await fleetRequest(socketPath, "DELETE", "/workspaces/acme", { keepData: true })).status).toBe(200);
      expect([...machine.files.keys()].filter((path) => path.includes("closing"))).toEqual([]);
      const retained = parseRegistry(machine.files.get(layout().registryFile)!).workspaces.acme!;
      expect(retained.status).toBe("retained");
      expect(retained.events!.at(-1)).toMatchObject({ status: "retained" });
    });
  });

  it("records the status changes billing reads, through the real planners", async () => {
    const machine = await boot();
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/suspend")).status).toBe(200);
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/resume")).status).toBe(200);
    expect(parseRegistry(machine.files.get(layout().registryFile)!).workspaces.acme!.events!.map((event) => event.status)).toEqual(["running", "suspended", "running"]);
  });
});
