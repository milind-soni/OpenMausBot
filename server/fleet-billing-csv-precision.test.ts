import { describe, expect, it } from "vitest";
import { billingCsv } from "./fleet-billing.ts";
import type { FleetBillingReport } from "../shared/fleet-billing.ts";

const money = { workspaceMinor: 500, usersMinor: 0, totalMinor: 500 };

function report(costUsd: number): FleetBillingReport {
  return {
    version: 1,
    reseller: { name: "Acme" },
    month: "2026-11",
    currency: "USD",
    generatedAt: "2026-11-07T00:00:00.000Z",
    final: false,
    basis: "tenant-reported-ledger",
    complete: true,
    workspaces: [{
      workspaceId: "main@2026-11-01T00:00:00.000Z", slug: "main", host: "main.example.test", status: "running", billable: true, billableReason: "running",
      ledger: "ok", turns: 3, costUsd, activeUsers: 0, provisionedSeats: null, wholesale: money, retail: money, marginMinor: 0,
    }],
    totals: { workspaces: 1, activeUsers: 0, wholesaleMinor: 500, retailMinor: 500, marginMinor: 0 },
  };
}

describe("fleet billing CSV cost precision", () => {
  it("prints a cost summed from floats without binary rounding noise", () => {
    const cell = billingCsv(report(0.1 + 0.2)).split("\n")[1]!.split(",")[8]!;
    expect(cell).toBe("0.3");
  });

  it("prints a total summed from two workspaces without binary rounding noise", () => {
    const two = report(0.1);
    two.workspaces.push({ ...two.workspaces[0]!, slug: "second", workspaceId: "second@2026-11-01T00:00:00.000Z", costUsd: 0.2 });
    const lines = billingCsv(two).trimEnd().split("\n");
    expect(lines.at(-1)!.split(",")[8]).toBe("0.3");
  });
});
