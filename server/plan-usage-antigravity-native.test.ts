import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { installFakeManagedCli } from "./testing/antigravity-native-fixture.ts";

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
  rmSync(join(antigravityRuntimesRoot(DATA_DIR), `${process.platform}-${process.arch}`), { recursive: true, force: true });
  clearPlanUsageCache();
  vi.mocked(antigravityPlanUsage).mockClear();
  vi.mocked(antigravityNativePlanUsage).mockClear();
});

describe("an Antigravity account's limits when it runs the native CLI", () => {
  it.each([
    ["antigravity", true],
    ["Antigravity.exe", true],
    ["/opt/tools/antigravity", true],
    ["agy", true],
    ["/usr/local/bin/agy", true],
    ["/opt/tools/agy_acp_server.par", false],
    ["agy_acp_server", false],
    [undefined, true],
  ])("is told from the CLI path %s while nothing is installed, a new install taking the native CLI", async (cli, native) => {
    await expect(antigravityRunsNativeCli(cli, { PATH: "" })).resolves.toBe(native);
    expect(accountOf(cli)[0]!.antigravityCli).toBe(cli);
    expect(accountOf(cli)[0]!.noUsage).toBeUndefined();
  });

  it("is told from the CLI it runs: no path or agy on a computer with only the native CLI", async () => {
    installFakeManagedCli(DATA_DIR);
    for (const cli of [undefined, "agy"]) await expect(antigravityRunsNativeCli(cli, { PATH: "" })).resolves.toBe(true);
    await expect(antigravityRunsNativeCli("agy_acp_server", { PATH: "" })).resolves.toBe(false);
    await expect(antigravityRunsNativeCli("/usr/local/bin/agy", { PATH: "" })).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32")("is told from files alone, starting no program: an antigravity beside a pinned harness is pinned", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-usage-native-"));
    try {
      const ran = join(folder, "ran");
      const program = `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(ran)}\necho 1.5.14\n`;
      writeFileSync(join(folder, "antigravity"), program, { mode: 0o755 });
      await expect(antigravityRunsNativeCli(join(folder, "antigravity"), { PATH: "" })).resolves.toBe(true);
      writeFileSync(join(folder, "localharness_external"), program, { mode: 0o755 });
      await expect(antigravityRunsNativeCli(join(folder, "antigravity"), { PATH: "" })).resolves.toBe(false);
      expect(existsSync(ran)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("are read from the native CLI's own sign-in, not the pinned token file a switch from a pinned account leaves", async () => {
    const pinned = await loadPlanUsage({ accounts: accountOf("agy_acp_server"), now: NOW });
    expect(fiveHourUsed(pinned)).toEqual([["antigravity", 50]]);

    // The same instance, now on the native CLI, read straight away: the report cached for 45 s is not its answer.
    const native = await loadPlanUsage({ accounts: accountOf("antigravity"), now: NOW + 1_000 });
    expect(fiveHourUsed(native)).toEqual([["antigravity", 80]]);
    expect(antigravityPlanUsage).toHaveBeenCalledTimes(1);
    expect(antigravityNativePlanUsage).toHaveBeenCalledWith("antigravity", { HOME: "/Users/person" }, expect.anything());

    const back = await loadPlanUsage({ accounts: accountOf("agy_acp_server"), now: NOW + 2_000 });
    expect(fiveHourUsed(back)).toEqual([["antigravity", 50]]);
    expect(antigravityNativePlanUsage).toHaveBeenCalledTimes(1);
  });
});
