import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;

vi.mock("./drivers/antigravity-usage-limits.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./drivers/antigravity-usage-limits.ts")>();
  const iso = (at: number) => new Date(at).toISOString();
  return {
    ...real,
    antigravityPlanUsage: vi.fn(async () => real.antigravityPlanWindows(real.antigravitySummaryWindows({ groups: [
      { displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: iso(NOW + 2 * HOUR), description: "used" },
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.75, resetTime: iso(NOW + 60 * HOUR), description: "used" },
      ] },
    ] }, NOW))),
  };
});

const { antigravityPlanUsage, antigravityRunsNativeCli } = await import("./drivers/antigravity-usage-limits.ts");
const { clearPlanUsageCache, loadPlanUsage, planAccountsFromInstances } = await import("./plan-usage.ts");

const accountOf = (cli?: string) => planAccountsFromInstances({ antigravity: { driver: "antigravityAgent", ...(cli === undefined ? {} : { config: { cli } }) } });

afterEach(() => {
  clearPlanUsageCache();
  vi.mocked(antigravityPlanUsage).mockClear();
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
    expect(accountOf(cli)[0]!.noUsage === true).toBe(native);
  });

  it("has no row, where a switch from a pinned account showed that account's limits a moment before", async () => {
    const pinned = await loadPlanUsage({ accounts: accountOf(), now: NOW });
    expect(pinned.providers.map((provider) => provider.id)).toEqual(["antigravity"]);
    expect(antigravityPlanUsage).toHaveBeenCalledTimes(1);

    // The same instance, now on the native CLI, read straight away: the report cached for 45 s is not its answer.
    const native = await loadPlanUsage({ accounts: accountOf("antigravity"), now: NOW + 1_000 });
    expect(native.providers).toEqual([]);
    expect(antigravityPlanUsage).toHaveBeenCalledTimes(1);

    const back = await loadPlanUsage({ accounts: accountOf("agy"), now: NOW + 2_000 });
    expect(back.providers.map((provider) => provider.id)).toEqual(["antigravity"]);
  });
});
