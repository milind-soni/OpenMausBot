import { expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { LimitResetClock } from "../limit-resets.ts";
import { parseCodexUsage, type PlanUsageReport } from "../plan-usage.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./status.ts";
import type { RouteContext } from "./table.ts";

const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../plan-usage.ts", async (original) => ({
  ...await original<typeof import("../plan-usage.ts")>(), loadPlanUsage: (...args: unknown[]) => fixture.load(...args),
}));

it("feeds Settings' fresh usage read into the same clock that holds routing", async () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const accounts = [{ id: "codex", name: "Codex", driver: "codex" as const, environment: {} }];
  const clock = new LimitResetClock({ accounts: () => accounts, now: () => now });
  const report: PlanUsageReport = { fetchedAt: new Date(now).toISOString(), providers: [{
    id: "codex", name: "Codex", driver: "codex", ok: true, error: null,
    ...parseCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: (now + 14_400_000) / 1000 } } }),
  }] };
  fixture.load.mockResolvedValue(report);
  clock.noteRefusal("codex", now + 86_400_000);
  const json = vi.fn();
  const notePlanUsage = vi.fn((value: PlanUsageReport) => clock.noteUsage(value));
  const handler = createStatusRoutes({
    cfg: { instances: { codex: { driver: "codex" } } } as AppConfig,
    notePlanUsage,
  } as unknown as StatusRouteDeps);
  try {
    const context = {
      method: "GET", path: "/api/plan-usage", url: new URL("http://fixture/api/plan-usage?refresh=1"),
      res: { setHeader: vi.fn() }, json,
    } as unknown as RouteContext;
    await handler(context);
    expect(fixture.load).toHaveBeenCalledWith({ accounts: expect.arrayContaining([
      ...accounts, expect.objectContaining({ id: "chatgpt", noUsage: true }),
    ]), refresh: true });
    expect(notePlanUsage).toHaveBeenCalledExactlyOnceWith(report);
    expect(clock.blockedUntil("codex")).toBeNull();
    expect(clock.limit("codex")).toMatchObject({ blocked: false, usedPercent: 12 });
    expect(json).toHaveBeenCalledWith(context.res, 200, report);
    clock.noteRefusal("codex", now + 86_400_000);
    fixture.load.mockResolvedValue({ ...report, providers: [{ ...report.providers[0], ok: false, error: "Sign in again in Codex" }] });
    await handler(context);
    expect(clock.blockedUntil("codex")).toBe(now + 86_400_000);
    expect(clock.report().errors).toEqual({ codex: "Sign in again in Codex" });
  } finally {
    clock.stop();
  }
});
