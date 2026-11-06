import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingCsv, billingMonth, billingText, buildBillingReport, isBillableWorkspace, planFleetRates, priceWorkspace, runFleetBilling, snapshotBeforeDelete } from "./fleet-billing.ts";
import { runFleetCommand, type FleetDeps, type FleetInput } from "./fleet-cli.ts";
import { emptyRegistry, fleetLayout, parseRegistry, workspaceDataDir, type FleetRegistry, type FleetWorkspace } from "./fleet.ts";
import type { FleetReseller } from "./fleet-reseller.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { UsageRow, UsageTrigger } from "./usage-ledger.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const reseller: FleetReseller = { name: "Acme Cloud", currency: "USD", wholesale: { workspaceMonthMinor: 2000, userMonthMinor: 500 }, retail: { workspaceMonthMinor: 5000, userMonthMinor: 1500 } };

const workspace = (slug: string, overrides: Partial<FleetWorkspace> = {}): FleetWorkspace => ({
  slug, host: `${slug}.example.test`, port: 8810, webhookPort: 8811, status: "running", createdAt: "2026-08-01T00:00:00.000Z",
  events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" }], ...overrides,
});

const row = (trigger: UsageTrigger, overrides: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-09-10T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m",
  input: 10, output: 5, costUsd: 0.25, trigger, ...overrides,
});

describe("billingMonth", () => {
  it("defaults to the current UTC month, even a few minutes after midnight", () => {
    expect(billingMonth(undefined, NOW)).toBe("2026-09");
    expect(billingMonth(undefined, new Date("2026-09-30T23:59:59.999Z"))).toBe("2026-09");
    expect(billingMonth(undefined, new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10");
  });

  it("accepts this month and any month before it", () => {
    expect(billingMonth("2026-09", NOW)).toBe("2026-09");
    expect(billingMonth("2025-12", NOW)).toBe("2025-12");
  });

  it.each(["2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", "September", "", " 2026-09"])("rejects %j", (raw) => {
    expect(() => billingMonth(raw, NOW)).toThrow("YYYY-MM");
  });

  it("rejects a month that has not started", () => {
    expect(() => billingMonth("2026-10", NOW)).toThrow("has not started");
    expect(() => billingMonth("2027-01", NOW)).toThrow("has not started");
  });
});

describe("which workspaces are billable", () => {
  const events = (...list: [string, FleetWorkspace["status"]][]): Partial<FleetWorkspace> => ({ events: list.map(([at, status]) => ({ at, status })) });
  const billable = (w: FleetWorkspace, usage = false, month = "2026-09") => isBillableWorkspace(w, month, usage);

  it.each<[string, FleetWorkspace, boolean, { billable: boolean; reason: string }]>([
    ["running with no usage", workspace("a"), false, { billable: true, reason: "running" }],
    ["running with usage", workspace("a"), true, { billable: true, reason: "running" }],
    ["suspended all month with no usage", workspace("a", { status: "suspended", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-15T00:00:00.000Z", "suspended"]) }), false, { billable: false, reason: "none" }],
    ["suspended all month with usage", workspace("a", { status: "suspended", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-15T00:00:00.000Z", "suspended"]) }), true, { billable: true, reason: "usage" }],
    ["retained with usage", workspace("a", { status: "retained", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-15T00:00:00.000Z", "retained"]) }), true, { billable: true, reason: "usage" }],
    ["retained with none", workspace("a", { status: "retained", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-15T00:00:00.000Z", "retained"]) }), false, { billable: false, reason: "none" }],
    ["still provisioning", workspace("a", { status: "provisioning", events: undefined }), false, { billable: false, reason: "none" }],
    ["failed to provision", workspace("a", { status: "error", events: undefined }), false, { billable: false, reason: "none" }],
    ["created after the month ended", workspace("a", { createdAt: "2026-10-02T00:00:00.000Z", ...events(["2026-10-02T00:00:00.000Z", "running"]) }), false, { billable: false, reason: "none" }],
    ["suspended on the 10th, so it ran earlier in the month", workspace("a", { status: "suspended", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-09-10T00:00:00.000Z", "suspended"]) }), false, { billable: true, reason: "running" }],
    ["resumed on the 25th, so it ran at the end of the month", workspace("a", { ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-05T00:00:00.000Z", "suspended"], ["2026-09-25T00:00:00.000Z", "running"]) }), false, { billable: true, reason: "running" }],
    ["suspended exactly at the first instant", workspace("a", { status: "suspended", ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-09-01T00:00:00.000Z", "suspended"]) }), false, { billable: false, reason: "none" }],
    ["resumed exactly at the next month's first instant", workspace("a", { ...events(["2026-08-01T00:00:00.000Z", "running"], ["2026-08-05T00:00:00.000Z", "suspended"], ["2026-10-01T00:00:00.000Z", "running"]) }), false, { billable: false, reason: "none" }],
    ["created in the middle of the month", workspace("a", { createdAt: "2026-09-18T00:00:00.000Z", ...events(["2026-09-18T00:00:00.000Z", "running"]) }), false, { billable: true, reason: "running" }],
  ])("%s", (_name, w, usage, expected) => {
    expect(billable(w, usage)).toEqual(expected);
  });

  it("reads events in time order whatever order they were stored in", () => {
    const shuffled = workspace("a", { status: "suspended", ...events(["2026-09-10T00:00:00.000Z", "suspended"], ["2026-08-01T00:00:00.000Z", "running"]) });
    expect(billable(shuffled)).toEqual({ billable: true, reason: "running" });
    expect(billable(shuffled, false, "2026-10")).toEqual({ billable: false, reason: "none" });
  });

  it("falls back to the current status and creation time when a registry has no events", () => {
    const legacy = (status: FleetWorkspace["status"], createdAt: string) => workspace("a", { status, createdAt, events: undefined });
    expect(billable(legacy("running", "2026-08-01T00:00:00.000Z"))).toEqual({ billable: true, reason: "running" });
    expect(billable(legacy("running", "2026-10-01T00:00:00.000Z"))).toEqual({ billable: false, reason: "none" });
    expect(billable(legacy("running", ""))).toEqual({ billable: true, reason: "running" });
    expect(billable(legacy("suspended", "2026-08-01T00:00:00.000Z"))).toEqual({ billable: false, reason: "none" });
    expect(billable(legacy("suspended", "2026-08-01T00:00:00.000Z"), true)).toEqual({ billable: true, reason: "usage" });
  });
});

describe("prices", () => {
  const w = workspace("acme");

  it("charges the workspace once and each user, in whole minor units", () => {
    expect(priceWorkspace({ reseller, workspace: w, billable: true, users: 3 })).toEqual({
      wholesale: { workspaceMinor: 2000, usersMinor: 1500, totalMinor: 3500 },
      retail: { workspaceMinor: 5000, usersMinor: 4500, totalMinor: 9500 },
      marginMinor: 6000,
    });
  });

  it("charges nothing for a workspace that is not billable", () => {
    expect(priceWorkspace({ reseller, workspace: w, billable: false, users: 0 })).toEqual({
      wholesale: { workspaceMinor: 0, usersMinor: 0, totalMinor: 0 },
      retail: { workspaceMinor: 0, usersMinor: 0, totalMinor: 0 },
      marginMinor: 0,
    });
  });

  it("charges a billable workspace with no users the workspace rate alone", () => {
    expect(priceWorkspace({ reseller, workspace: w, billable: true, users: 0 })).toMatchObject({ wholesale: { totalMinor: 2000 }, retail: { totalMinor: 5000 }, marginMinor: 3000 });
  });

  it("lets a retail override replace one field or both, never touching wholesale", () => {
    const only = priceWorkspace({ reseller, workspace: { ...w, retailOverride: { userMonthMinor: 1000 } }, billable: true, users: 2 });
    expect(only.retail).toEqual({ workspaceMinor: 5000, usersMinor: 2000, totalMinor: 7000 });
    expect(only.wholesale.totalMinor).toBe(3000);
    const workspaceOnly = priceWorkspace({ reseller, workspace: { ...w, retailOverride: { workspaceMonthMinor: 0 } }, billable: true, users: 2 });
    expect(workspaceOnly.retail).toEqual({ workspaceMinor: 0, usersMinor: 3000, totalMinor: 3000 });
    const both = priceWorkspace({ reseller, workspace: { ...w, retailOverride: { workspaceMonthMinor: 100, userMonthMinor: 50 } }, billable: true, users: 2 });
    expect(both.retail.totalMinor).toBe(200);
    expect(both.marginMinor).toBe(200 - 3000);
  });

  it("goes negative when the reseller sells below cost", () => {
    expect(priceWorkspace({ reseller, workspace: { ...w, retailOverride: { workspaceMonthMinor: 0, userMonthMinor: 0 } }, billable: true, users: 1 }).marginMinor).toBe(-2500);
  });

  it("leaves the user figures unknown when the head count is", () => {
    expect(priceWorkspace({ reseller, workspace: w, billable: true, users: null })).toEqual({
      wholesale: { workspaceMinor: 2000, usersMinor: null, totalMinor: null },
      retail: { workspaceMinor: 5000, usersMinor: null, totalMinor: null },
      marginMinor: null,
    });
  });

  it("refuses an amount beyond exact integer range instead of rounding it", () => {
    const huge: FleetReseller = { ...reseller, wholesale: { workspaceMonthMinor: 0, userMonthMinor: Number.MAX_SAFE_INTEGER } };
    expect(() => priceWorkspace({ reseller: huge, workspace: w, billable: true, users: 2 })).toThrow("too large");
  });
});

describe("the report", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omb-fleet-billing-")); });
  afterEach(async () => { await removeTempDir(root); });

  const layout = () => fleetLayout(root);
  const ledger = (slug: string, rows: unknown[]) => {
    const directory = join(workspaceDataDir(layout(), slug), "usage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "2026-09.jsonl"), rows.map((item) => JSON.stringify(item)).join("\n") + "\n");
  };
  const registryOf = (workspaces: FleetWorkspace[], overrides: Partial<FleetRegistry> = {}): FleetRegistry => ({
    ...emptyRegistry("example.test"), reseller, workspaces: Object.fromEntries(workspaces.map((item) => [item.slug, item])), ...overrides,
  });
  const fleet = (workspaces: FleetWorkspace[], options: Parameters<typeof fleetMachine>[1] = {}) => {
    const machine = fleetMachine(root, options);
    machine.files.set(layout().registryFile, JSON.stringify(registryOf(workspaces)));
    return machine;
  };
  const build = (machine: ReturnType<typeof fleetMachine>, detail = false, month = "2026-09") =>
    buildBillingReport({ registry: parseRegistry(machine.files.get(layout().registryFile)!), layout: layout(), deps: machine.deps, month, detail, now: NOW });

  const world = [
    workspace("acme", { retailOverride: { userMonthMinor: 1000 } }),
    workspace("beta", { createdAt: "2026-09-05T00:00:00.000Z", events: [{ at: "2026-09-05T00:00:00.000Z", status: "running" }] }),
    workspace("gamma", { status: "suspended", events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" }, { at: "2026-08-10T00:00:00.000Z", status: "suspended" }] }),
    workspace("delta", { status: "suspended", events: [{ at: "2026-08-01T00:00:00.000Z", status: "running" }, { at: "2026-08-10T00:00:00.000Z", status: "suspended" }] }),
    workspace("eps", { status: "error", events: undefined, createdAt: "2026-09-02T00:00:00.000Z" }),
  ];
  const seedLedgers = () => {
    ledger("acme", [
      row({ kind: "user", email: "ada@x.test" }), row({ kind: "user", email: "Ada@X.test" }), row({ kind: "user", label: "Bo's phone" }),
      row({ kind: "owner" }), row({ kind: "routine", routineId: "r", email: "ada@x.test" }, { costUsd: 0.5 }),
      row({ kind: "user", email: "old@x.test" }, { at: "2026-08-31T23:59:59.999Z" }),
    ]);
    ledger("delta", [row({ kind: "user", email: "dee@x.test" })]);
  };

  it("prices every workspace from its own ledger and sums exactly the lines it prints", async () => {
    seedLedgers();
    const report = await build(fleet(world));
    const by = Object.fromEntries(report.workspaces.map((line) => [line.slug, line]));
    expect(report).toMatchObject({ version: 1, reseller: { name: "Acme Cloud" }, month: "2026-09", currency: "USD", final: false, basis: "tenant-reported-ledger", complete: true, generatedAt: NOW.toISOString() });
    expect(by.acme).toMatchObject({ workspaceId: "acme@2026-08-01T00:00:00.000Z", billable: true, billableReason: "running", ledger: "ok", turns: 5, activeUsers: 2, costUsd: 1.5,
      wholesale: { workspaceMinor: 2000, usersMinor: 1000, totalMinor: 3000 }, retail: { workspaceMinor: 5000, usersMinor: 2000, totalMinor: 7000 }, marginMinor: 4000 });
    expect(by.beta).toMatchObject({ billable: true, billableReason: "running", turns: 0, activeUsers: 0, wholesale: { totalMinor: 2000 }, retail: { totalMinor: 5000 }, marginMinor: 3000 });
    expect(by.gamma).toMatchObject({ billable: false, billableReason: "none", activeUsers: 0, wholesale: { totalMinor: 0 }, marginMinor: 0 });
    expect(by.delta).toMatchObject({ billable: true, billableReason: "usage", activeUsers: 1, wholesale: { totalMinor: 2500 }, retail: { totalMinor: 6500 } });
    expect(by.eps).toMatchObject({ billable: false, ledger: "ok", turns: 0, activeUsers: 0, provisionedSeats: { emails: 0, domains: 0 } });
    expect(report.workspaces.map((line) => line.slug)).toEqual(["acme", "beta", "delta", "eps", "gamma"]);
    expect(report.totals).toEqual({
      workspaces: 5, activeUsers: 3,
      wholesaleMinor: report.workspaces.reduce((total, line) => total + line.wholesale.totalMinor!, 0),
      retailMinor: report.workspaces.reduce((total, line) => total + line.retail.totalMinor!, 0),
      marginMinor: report.workspaces.reduce((total, line) => total + line.marginMinor!, 0),
    });
    expect(report.totals).toMatchObject({ wholesaleMinor: 7500, retailMinor: 18500, marginMinor: 11000 });
    expect(report.workspaces.every((line) => line.users === undefined)).toBe(true);
  });

  it("never reads the ledger of a reservation that never served", async () => {
    seedLedgers();
    const machine = fleet(world);
    await build(machine);
    expect(machine.calls.filter((call) => call.startsWith("people")).map((call) => call.split(" ").at(-1))).toEqual(["omb-acme", "omb-beta", "omb-delta", "omb-gamma"]);
  });

  it("lists each person under --detail, busiest first", async () => {
    seedLedgers();
    const acme = (await build(fleet(world), true)).workspaces.find((line) => line.slug === "acme")!;
    expect(acme.users).toEqual([
      { id: "ada@x.test", kind: "email", asked: 2, attributed: 3, costUsd: 1 },
      { id: "device:bo's phone", kind: "device", asked: 1, attributed: 1, costUsd: 0.25 },
    ]);
  });

  it("reports provisioned seats from the sign-in lists, separately from who actually asked", async () => {
    const machine = fleet(world);
    machine.files.set(join(workspaceDataDir(layout(), "beta"), "config.json"), JSON.stringify({ signIn: { admins: ["a@x.test"], members: ["b@x.test", "@acme.test"] } }));
    const beta = (await build(machine)).workspaces.find((line) => line.slug === "beta")!;
    expect(beta).toMatchObject({ activeUsers: 0, provisionedSeats: { emails: 2, domains: 1 }, wholesale: { totalMinor: 2000 } });
  });

  it("marks a workspace whose ledger cannot be read as unavailable, never as zero, and leaves dependent totals unknown", async () => {
    seedLedgers();
    const report = await build(fleet(world, { unmeterable: ["omb-acme"] }));
    const acme = report.workspaces.find((line) => line.slug === "acme")!;
    expect(acme).toMatchObject({
      ledger: "unavailable", unavailableReason: "unsafe workspace file or directory", turns: null, costUsd: null, activeUsers: null, provisionedSeats: null,
      wholesale: { usersMinor: null, totalMinor: null }, retail: { usersMinor: null, totalMinor: null }, marginMinor: null,
    });
    expect(report.complete).toBe(false);
    expect(report.totals).toEqual({ workspaces: 5, activeUsers: null, wholesaleMinor: null, retailMinor: null, marginMinor: null });
    expect(report.workspaces.filter((line) => line.slug !== "acme").every((line) => line.ledger === "ok" && line.marginMinor !== null)).toBe(true);
  });

  it("treats a missing people capability as every ledger unavailable", async () => {
    const machine = fleet(world);
    const report = await buildBillingReport({ registry: registryOf(world), layout: layout(), deps: { ...machine.deps, people: undefined }, month: "2026-09", detail: false, now: NOW });
    expect(report.complete).toBe(false);
    expect(report.workspaces.filter((line) => line.ledger === "unavailable").map((line) => line.slug)).toEqual(["acme", "beta", "delta", "gamma"]);
  });

  it("is final once the month is over, and still prices a past month from the same ledgers", async () => {
    seedLedgers();
    const machine = fleet(world);
    const september = await buildBillingReport({ registry: registryOf(world), layout: layout(), deps: machine.deps, month: "2026-09", detail: false, now: new Date("2026-10-02T00:00:00.000Z") });
    expect(september.final).toBe(true);
    const august = await buildBillingReport({ registry: registryOf(world), layout: layout(), deps: machine.deps, month: "2026-08", detail: false, now: NOW });
    expect(august.final).toBe(true);
    expect(august.workspaces.find((line) => line.slug === "acme")).toMatchObject({ turns: 0, activeUsers: 0 });
  });

  it("refuses a fleet that has no reseller", async () => {
    const machine = fleet(world);
    await expect(buildBillingReport({ registry: { ...registryOf(world), reseller: undefined }, layout: layout(), deps: machine.deps, month: "2026-09", detail: false, now: NOW })).rejects.toThrow("no reseller");
  });

  describe("as CSV and text", () => {
    const sample = async (rates: Partial<FleetReseller> = {}) => {
      seedLedgers();
      return buildBillingReport({ registry: registryOf(world, { reseller: { ...reseller, ...rates } }), layout: layout(), deps: fleet(world).deps, month: "2026-09", detail: true, now: NOW });
    };

    it("has the contracted header and one line per workspace plus a total", async () => {
      const csv = billingCsv(await sample()).trimEnd().split("\n");
      expect(csv[0]).toBe("month,row_type,workspace,host,user,user_kind,asked_turns,attributed_turns,cost_usd,billable,ledger,wholesale_minor,retail_minor,margin_minor,currency");
      expect(csv.filter((line) => line.split(",")[1] === "workspace")).toHaveLength(5);
      expect(csv.filter((line) => line.split(",")[1] === "user")).toHaveLength(3);
      expect(csv.filter((line) => line.split(",")[1] === "total")).toEqual(["2026-09,total,,,,,,6,1.75,,ok,7500,18500,11000,USD"]);
      expect(csv).toContain("2026-09,workspace,acme,acme.example.test,,,,5,1.5,true,ok,3000,7000,4000,USD");
      expect(csv).toContain("2026-09,user,acme,acme.example.test,ada@x.test,email,2,3,1,,,,,,USD");
    });

    it("neutralises a spreadsheet formula in any text cell", async () => {
      const report = await sample();
      const hostile = { ...report, workspaces: report.workspaces.map((line) => (line.users?.length ? { ...line, users: [{ ...line.users[0]!, id: "=cmd|' /C calc'!A0" }, { ...line.users[0]!, id: "@SUM(1)" }, { ...line.users[0]!, id: "+1,2" }] } : line)) };
      const csv = billingCsv(hostile);
      expect(csv).toContain(",'=cmd|' /C calc'!A0,");
      expect(csv).toContain(",'@SUM(1),");
      expect(csv).toContain(",\"'+1,2\",");
      expect(csv).not.toMatch(/,=cmd/);
    });

    it("keeps a tenant-chosen device label inert and quoted when it carries commas or quotes", async () => {
      ledger("acme", [row({ kind: "user", label: 'Ada, "the" phone' })]);
      const report = await buildBillingReport({ registry: registryOf([workspace("acme")]), layout: layout(), deps: fleet(world).deps, month: "2026-09", detail: true, now: NOW });
      expect(billingCsv(report)).toContain(',"device:ada, ""the"" phone",device,1,1,0.25,');
    });

    it("prints a negative margin as a plain number, not as text", async () => {
      ledger("acme", [row({ kind: "user", email: "ada@x.test" })]);
      const report = await buildBillingReport({
        registry: registryOf([workspace("acme", { retailOverride: { workspaceMonthMinor: 0, userMonthMinor: 0 } })], { reseller: { ...reseller, wholesale: { workspaceMonthMinor: 5, userMonthMinor: 0 } } }),
        layout: layout(), deps: fleet(world).deps, month: "2026-09", detail: false, now: NOW,
      });
      expect(report.workspaces[0]!.marginMinor).toBe(-5);
      const csv = billingCsv(report);
      expect(csv.split("\n").find((line) => line.startsWith("2026-09,workspace,acme"))!.split(",").slice(-3)).toEqual(["0", "-5", "USD"]);
      expect(csv.split("\n").find((line) => line.startsWith("2026-09,total"))!.split(",").slice(-3)).toEqual(["0", "-5", "USD"]);
      expect(csv).not.toContain("'-5");
    });

    it("leaves unavailable money empty in CSV and says so in the text", async () => {
      seedLedgers();
      const report = await buildBillingReport({ registry: registryOf(world), layout: layout(), deps: fleet(world, { unmeterable: ["omb-acme"] }).deps, month: "2026-09", detail: false, now: NOW });
      const csv = billingCsv(report).trimEnd().split("\n");
      expect(csv).toContain("2026-09,workspace,acme,acme.example.test,,,,,,true,unavailable,,,,USD");
      expect(csv.at(-1)).toBe("2026-09,total,,,,,,,,,unavailable,,,,USD");
      const text = billingText(report);
      expect(text).toContain("INCOMPLETE");
      expect(text).toContain("acme: unsafe workspace file or directory");
      expect(text).toMatch(/acme\s+acme\.example\.test\s+running\s+yes \(running\)\s+\?\s+\?\s+\?\s+unavailable\s+unavailable\s+unavailable/);
    });

    it("prints amounts with two decimals, a negative sign where due, and the evidence footer", async () => {
      const text = billingText(await sample());
      expect(text).toContain("Billing for 2026-09 (UTC), Acme Cloud, amounts in USD");
      expect(text).toContain("Month still running: counts are as of 2026-09-20T12:00:00.000Z.");
      expect(text).toMatch(/acme\s+acme\.example\.test\s+running\s+yes \(running\)\s+2\s+5\s+1\.5000\s+30\.00\s+70\.00\s+40\.00/);
      expect(text).toMatch(/TOTAL\s+5 workspaces\s+3\s+75\.00\s+185\.00\s+110\.00/);
      expect(text).toContain("built from tenant-reported ledgers; evidence, not enforcement");
      expect(text).toContain("ada@x.test  asked 2, attributed 3");
      const negative = billingText({ ...(await sample()), totals: { workspaces: 1, activeUsers: 0, wholesaleMinor: 5, retailMinor: 0, marginMinor: -5 } });
      expect(negative).toContain("-0.05");
    });

    it("keeps control characters in a tenant-chosen label out of the text report", async () => {
      const report = await sample();
      const hostile = { ...report, workspaces: report.workspaces.map((line) => (line.users?.length ? { ...line, users: [{ ...line.users[0]!, id: "evil\u001b[2Jlabel" }] } : line)) };
      expect(billingText(hostile)).not.toContain("\u001b");
      expect(billingText(hostile)).toContain("evil [2Jlabel");
    });
  });

  describe("fleet billing", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const io = () => {
      const out: string[] = [];
      const err: string[] = [];
      return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err };
    };
    const input = (overrides: Partial<FleetInput> = {}): FleetInput => ({
      action: "billing", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: "/usr/bin/node", script: "/cli.js", root, ...overrides,
    });

    it("prints the report and exits 0 when every ledger was read", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      const out = io();
      expect(await runFleetBilling(input(), out.io, machine.deps)).toBe(0);
      expect(out.out.join("\n")).toContain("TOTAL");
      expect(out.err).toEqual([]);
    });

    it("prints CSV with --csv and JSON-able rows for --detail", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      const out = io();
      expect(await runFleetBilling(input({ csv: true, detail: true }), out.io, machine.deps)).toBe(0);
      expect(out.out[0]!.split("\n")[0]).toMatch(/^month,row_type/);
      expect(out.out[0]!.split("\n").filter((line) => line.split(",")[1] === "user")).toHaveLength(3);
    });

    it("still prints, but exits 1, when a ledger is unavailable", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"], unmeterable: ["omb-acme"] });
      const out = io();
      expect(await runFleetBilling(input(), out.io, machine.deps)).toBe(1);
      expect(out.out.join("\n")).toContain("INCOMPLETE");
    });

    it.each([
      [[], "missing: admin, billing"],
      [["admin"], "missing: billing"],
      [["billing"], "missing: admin"],
    ])("refuses with the licence features %j, naming %s", async (features, message) => {
      seedLedgers();
      const machine = fleet(world, { features });
      const out = io();
      expect(await runFleetBilling(input(), out.io, machine.deps)).toBe(2);
      expect(out.err.join("\n")).toContain(message);
      expect(out.out).toEqual([]);
      expect(machine.calls.filter((call) => call.startsWith("people"))).toEqual([]);
    });

    it("refuses when this build cannot check the licence at all", async () => {
      const machine = fleet(world);
      const out = io();
      expect(await runFleetBilling(input(), out.io, { ...machine.deps, entitlements: undefined })).toBe(2);
      expect(out.err.join("\n")).toContain("cannot check the licence");
    });

    it("passes the licence key to the entitlement check", async () => {
      const machine = fleet(world);
      const entitlements = vi.fn(async () => () => true);
      await runFleetBilling(input({ licenseKey: "omb1.key" }), io().io, { ...machine.deps, entitlements });
      expect(entitlements).toHaveBeenCalledWith("omb1.key");
    });

    it("rejects a bad or future month before reading any ledger", async () => {
      for (const month of ["2026-13", "2026-10", "2026-9", "latest"]) {
        const machine = fleet(world, { features: ["admin", "billing"] });
        const out = io();
        expect(await runFleetBilling(input({ month }), out.io, machine.deps)).toBe(2);
        expect(out.err.join("\n")).toMatch(/YYYY-MM|has not started/);
        expect(machine.calls.filter((call) => call.startsWith("people"))).toEqual([]);
      }
    });

    it("says so plainly when the fleet has no reseller or no registry", async () => {
      const machine = fleet(world, { features: ["admin", "billing"] });
      machine.files.set(layout().registryFile, JSON.stringify({ ...emptyRegistry("example.test"), workspaces: {} }));
      const out = io();
      expect(await runFleetBilling(input(), out.io, machine.deps)).toBe(2);
      expect(out.err.join("\n")).toContain("no reseller");
      const bare = fleetMachine(root, { features: ["admin", "billing"] });
      expect(await runFleetBilling(input(), io().io, bare.deps)).toBe(2);
    });

    it("is reached through runFleetCommand for the billing action", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      const out = io();
      expect(await runFleetCommand(input(), out.io, machine.deps)).toBe(0);
      expect(out.out.join("\n")).toContain("Acme Cloud");
    });
  });

  describe("fleet rates", () => {
    const rates = (patch: FleetInput["ratesPatch"], extra: Partial<FleetInput> = {}): FleetInput => ({
      action: "rates", admins: [], members: [], dryRun: false, yes: false, keepData: false, node: "/usr/bin/node", script: "/cli.js", root, ratesPatch: patch, ...extra,
    });
    const saved = (machine: ReturnType<typeof fleetMachine>) => parseRegistry(machine.files.get(layout().registryFile)!);

    it("writes the registry through one write step and nothing else, keeping workspaces and the operator", () => {
      const machine = fleet(world);
      const steps = planFleetRates(rates({ wholesale: { workspaceMonthMinor: 2500 }, retail: { userMonthMinor: 2000 } }, { currency: "EUR" }), machine.deps);
      expect(steps.filter((step) => step.kind !== "note")).toEqual([{ kind: "write", path: layout().registryFile, content: expect.any(String), mode: 0o600 }]);
      const next = parseRegistry((steps[0] as { content: string }).content);
      expect(next.reseller).toEqual({ ...reseller, currency: "EUR", wholesale: { workspaceMonthMinor: 2500, userMonthMinor: 500 }, retail: { workspaceMonthMinor: 5000, userMonthMinor: 2000 } });
      expect(Object.keys(next.workspaces)).toEqual(Object.keys(world.reduce((all, item) => ({ ...all, [item.slug]: 1 }), {})));
      expect(next.workspaces.acme).toEqual(world[0]);
    });

    it("sets a retail override field by field and clears it", () => {
      const machine = fleet(world);
      const set = planFleetRates(rates({ overrides: { beta: { workspaceMonthMinor: 100 } } }), machine.deps);
      const withOverride = parseRegistry((set[0] as { content: string }).content);
      expect(withOverride.workspaces.beta!.retailOverride).toEqual({ workspaceMonthMinor: 100 });
      machine.files.set(layout().registryFile, (set[0] as { content: string }).content);
      const second = planFleetRates(rates({ overrides: { beta: { userMonthMinor: 7 } } }), machine.deps);
      expect(parseRegistry((second[0] as { content: string }).content).workspaces.beta!.retailOverride).toEqual({ workspaceMonthMinor: 100, userMonthMinor: 7 });
      const cleared = planFleetRates(rates({ clearOverrides: ["acme"] }), machine.deps);
      expect(parseRegistry((cleared[0] as { content: string }).content).workspaces.acme).not.toHaveProperty("retailOverride");
    });

    it("shows the current rates without writing when no flag is given", () => {
      const steps = planFleetRates(rates(undefined), fleet(world).deps);
      expect(steps.every((step) => step.kind === "note")).toBe(true);
      expect(steps.map((step) => (step as { text: string }).text).join("\n")).toContain("retail override for acme");
    });

    it("refuses an unknown workspace, a clash, an unsupported currency, and a fleet without a reseller", () => {
      const machine = fleet(world);
      expect(() => planFleetRates(rates({ overrides: { nobody: { workspaceMonthMinor: 1 } } }), machine.deps)).toThrow('no workspace "nobody"');
      expect(() => planFleetRates(rates({ clearOverrides: ["nobody"] }), machine.deps)).toThrow('no workspace "nobody"');
      expect(() => planFleetRates(rates({ overrides: { acme: { workspaceMonthMinor: 1 } }, clearOverrides: ["acme"] }), machine.deps)).toThrow("both set and cleared");
      expect(() => planFleetRates(rates(undefined, { currency: "JPY" }), machine.deps)).toThrow("two decimals");
      machine.files.set(layout().registryFile, JSON.stringify(emptyRegistry("example.test")));
      expect(() => planFleetRates(rates({ wholesale: { workspaceMonthMinor: 1 } }), machine.deps)).toThrow("no reseller");
    });

    it("applies through runFleetCommand as root and only prints the plan otherwise", async () => {
      const applied = fleet(world);
      const out = { log: (_line: string) => {}, error: (_line: string) => {} };
      expect(await runFleetCommand(rates({ retail: { workspaceMonthMinor: 9900 } }), out, applied.deps)).toBe(0);
      expect(saved(applied).reseller!.retail.workspaceMonthMinor).toBe(9900);
      const preview = fleetMachine(root, { root: false });
      preview.files.set(layout().registryFile, JSON.stringify(registryOf(world)));
      expect(await runFleetCommand(rates({ retail: { workspaceMonthMinor: 9900 } }), out, preview.deps)).toBe(0);
      expect(saved(preview).reseller!.retail.workspaceMonthMinor).toBe(5000);
    });
  });

  describe("the closing snapshot", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const del = (slug: string, overrides: Partial<FleetInput> = {}): FleetInput => ({
      action: "delete", slug, admins: [], members: [], dryRun: false, yes: true, keepData: false, node: "/usr/bin/node", script: "/cli.js", root, ...overrides,
    });
    const quiet = { log: (_line: string) => {}, error: (_line: string) => {} };
    const closing = (slug: string) => join(layout().billingDir, "closing", `${slug}@2026-08-01T00:00:00.000Z.json`);

    it("writes a root-only snapshot of the month before the account is removed", async () => {
      seedLedgers();
      const order: string[] = [];
      const machine = fleet(world, { features: ["admin", "billing"], beforeRun: async (argv) => { if (argv[0] === "userdel") order.push(`userdel with snapshot ${machine.files.has(closing("acme"))}`); } });
      expect(await runFleetCommand(del("acme"), quiet, machine.deps)).toBe(0);
      expect(order).toEqual(["userdel with snapshot true"]);
      const snapshot = JSON.parse(machine.files.get(closing("acme"))!);
      expect(snapshot).toMatchObject({ version: 1, month: "2026-09", closedAt: NOW.toISOString(), currency: "USD", workspace: { workspaceId: "acme@2026-08-01T00:00:00.000Z", status: "deleted", activeUsers: 2, turns: 5, retail: { totalMinor: 7000 } } });
      expect(snapshot.workspace.users).toHaveLength(2);
      expect(parseRegistry(machine.files.get(layout().registryFile)!).workspaces).not.toHaveProperty("acme");
    });

    it("is part of that month's report afterwards, once, and only for that month", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      await runFleetCommand(del("acme"), quiet, machine.deps);
      const after = await build(machine);
      const line = after.workspaces.find((item) => item.slug === "acme")!;
      expect(line).toMatchObject({ status: "deleted", activeUsers: 2, retail: { totalMinor: 7000 } });
      expect(line.users).toBeUndefined();
      expect(after.workspaces.filter((item) => item.slug === "acme")).toHaveLength(1);
      expect(after.totals.workspaces).toBe(5);
      expect(after.totals).toMatchObject({ wholesaleMinor: 7500, retailMinor: 18500 });
      expect((await build(machine, true)).workspaces.find((item) => item.slug === "acme")!.users).toHaveLength(2);
      expect((await build(machine, false, "2026-08")).workspaces.some((item) => item.slug === "acme")).toBe(false);
    });

    it("aborts the delete, running no step, when the snapshot cannot be written", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      const deps: FleetDeps = { ...machine.deps, writeText: (path, content, mode, owner) => { if (path.includes("closing")) throw new Error("disk full"); machine.deps.writeText(path, content, mode, owner); } };
      const errors: string[] = [];
      expect(await runFleetCommand(del("acme"), { log: () => {}, error: (line) => errors.push(line) }, deps)).toBe(2);
      expect(errors.join("\n")).toContain("the workspace was not deleted");
      expect(machine.calls.filter((call) => /^(systemctl|userdel|nft)/.test(call))).toEqual([]);
      expect(parseRegistry(machine.files.get(layout().registryFile)!).workspaces).toHaveProperty("acme");
    });

    it("aborts when the directory cannot be made", async () => {
      const machine = fleet(world);
      const deps: FleetDeps = { ...machine.deps, mkdir: () => { throw new Error("read-only"); } };
      await expect(snapshotBeforeDelete(del("acme"), deps, NOW)).rejects.toThrow("was not deleted");
    });

    it("records an unreadable ledger as unavailable rather than blocking the delete", async () => {
      const machine = fleet(world, { unmeterable: ["omb-acme"] });
      await snapshotBeforeDelete(del("acme"), machine.deps, NOW);
      expect(JSON.parse(machine.files.get(closing("acme"))!).workspace).toMatchObject({ ledger: "unavailable", activeUsers: null });
      const report = await build(machine);
      expect(report.workspaces.find((item) => item.slug === "acme")).toBeDefined();
    });

    it("does nothing for a dry run, a kept-data delete, an unknown workspace or a fleet without a reseller", async () => {
      const machine = fleet(world);
      await snapshotBeforeDelete(del("acme", { yes: false }), machine.deps, NOW);
      await snapshotBeforeDelete(del("acme", { keepData: true }), machine.deps, NOW);
      await snapshotBeforeDelete(del("nobody"), machine.deps, NOW);
      await snapshotBeforeDelete({ ...del("acme"), action: "suspend" }, machine.deps, NOW);
      machine.files.set(layout().registryFile, JSON.stringify({ ...emptyRegistry("example.test"), workspaces: { acme: world[0] } }));
      await snapshotBeforeDelete(del("acme"), machine.deps, NOW);
      expect([...machine.files.keys()].filter((path) => path.includes("closing"))).toEqual([]);
    });

    it("lets a slug reused after deletion bill as its own workspace", async () => {
      seedLedgers();
      const machine = fleet(world, { features: ["admin", "billing"] });
      await runFleetCommand(del("acme"), quiet, machine.deps);
      const registry = parseRegistry(machine.files.get(layout().registryFile)!);
      registry.workspaces.acme = workspace("acme", { createdAt: "2026-09-15T00:00:00.000Z", events: [{ at: "2026-09-15T00:00:00.000Z", status: "running" }] });
      machine.files.set(layout().registryFile, JSON.stringify(registry));
      const report = await build(machine);
      expect(report.workspaces.filter((item) => item.slug === "acme").map((item) => item.workspaceId)).toEqual(["acme@2026-08-01T00:00:00.000Z", "acme@2026-09-15T00:00:00.000Z"]);
    });

    it("refuses to bill past a damaged snapshot or one in another currency", async () => {
      const machine = fleet(world);
      machine.files.set(join(layout().billingDir, "closing", "x@1.json"), "{broken");
      await expect(build(machine)).rejects.toThrow("not JSON");
      machine.files.set(join(layout().billingDir, "closing", "x@1.json"), JSON.stringify({ version: 1, month: "2026-09" }));
      await expect(build(machine)).rejects.toThrow("malformed");
      machine.files.set(join(layout().billingDir, "closing", "x@1.json"), JSON.stringify({ version: 1, month: "2026-09", closedAt: NOW.toISOString(), currency: "EUR", workspace: { workspaceId: "x@1", slug: "x", host: "x.example.test", billable: true, wholesale: { workspaceMinor: 1, usersMinor: 0, totalMinor: 1 }, retail: { workspaceMinor: 1, usersMinor: 0, totalMinor: 1 } } }));
      await expect(build(machine)).rejects.toThrow("EUR");
    });
  });
});
