import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { codexLimitResetsAt } from "./drivers/codex-errors.ts";
import { engineLimitFromUsage, LimitResetClock, nearLimitNote } from "./limit-resets.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { parseClaudeUsage, parseCodexUsage, type PlanProviderRow, type PlanUsageReport, type PlanWindows } from "./plan-usage.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

function row(id: string, driver: "claude" | "codex", windows: PlanWindows): PlanProviderRow {
  return { id, name: driver === "claude" ? "Claude" : "Codex", driver, ok: true, error: null, ...windows };
}
/** As the Claude usage endpoint answers (utilization, resets_at). */
const claude = (fiveHour: [number, number | null], weekly: [number, number | null]) => row("claude", "claude", parseClaudeUsage({
  five_hour: { utilization: fiveHour[0], resets_at: fiveHour[1] === null ? null : iso(fiveHour[1]) },
  seven_day: { utilization: weekly[0], resets_at: weekly[1] === null ? null : iso(weekly[1]) },
}));
/** As the ChatGPT usage endpoint answers for Codex (used_percent, reset_at in epoch seconds, window length). */
const codex = (primary: [number, number], secondary: [number, number]) => row("codex", "codex", parseCodexUsage({
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: primary[0], limit_window_seconds: 5 * 3600, reset_at: Math.floor(primary[1] / 1000) },
    secondary_window: { used_percent: secondary[0], limit_window_seconds: 7 * 86400, reset_at: Math.floor(secondary[1] / 1000) },
  },
}));
const report = (...providers: PlanProviderRow[]): PlanUsageReport => ({ fetchedAt: iso(NOW), providers });

describe("engineLimitFromUsage", () => {
  it("takes Claude's fullest window and its reset when nothing is at the limit", () => {
    expect(engineLimitFromUsage(claude([92, NOW + 2 * HOUR], [40, NOW + 50 * HOUR]))).toEqual({
      engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: 92, resetsAt: NOW + 2 * HOUR, blocked: false,
    });
    expect(engineLimitFromUsage(claude([10, NOW + 2 * HOUR], [95, NOW + 50 * HOUR]))).toMatchObject({ window: "weekly", usedPercent: 95, resetsAt: NOW + 50 * HOUR });
  });

  it("waits for the latest reset of every window at its limit, and knows no time when one has none", () => {
    expect(engineLimitFromUsage(claude([100, NOW + 2 * HOUR], [60, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, window: "5-hour", resetsAt: NOW + 2 * HOUR });
    expect(engineLimitFromUsage(claude([100, NOW + 2 * HOUR], [100, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, window: "weekly", resetsAt: NOW + 50 * HOUR });
    expect(engineLimitFromUsage(claude([100, null], [20, NOW + 50 * HOUR]))).toMatchObject({ blocked: true, resetsAt: null });
  });

  it("reads Codex's primary and secondary windows by their length", () => {
    expect(engineLimitFromUsage(codex([100, NOW + HOUR], [50, NOW + 90 * HOUR]))).toMatchObject({
      engine: "codex", driver: "codex", blocked: true, window: "5-hour", resetsAt: Math.floor((NOW + HOUR) / 1000) * 1000,
    });
    expect(engineLimitFromUsage(codex([10, NOW + HOUR], [97, NOW + 90 * HOUR]))).toMatchObject({ blocked: false, window: "weekly", usedPercent: 97 });
  });

  it("has nothing to say for a row that could not be read, and no time for a row without windows", () => {
    expect(engineLimitFromUsage({ ...claude([1, NOW], [1, NOW]), ok: false, error: "Sign in again in Claude" })).toBeNull();
    expect(engineLimitFromUsage(row("claude", "claude", parseClaudeUsage({})))).toMatchObject({ usedPercent: null, resetsAt: null, blocked: false });
  });
});

describe("LimitResetClock", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OMB_TEST_PLAN_USAGE_FILE;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const accounts = [{ id: "claude", name: "Claude", driver: "claude" as const, environment: {} }];
  const clock = (options: Partial<ConstructorParameters<typeof LimitResetClock>[0]> = {}) => {
    let now = NOW;
    const instance = new LimitResetClock({ accounts: () => accounts, now: () => now, ...options });
    return { instance, at: (next: number) => { now = next; } };
  };

  it("derives the reset from usage, and recomputes when usage moves it", () => {
    const changed = vi.fn();
    const { instance } = clock({ onChange: changed });
    expect(instance.resetAt("claude")).toBeNull();
    instance.noteUsage(report(claude([95, NOW + 2 * HOUR], [10, NOW + 90 * HOUR])));
    expect(instance.resetAt("claude")).toBe(NOW + 2 * HOUR);
    instance.noteUsage(report(claude([96, NOW + 3 * HOUR], [10, NOW + 90 * HOUR])));
    expect(instance.resetAt("claude")).toBe(NOW + 3 * HOUR);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("trusts a refusal's own reset over the fullest window, unless usage shows a later window at its limit", () => {
    const { instance, at } = clock();
    instance.noteUsage(report(claude([80, NOW + 4 * HOUR], [60, NOW + 90 * HOUR])));
    instance.noteRefusal("claude", NOW + HOUR);
    expect(instance.resetAt("claude")).toBe(NOW + HOUR);
    expect(instance.blockedUntil("claude")).toBe(NOW + HOUR);
    instance.noteUsage(report(claude([100, NOW + HOUR], [100, NOW + 90 * HOUR])));
    expect(instance.resetAt("claude")).toBe(NOW + 90 * HOUR);
    at(NOW + 91 * HOUR);
    expect(instance.blockedUntil("claude")).toBeNull();
  });

  it("keeps a passed refusal briefly, then forgets it", () => {
    const { instance, at } = clock();
    instance.noteRefusal("claude", NOW + HOUR);
    at(NOW + HOUR + 60_000);
    expect(instance.blockedUntil("claude")).toBeNull();
    expect(instance.resetAt("claude")).toBe(NOW + HOUR);
    at(NOW + 2 * HOUR);
    expect(instance.resetAt("claude")).toBeNull();
  });

  it("blocks Codex only until its reset minute ends when it refuses within that minute", () => {
    const minute = new Date(2026, 9, 19, 17, 23, 0).getTime();
    const { instance, at } = clock();
    at(minute + 20_000);
    instance.noteRefusal("codex", codexLimitResetsAt("You've hit your usage limit. Try again at 5:23 PM.", minute + 20_000));
    expect(instance.blockedUntil("codex")).toBe(minute + 59_999);
    at(minute + 60_000);
    expect(instance.blockedUntil("codex")).toBeNull();
  });

  it("ignores a refusal that names no engine, no time or a time already past", () => {
    const { instance } = clock();
    instance.noteRefusal(undefined, NOW + HOUR);
    instance.noteRefusal("claude", undefined);
    instance.noteRefusal("claude", NOW - 1);
    expect(instance.report().engines).toEqual([]);
  });

  it("reports a refused engine as blocked even before its usage was read", () => {
    const { instance } = clock();
    instance.noteRefusal("claude", NOW + HOUR);
    expect(instance.report().engines).toEqual([expect.objectContaining({ engine: "claude", name: "Claude", blocked: true, usedPercent: 100, resetsAt: NOW + HOUR })]);
  });

  it("reads usage at most once while it is fresh, and through the test fixture file when one is set", async () => {
    const load = vi.fn(async () => report(claude([50, NOW + HOUR], [5, NOW + 90 * HOUR])));
    const { instance, at } = clock({ loadUsage: load });
    await Promise.all([instance.ensureFresh(), instance.ensureFresh()]);
    await instance.ensureFresh();
    expect(load).toHaveBeenCalledTimes(1);
    at(NOW + 10 * 60_000);
    await instance.ensureFresh();
    expect(load).toHaveBeenCalledTimes(2);

    const dir = mkdtempSync(join(tmpdir(), "omb-limit-fixture-"));
    dirs.push(dir);
    process.env.OMB_TEST_PLAN_USAGE_FILE = join(dir, "usage.json");
    writeFileSync(process.env.OMB_TEST_PLAN_USAGE_FILE, JSON.stringify(report(claude([91, NOW + 5 * HOUR], [1, NOW + 90 * HOUR]))));
    const fixture = clock().instance;
    await fixture.refresh(true);
    expect(fixture.limit("claude")).toMatchObject({ usedPercent: 91, resetsAt: NOW + 5 * HOUR });
  });

  it("reads usage once an account is added after a refresh that had none", async () => {
    const load = vi.fn(async () => report(claude([50, NOW + HOUR], [5, NOW + 90 * HOUR])));
    let current: typeof accounts = [];
    const instance = new LimitResetClock({ accounts: () => current, now: () => NOW, loadUsage: load });
    await instance.refresh(true);
    current = accounts;
    await instance.refresh(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("codexLimitResetsAt", () => {
  it("reads Codex's local clock time as today, and a full date as given", () => {
    const morning = new Date(2026, 9, 19, 9, 0, 0).getTime();
    const today = new Date(2026, 9, 19, 17, 23, 0).getTime();
    expect(codexLimitResetsAt("You've hit your usage limit. Upgrade to Pro or try again at 5:23 PM.", morning)).toBe(today);
    expect(codexLimitResetsAt("You've hit your usage limit for gpt-6.1-sol. Switch to another model now, or try again at Oct 17th, 2026 5:23 PM.", morning))
      .toBe(new Date(2026, 9, 17, 17, 23, 0).getTime());
  });

  it("reads a clock time whose minute has begun as the end of that minute, not tomorrow", () => {
    // Codex prints only the time when the reset is on its own date, and drops the seconds.
    const minute = new Date(2026, 9, 19, 17, 23, 0).getTime();
    const said = "You've hit your usage limit. Try again at 5:23 PM.";
    expect(codexLimitResetsAt(said, minute)).toBe(minute + 59_999);
    expect(codexLimitResetsAt(said, minute + 20_000)).toBe(minute + 59_999);
    expect(codexLimitResetsAt(said, minute + 90_000)).toBe(minute + 59_999);
  });

  // America/New_York repeats 1:00-1:59 AM on 2026-11-01 (05:00Z EDT, then 06:00Z EST).
  it("reads a clock time in the repeated hour after a DST change as the later one once the first has passed", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const said = (time: string) => `You've hit your usage limit. Try again at ${time}.`;
      // In the second 1:30 AM, a reset at 1:50 AM is the second 1:50 AM, 20 minutes away.
      expect(iso(codexLimitResetsAt(said("1:50 AM"), Date.parse("2026-11-01T06:30:00Z"))!)).toBe("2026-11-01T06:50:00.000Z");
      // In the first 1:40 AM, a reset 40 minutes away is printed as 1:20 AM.
      expect(iso(codexLimitResetsAt(said("1:20 AM"), Date.parse("2026-11-01T05:40:00Z"))!)).toBe("2026-11-01T06:20:00.000Z");
      // A time still ahead in the first hour stays there.
      expect(iso(codexLimitResetsAt(said("1:50 AM"), Date.parse("2026-11-01T05:30:00Z"))!)).toBe("2026-11-01T05:50:00.000Z");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("names no time when Codex gives none or the words are not a usage limit", () => {
    expect(codexLimitResetsAt("You've hit your usage limit. Try again later.")).toBeUndefined();
    expect(codexLimitResetsAt("Please try again at 5:23 PM.")).toBeUndefined();
  });
});

describe("nearLimitNote", () => {
  it("tells the turn when its engine is at 90% or more, with the reset", () => {
    const limit = engineLimitFromUsage(claude([92, Date.UTC(2026, 9, 19, 15, 40)], [10, NOW + 90 * HOUR]))!;
    expect(nearLimitNote(limit, "Claude", "UTC")).toBe(" Claude's usage limit is 92% used; it resets Mon 3:40 PM (UTC).");
    expect(nearLimitNote({ ...limit, usedPercent: 89 }, "Claude", "UTC")).toBe("");
    expect(nearLimitNote(undefined, "Claude", "UTC")).toBe("");
  });
});

describe("LimitResetClock and the turns that follow a refusal", () => {
  const accounts = [{ id: "claude", name: "Claude", driver: "claude" as const, environment: {} }];
  const base = { eventId: "e", provider: "claudeAgent", createdAt: "2026-10-19T10:00:00Z" };
  const started = (threadId: string) => ({ ...base, threadId, type: "turn.started" }) as RuntimeEvent;
  const refused = (threadId: string, limitResetsAt?: number) => ({ ...base, threadId, type: "runtime.error", message: "limit", ...(limitResetsAt ? { limitResetsAt } : {}) }) as RuntimeEvent;
  const completed = (threadId: string, ok: boolean) => ({ ...base, threadId, type: "turn.completed", ok }) as RuntimeEvent;
  const clock = (onChange = vi.fn()) => ({ onChange, instance: new LimitResetClock({ accounts: () => accounts, now: () => NOW, onChange }) });

  it("ends the hold when a later turn on the same engine works, even after the engine's turn map forgot it", () => {
    const { instance, onChange } = clock();
    instance.noteRuntimeEvent("claude", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1", NOW + 11 * 24 * HOUR));
    instance.noteRuntimeEvent(undefined, completed("t1", false));
    expect(instance.blockedUntil("claude")).toBe(NOW + 11 * 24 * HOUR);
    onChange.mockClear();
    instance.noteRuntimeEvent("claude", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", true));
    expect(instance.blockedUntil("claude")).toBeNull();
    expect(instance.report().engines).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold through a failed turn, a working turn on another engine, or a turn whose engine is unknown", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("claude", refused("t1", NOW + HOUR));
    instance.noteRuntimeEvent("claude", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", false));
    instance.noteRuntimeEvent("codex", started("t3"));
    instance.noteRuntimeEvent(undefined, completed("t3", true));
    instance.noteRuntimeEvent(undefined, completed("t4", true));
    expect(instance.blockedUntil("claude")).toBe(NOW + HOUR);
  });

  it("holds nothing for a refusal without an engine-wide reset", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("claude", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1"));
    expect(instance.blockedUntil("claude")).toBeNull();
  });
});
