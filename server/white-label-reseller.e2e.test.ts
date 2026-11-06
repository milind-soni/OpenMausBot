// The owner's acceptance flow end to end: the real fleet CLI builds the reseller, isolated fake-engine workspaces serve its brand and book real turns, and the fleet bills them through the real helper. No live account, engine, licence or server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataUri } from "./testing/fleet-brand-fixtures.ts";
import { RESELLER, TINY_PNG } from "./testing/reseller-fixture.ts";
import { ResellerFlow, type BillingRun, type ResellerEvidence } from "./testing/reseller-flow.ts";

const WHOLESALE = { workspace: 500, user: 200 };
const RETAIL = { workspace: 2000, user: 900 };

function parseCsv(text: string): string[][] {
  return text.trim().split("\n").map((line) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { cells.push(cell); cell = ""; } else cell += char;
    }
    cells.push(cell);
    return cells;
  });
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("white-label reseller: custom branding and billable usage per workspace and user", () => {
  let flow: ResellerFlow;
  let evidence: ResellerEvidence;

  beforeAll(async () => {
    flow = await ResellerFlow.start();
    evidence = await flow.runAll();
  }, 300_000);

  afterAll(async () => {
    if (evidence) console.info(JSON.stringify(evidence.logs));
    await flow?.close();
  }, 60_000);

  describe("a fresh install brings up private workspaces with custom branding", () => {
    it("serves the reseller's name, logo, accent, tagline and support link from the merged file the fleet wrote", () => {
      expect(evidence.brand.alpha).toMatchObject({
        source: "file",
        brand: { name: RESELLER.name, logo: dataUri("image/png", TINY_PNG), accent: RESELLER.accent, tagline: RESELLER.tagline, supportUrl: RESELLER.supportUrl },
      });
      expect(evidence.brand.beta).toMatchObject({ source: "file", brand: { name: RESELLER.name, logo: dataUri("image/png", TINY_PNG) } });
      expect(evidence.brand.alpha.notice).toBeUndefined();
    });

    it("gives alpha its custom address and beta the default, in the registry, the Caddy site and OMB_PUBLIC_URL", () => {
      expect(evidence.registry).toEqual({
        alpha: { host: RESELLER.alphaHost, status: "running" },
        beta: { host: `beta.${RESELLER.domain}`, status: "running" },
      });
      expect(evidence.sites.alpha.caddy).toContain(`${RESELLER.alphaHost} {`);
      expect(evidence.sites.alpha.caddy).not.toContain(`alpha.${RESELLER.domain}`);
      expect(evidence.sites.alpha.env).toContain(`OMB_PUBLIC_URL=https://${RESELLER.alphaHost}`);
      expect(evidence.sites.alpha.env).toContain(`OMB_BRAND_FILE=${flow.brandFile("alpha")}`);
      expect(evidence.sites.beta.caddy).toContain(`beta.${RESELLER.domain} {`);
      expect(evidence.sites.beta.env).toContain(`OMB_PUBLIC_URL=https://beta.${RESELLER.domain}`);
    });

    it("keeps the default brand and says why on a server whose licence does not grant whitelabel", () => {
      expect(evidence.brand.withoutEntitlement).toMatchObject({ source: "default", brand: { name: "OpenMausBot" } });
      expect(evidence.brand.withoutEntitlement.notice).toContain("not licensed for whitelabel");
    });
  });

  describe("the reseller's test account shows billable usage per workspace and per user", () => {
    const lineOf = (run: BillingRun, slug: string) => run.report.workspaces.find((line) => line.slug === slug)!;

    it("counts alpha's two paired devices and beta's no one, with the turn counts the workspaces report themselves", () => {
      const { report, csv } = evidence.billing;
      expect(csv.code).toBe(0);
      expect(csv.err).toEqual([]);
      expect(report).toMatchObject({ complete: true, final: false, month: evidence.month, currency: RESELLER.currency, basis: "tenant-reported-ledger", reseller: { name: RESELLER.name } });
      const alpha = lineOf(evidence.billing, "alpha");
      const beta = lineOf(evidence.billing, "beta");
      expect(alpha).toMatchObject({ host: RESELLER.alphaHost, ledger: "ok", billable: true, billableReason: "running", activeUsers: 2, turns: evidence.oracle.alpha.total.turns });
      expect(alpha.turns).toBe(3);
      expect(beta).toMatchObject({ host: `beta.${RESELLER.domain}`, ledger: "ok", billable: true, billableReason: "running", activeUsers: 0, turns: evidence.oracle.beta.total.turns, users: [] });
      expect(alpha.provisionedSeats).toEqual({ emails: 1, domains: 0 });
    });

    it("lists the same people as GET /api/usage?groupBy=user, and the owner is no one", () => {
      const alpha = lineOf(evidence.billing, "alpha");
      const groups = evidence.oracle.alpha.groups.filter((group) => group.key.startsWith("user:"));
      expect(groups.map((group) => group.key).sort()).toEqual(["user:ada's phone", "user:bo's tablet"]);
      expect(evidence.oracle.alpha.groups.map((group) => group.key)).toContain("owner");
      expect(alpha.users!.map((user) => `user:${user.id.replace(/^device:/, "")}`).sort()).toEqual(groups.map((group) => group.key).sort());
      for (const user of alpha.users!) {
        const group = groups.find((entry) => entry.key === `user:${user.id.replace(/^device:/, "")}`)!;
        expect(user).toMatchObject({ kind: "device", asked: 1, attributed: group.turns });
        expect(user.costUsd).toBeCloseTo(group.costUsd!, 9);
      }
      expect(alpha.costUsd).toBeCloseTo(evidence.oracle.alpha.total.costUsd!, 9);
    });

    it("prices each billable workspace as the workspace rate plus the user rate times its users, in minor units", () => {
      for (const line of evidence.billing.report.workspaces) {
        const users = line.activeUsers!;
        expect(line.wholesale).toEqual({ workspaceMinor: WHOLESALE.workspace, usersMinor: users * WHOLESALE.user, totalMinor: WHOLESALE.workspace + users * WHOLESALE.user });
        expect(line.retail).toEqual({ workspaceMinor: RETAIL.workspace, usersMinor: users * RETAIL.user, totalMinor: RETAIL.workspace + users * RETAIL.user });
        expect(line.marginMinor).toBe(line.retail.totalMinor! - line.wholesale.totalMinor!);
      }
      expect(lineOf(evidence.billing, "alpha").wholesale.totalMinor).toBe(900);
      expect(lineOf(evidence.billing, "alpha").retail.totalMinor).toBe(3800);
      expect(lineOf(evidence.billing, "beta").retail.totalMinor).toBe(2000);
    });

    it("totals the printed lines and prints a CSV with workspace, user and total rows and no formula-prefixed cell", () => {
      const { report, csv } = evidence.billing;
      const sum = (pick: (line: (typeof report.workspaces)[number]) => number | null) => report.workspaces.reduce((total, line) => total + pick(line)!, 0);
      expect(report.totals).toEqual({
        workspaces: 2,
        activeUsers: 2,
        wholesaleMinor: sum((line) => line.wholesale.totalMinor),
        retailMinor: sum((line) => line.retail.totalMinor),
        marginMinor: sum((line) => line.marginMinor),
      });
      expect(report.totals).toEqual({ workspaces: 2, activeUsers: 2, wholesaleMinor: 1400, retailMinor: 5800, marginMinor: 4400 });

      const rows = parseCsv(csv.out.join("\n"));
      const header = rows[0]!;
      expect(header).toEqual(["month", "row_type", "workspace", "host", "user", "user_kind", "asked_turns", "attributed_turns", "cost_usd", "billable", "ledger", "wholesale_minor", "retail_minor", "margin_minor", "currency"]);
      const byType = (type: string) => rows.slice(1).filter((row) => row[1] === type);
      expect(byType("workspace")).toHaveLength(2);
      expect(byType("user")).toHaveLength(2);
      expect(byType("total")).toHaveLength(1);
      const total = byType("total")[0]!;
      expect(total[header.indexOf("wholesale_minor")]).toBe("1400");
      expect(total[header.indexOf("retail_minor")]).toBe("5800");
      expect(total[header.indexOf("margin_minor")]).toBe("4400");
      for (const row of rows.slice(1)) {
        for (const column of ["workspace", "host", "user", "user_kind"]) expect(row[header.indexOf(column)], `${row.join(",")} ${column}`).not.toMatch(/^[=+\-@\t\r]/);
        expect(row[header.indexOf("month")]).toBe(evidence.month);
        expect(row[header.indexOf("currency")]).toBe(RESELLER.currency);
      }
    });
  });

  describe("deleting beta", () => {
    it("writes a closing snapshot, removes its brand files, and still bills it for the month from the snapshot", () => {
      const { deleted, billing } = evidence;
      expect(deleted.snapshotPath).toContain(`${flow.fleet.layout.billingDir}/closing/beta@`);
      expect(deleted.snapshot).toMatchObject({ version: 1, month: evidence.month, currency: RESELLER.currency, workspace: { slug: "beta", status: "deleted", activeUsers: 0 } });
      expect(deleted.brandFilesLeft).toEqual([]);
      expect(flow.brandFilesOf("alpha")).toEqual(["alpha.json", "alpha.override.json"]);
      expect(Object.keys(flow.registry().workspaces)).toEqual(["alpha"]);

      expect(deleted.billing.csv.code).toBe(0);
      expect(deleted.billing.report.complete).toBe(true);
      const beta = deleted.billing.report.workspaces.find((line) => line.slug === "beta")!;
      expect(beta).toMatchObject({ status: "deleted", billable: true, activeUsers: 0 });
      expect(beta.workspaceId).toMatch(/^beta@/);
      expect(deleted.billing.report.totals).toEqual(billing.report.totals);
      expect(deleted.billing.csv.out.join("\n")).toContain(`${evidence.month},workspace,beta,`);
    });
  });
});
