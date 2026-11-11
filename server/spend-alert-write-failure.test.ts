import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import type { SpendState } from "./spend.ts";

vi.mock("node:fs", { spy: true });
vi.resetModules();
const { resetSpendAlertsForTests, takeSpendAlert } = await import("./spend.ts");

const state = (over: Partial<SpendState> = {}): SpendState => ({
  month: "2026-09", monthlyUsd: 100, spentUsd: 85, percent: 85, warnAtPercent: 80,
  warn: true, exceeded: false, ...over,
});

describe("spend notices when an existing receipt cannot be updated", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-spend-alert-write-"));
    resetSpendAlertsForTests();
  });
  afterEach(async () => {
    vi.mocked(writeFileSync).mockRestore();
    resetSpendAlertsForTests();
    await removeTempDir(dataDir);
  });

  it("does not resend the cap notice while the old warning receipt remains on disk", () => {
    expect(takeSpendAlert(dataDir, state())).toBe("warn");
    const path = join(dataDir, "usage", "alerts.json");
    const saved = readFileSync(path, "utf8");
    vi.mocked(writeFileSync).mockImplementation(() => { throw Object.assign(new Error("read-only store"), { code: "EROFS" }); });
    const capped = state({ spentUsd: 105, percent: 105, exceeded: true });
    expect(takeSpendAlert(dataDir, capped)).toBe("cap");
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(takeSpendAlert(dataDir, capped)).toBeNull();
    expect(takeSpendAlert(dataDir, state({ spentUsd: 110, percent: 110, exceeded: true }))).toBeNull();
  });

  it("remembers a new month's notice in memory while last month's receipt is still readable", () => {
    expect(takeSpendAlert(dataDir, state())).toBe("warn");
    vi.mocked(writeFileSync).mockImplementation(() => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    const nextMonth = state({ month: "2026-10" });
    expect(takeSpendAlert(dataDir, nextMonth)).toBe("warn");
    expect(takeSpendAlert(dataDir, nextMonth)).toBeNull();
    expect(takeSpendAlert(dataDir, state({ month: "2026-10", spentUsd: 105, percent: 105, exceeded: true }))).toBe("cap");
    expect(takeSpendAlert(dataDir, nextMonth)).toBeNull();
  });
});
