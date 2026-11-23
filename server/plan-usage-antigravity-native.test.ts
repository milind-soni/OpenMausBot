import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;

vi.mock("./drivers/antigravity-usage-limits.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./drivers/antigravity-usage-limits.ts")>();
  const iso = (at: number) => new Date(at).toISOString();
  const windows = (remaining: number) => real.antigravityPlanWindows(real.antigravitySummaryWindows({ groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: remaining, resetTime: iso(NOW + 2 * HOUR), description: "used" },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.75, resetTime: iso(NOW + 60 * HOUR), description: "used" },
    ] },
  ] }, NOW));
  return {
    ...real,
    antigravityPlanUsage: vi.fn(async () => windows(0.5)),
    antigravityNativePlanUsage: vi.fn(async () => windows(0.2)),
  };
});

const { antigravityNativePlanUsage, antigravityPlanUsage, antigravityRunsNativeCli } = await import("./drivers/antigravity-usage-limits.ts");
const { clearPlanUsageCache, loadPlanUsage, planAccountsFromInstances } = await import("./plan-usage.ts");

const accountOf = (cli?: string) => planAccountsFromInstances({ antigravity: { driver: "antigravityAgent", environment: { HOME: "/Users/person" }, ...(cli === undefined ? {} : { config: { cli } }) } });
const fiveHourUsed = (report: Awaited<ReturnType<typeof loadPlanUsage>>) => report.providers.map((provider) => [provider.id, provider.fiveHour.usedPercent]);

afterEach(() => {
  clearPlanUsageCache();
  vi.mocked(antigravityPlanUsage).mockClear();
  vi.mocked(antigravityNativePlanUsage).mockClear();
});

describe("an Antigravity account's limits when it runs the native CLI", () => {
  it.each([
    ["antigravity", true],
    ["Antigravity.exe", true],
    ["/opt/tools/antigravity", true],
    ["agy", false],
    ["/usr/local/bin/agy", false],
    ["/opt/tools/agy_acp_server.par", false],
    [undefined, false],
  ])("is told from the CLI path %s", (cli, native) => {
    expect(antigravityRunsNativeCli(cli)).toBe(native);
    expect(accountOf(cli)[0]!.antigravityNative === true).toBe(native);
    expect(accountOf(cli)[0]!.noUsage).toBeUndefined();
  });

  it("are read from the native CLI's own sign-in, not the pinned token file a switch from a pinned account leaves", async () => {
    const pinned = await loadPlanUsage({ accounts: accountOf(), now: NOW });
    expect(fiveHourUsed(pinned)).toEqual([["antigravity", 50]]);

    // The same instance, now on the native CLI, read straight away: the report cached for 45 s is not its answer.
    const native = await loadPlanUsage({ accounts: accountOf("antigravity"), now: NOW + 1_000 });
    expect(fiveHourUsed(native)).toEqual([["antigravity", 80]]);
    expect(antigravityPlanUsage).toHaveBeenCalledTimes(1);
    expect(antigravityNativePlanUsage).toHaveBeenCalledWith("antigravity", { HOME: "/Users/person" }, expect.anything());

    const back = await loadPlanUsage({ accounts: accountOf("agy"), now: NOW + 2_000 });
    expect(fiveHourUsed(back)).toEqual([["antigravity", 50]]);
    expect(antigravityNativePlanUsage).toHaveBeenCalledTimes(1);
  });
});
