// Two isolated fake-engine workspaces book real ledger rows; the fleet reads copies of them through the real privilege-dropped helper. No live account, engine or licence.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { buildBillingReport } from "./fleet-billing.ts";
import { defaultFleetDeps, runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, workspaceDataDir, workspaceHome, type FleetRegistry } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { monthKey } from "./usage-ledger.ts";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options: Parameters<typeof actual.execFileSync>[2]) => {
      // Only account discovery is synthetic: each workspace's home is a disposable folder owned by this user.
      if (command === "/usr/bin/getent") {
        const owner = args[1]!;
        return `${owner}:x:${process.getuid!()}:${process.getgid!()}:fixture:${join(fixture.root, "var/lib/openmausbot", owner.replace(/^omb-/, ""))}:/usr/sbin/nologin\n`;
      }
      return actual.execFileSync(command, args, options);
    },
  };
});

const RATES = { wholesale: { workspaceMonthMinor: 2000, userMonthMinor: 500 }, retail: { workspaceMonthMinor: 5000, userMonthMinor: 1500 } };

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fleet billing from real workspace ledgers", () => {
  let layerDir: string;
  let root: string;
  let acme: VerificationServer;
  let beta: VerificationServer;
  let month: string;
  const savedLayer = process.env.OMB_ENTERPRISE_DIR;

  const api = (server: VerificationServer, path: string, init: RequestInit = {}) => fetch(`${server.info.url}${path}`, init);
  const control = (server: VerificationServer, args: string[]) => runControlOmb([...args, "--url", server.info.url]) as Promise<any>;
  const post = (body: unknown, token?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const pair = async (server: VerificationServer, label: string) => {
    const opened = (await (await api(server, "/api/auth/pairing", post({}))).json()) as { code: string };
    return ((await (await api(server, "/api/auth/pair", post({ code: opened.code, label }))).json()) as { token: string }).token;
  };
  const settle = async (server: VerificationServer, botId: string) => {
    expect(JSON.stringify(await control(server, ["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
  };
  const ask = async (server: VerificationServer, botId: string, text: string, token?: string) => {
    const response = await api(server, `/api/bots/${encodeURIComponent(botId)}/messages`, post({ text }, token));
    expect([200, 201, 202]).toContain(response.status);
    await settle(server, botId);
  };
  const oracle = async (server: VerificationServer) => (await (await api(server, "/api/usage?groupBy=user")).json()) as { groups: { key: string; turns: number; costUsd: number | null }[]; total: { turns: number; costUsd: number | null } };

  beforeAll(async () => {
    layerDir = mkdtempSync(join(tmpdir(), "omb-billing-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Reseller", features: ["whitelabel", "admin", "billing"], expiresAt: "2099-01-01" }; }\n');
    const enterprise = { dir: layerDir, licenseKey: "fixture-key" };
    [acme, beta] = await Promise.all([launchVerificationServer(process.env, undefined, undefined, undefined, enterprise), launchVerificationServer(process.env, undefined, undefined, undefined, enterprise)]);

    const acmeBot = (await control(acme, ["new-bot", "--name", "Acme probe"])).bot.id as string;
    await ask(acme, acmeBot, "hello from the owner");
    await ask(acme, acmeBot, "hello from Ada's phone", await pair(acme, "Ada's phone"));
    await ask(acme, acmeBot, "hello from Bo's tablet", await pair(acme, "Bo's tablet"));
    const betaBot = (await control(beta, ["new-bot", "--name", "Beta probe"])).bot.id as string;
    await ask(beta, betaBot, "hello from the beta owner");

    month = monthKey(new Date());
    root = realpathSync(mkdtempSync(join(tmpdir(), "omb-billing-fleet-")));
    fixture.root = root;
    const layout = fleetLayout(root);
    mkdirSync(join(root, "etc", "openmausbot"), { recursive: true });
    const workspaces = Object.fromEntries([["acme", acme], ["beta", beta]].map(([slug, server], index) => {
      const home = workspaceHome(layout, slug as string);
      const usage = join(workspaceDataDir(layout, slug as string), "usage");
      mkdirSync(usage, { recursive: true, mode: 0o700 });
      copyFileSync(join((server as VerificationServer).info.dataDir, "usage", `${month}.jsonl`), join(usage, `${month}.jsonl`));
      expect(home.startsWith(root)).toBe(true);
      return [slug, { slug, host: `${slug}.example.test`, port: 8810 + index * 2, webhookPort: 8811 + index * 2, status: "running", createdAt: "2026-01-01T00:00:00.000Z", events: [{ at: "2026-01-01T00:00:00.000Z", status: "running" }] }];
    })) as FleetRegistry["workspaces"];
    writeFileSync(join(workspaceDataDir(layout, "acme"), "config.json"), JSON.stringify({ signIn: { admins: ["owner@acme.test"], members: ["@acme.test"] } }));
    writeFileSync(layout.registryFile, JSON.stringify({ ...emptyRegistry("example.test"), reseller: { name: "Fixture Reseller", currency: "USD", ...RATES }, workspaces }, null, 2));
  }, 240_000);

  afterAll(async () => {
    if (savedLayer === undefined) delete process.env.OMB_ENTERPRISE_DIR; else process.env.OMB_ENTERPRISE_DIR = savedLayer;
    for (const server of [acme, beta]) if (server) { console.info(JSON.stringify(server.info)); await server.close(); }
    await Promise.all([layerDir, root].map((path) => (path ? removeTempDir(path) : undefined)));
  });

  const input = (overrides: Partial<FleetInput> = {}): FleetInput => ({
    action: "billing", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: process.execPath, script: "/cli.js", get root() { return root; }, licenseKey: "fixture-key", ...overrides,
  });
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err };
  };
  const report = () => {
    const layout = fleetLayout(root);
    return buildBillingReport({ registry: JSON.parse(readFileSync(layout.registryFile, "utf8")), layout, deps: defaultFleetDeps(), month, detail: true, now: new Date() });
  };

  it("names the same people as the workspace's own usage report, counts the owner as no one, and prices from the rate card", async () => {
    const [acmeOracle, betaOracle] = await Promise.all([oracle(acme), oracle(beta)]);
    const acmePeople = acmeOracle.groups.filter((group) => group.key.startsWith("user:"));
    expect(acmePeople.map((group) => group.key).sort()).toEqual(["user:ada's phone", "user:bo's tablet"]);
    expect(acmeOracle.groups.map((group) => group.key)).toContain("owner");
    expect(betaOracle.groups.filter((group) => group.key.startsWith("user:"))).toEqual([]);

    const result = await report();
    const [lineAcme, lineBeta] = result.workspaces;
    expect(result).toMatchObject({ complete: true, final: false, month, currency: "USD", basis: "tenant-reported-ledger" });
    expect(lineAcme).toMatchObject({ slug: "acme", ledger: "ok", billable: true, billableReason: "running", turns: acmeOracle.total.turns, activeUsers: 2, provisionedSeats: { emails: 1, domains: 1 } });
    expect(lineAcme!.users!.map((user) => `user:${user.id.replace(/^device:/, "")}`).sort()).toEqual(acmePeople.map((group) => group.key).sort());
    for (const user of lineAcme!.users!) {
      const group = acmePeople.find((entry) => entry.key === `user:${user.id.replace(/^device:/, "")}`)!;
      expect({ attributed: user.attributed, costUsd: user.costUsd }).toEqual({ attributed: group.turns, costUsd: group.costUsd });
      expect(user).toMatchObject({ kind: "device", asked: 1 });
    }
    expect(lineAcme!.costUsd).toBeCloseTo(acmeOracle.total.costUsd!, 9);
    expect(lineBeta).toMatchObject({ slug: "beta", ledger: "ok", billable: true, billableReason: "running", turns: betaOracle.total.turns, activeUsers: 0, users: [] });

    expect(lineAcme!.wholesale).toEqual({ workspaceMinor: 2000, usersMinor: 1000, totalMinor: 3000 });
    expect(lineAcme!.retail).toEqual({ workspaceMinor: 5000, usersMinor: 3000, totalMinor: 8000 });
    expect(lineBeta!.wholesale).toEqual({ workspaceMinor: 2000, usersMinor: 0, totalMinor: 2000 });
    expect(lineBeta!.retail).toEqual({ workspaceMinor: 5000, usersMinor: 0, totalMinor: 5000 });
    expect(result.totals).toEqual({ workspaces: 2, activeUsers: 2, wholesaleMinor: 5000, retailMinor: 13000, marginMinor: 8000 });
  }, 60_000);

  it("prints the whole fleet billing command: text, then CSV with one line per workspace, behind the licence check", async () => {
    process.env.OMB_ENTERPRISE_DIR = layerDir;
    const text = capture();
    expect(await runFleetCommand(input(), text.io, defaultFleetDeps())).toBe(0);
    expect(text.err).toEqual([]);
    expect(text.out.join("\n")).toMatch(/acme\s+acme\.example\.test\s+running\s+yes \(running\)\s+2\s+\d+\s+[\d.]+\s+30\.00\s+80\.00\s+50\.00/);
    expect(text.out.join("\n")).toContain("evidence, not enforcement");

    const csv = capture();
    expect(await runFleetCommand(input({ csv: true }), csv.io, defaultFleetDeps())).toBe(0);
    const lines = csv.out.join("\n").trimEnd().split("\n");
    expect(lines.filter((line) => line.split(",")[1] === "workspace")).toHaveLength(2);
    expect(lines).toContain(`${month},workspace,beta,beta.example.test,,,,${(await oracle(beta)).total.turns},${(await oracle(beta)).total.costUsd},true,ok,2000,5000,3000,USD`);
    expect(lines.at(-1)).toMatch(new RegExp(`^${month},total,,,,,,\\d+,[\\d.]+,,ok,5000,13000,8000,USD$`));
  }, 60_000);

  it("refuses without the admin and billing features, through the real enterprise loader", async () => {
    const partial = mkdtempSync(join(tmpdir(), "omb-billing-partial-layer-"));
    try {
      mkdirSync(join(partial, "server"));
      writeFileSync(join(partial, "server", "index.js"), 'export async function register() { return { customer: "Fixture", features: ["billing"], expiresAt: "2099-01-01" }; }\n');
      process.env.OMB_ENTERPRISE_DIR = partial;
      const out = capture();
      expect(await runFleetCommand(input(), out.io, defaultFleetDeps())).toBe(2);
      expect(out.err.join("\n")).toContain("missing: admin");
      expect(out.out).toEqual([]);
      process.env.OMB_ENTERPRISE_DIR = join(partial, "none");
      const none = capture();
      expect(await runFleetCommand(input({ licenseKey: undefined }), none.io, defaultFleetDeps())).toBe(2);
      expect(none.err.join("\n")).toContain("missing: admin, billing");
    } finally { await removeTempDir(partial); }
  }, 60_000);
});
