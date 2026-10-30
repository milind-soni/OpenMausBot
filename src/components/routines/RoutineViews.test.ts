import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Routine, RoutineRun } from "@/lib/routines";
import { RoutineList } from "./RoutineList";
import { latestRoutineRun, routineNextLabel } from "@/lib/routine-display";

const routine: Routine = {
  id: "brief", name: "Morning brief", prompt: "Report progress", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "interval", everyMinutes: 60, anchorAt: 1 }, durationMinutes: 30, nextRunAt: 3_600_000, createdAt: 1, updatedAt: 1,
};
const run: RoutineRun = { id: "run", routineId: routine.id, routineName: routine.name, target: "bot", botId: routine.botId, runOn: "maus", scheduledFor: 100, createdAt: 100, status: "completed", manual: false, output: "Brief prepared." };

function list(props: Partial<Parameters<typeof RoutineList>[0]> = {}) {
  return renderToStaticMarkup(createElement(RoutineList, { routines: [routine], runs: [run], onOpen: vi.fn(), onLogs: vi.fn(), ...props }));
}

afterEach(() => vi.useRealTimers());

describe("routine list", () => {
  it("shows saved skips and recent failure streaks without claiming all offline occurrences were counted", () => {
    const markup = list({ routines: [{ ...routine, skippedRuns: 3, lastSkippedAt: 100, failureStreak: 2 }] });
    expect(markup).toContain("Scheduled occurrences skipped while busy: 3");
    expect(markup).toContain("Recent consecutive failures: 2");
    expect(markup).toContain("Last:");
    expect(list()).not.toContain("Recent consecutive failures:");
    expect(list()).not.toContain("Scheduled occurrences skipped while busy:");
  });
  it("says how many of the week's runs went fine, and which run started again by itself", () => {
    const markup = list({ routines: [{ ...routine, weekRuns: { ok: 6, total: 7 } }], runs: [{ ...run, retried: "stalled" }] });
    expect(markup).toContain("6 of 7 runs OK this week");
    expect(markup).toContain("Latest: Retried after the AI stalled · Completed");
    expect(list()).not.toContain("runs OK this week");
  });
  it("retains visible records and latest results during a failed refresh", () => {
    const markup = list({ error: true });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Retrying…");
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Brief prepared.");
    expect(markup).toContain('aria-label="Run logs for Morning brief"');
  });

  it("does not show the empty state before hydration or on transport failure", () => {
    expect(list({ routines: [], runs: [], loading: true })).toContain("Loading routines…");
    expect(list({ routines: [], runs: [], loading: true })).not.toContain("No schedules yet.");
    expect(list({ routines: [], runs: [], error: true })).not.toContain("No schedules yet.");
    expect(list({ routines: [], runs: [] })).toContain("No schedules yet.");
  });

  it("distinguishes a finished one-shot schedule from a successful run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const markup = list({ routines: [{ ...routine, schedule: { type: "once", at: 10 }, enabled: false, nextRunAt: null }], runs: [{ ...run, status: "failed", error: "Provider disconnected." }] });
    expect(markup).toContain("Finished schedule");
    expect(markup.match(/Finished schedule/g)).toHaveLength(1);
    expect(markup).toContain("Latest: Failed");
    expect(markup).toContain("Provider disconnected.");
    expect(markup).not.toContain("Latest: Completed");
  });

  it("keeps the state badge where the list cannot pause, and swaps it for a switch where it can", () => {
    expect(list()).toContain(">Active<");
    expect(list()).not.toContain('role="switch"');
    expect(list({ routines: [{ ...routine, enabled: false }] })).toContain(">Paused<");

    const onToggle = vi.fn();
    const on = list({ onToggle });
    expect(on).toContain('role="switch" aria-checked="true"');
    expect(on).toContain('aria-label="Run Morning brief on its schedule"');
    expect(on).not.toContain(">Active<");
    const off = list({ onToggle, routines: [{ ...routine, enabled: false }] });
    expect(off).toContain('role="switch" aria-checked="false"');
    expect(off.match(/>Paused</g)).toHaveLength(1);
  });

  it("leaves a finished one-shot its badge: there is nothing to switch back on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const markup = list({ onToggle: vi.fn(), routines: [{ ...routine, schedule: { type: "once", at: 10 }, enabled: false, nextRunAt: null }] });
    expect(markup).not.toContain('role="switch"');
    expect(markup.match(/Finished schedule/g)).toHaveLength(1);
  });

  it("never advertises a stale next timestamp for a paused routine", () => {
    expect(routineNextLabel({ ...routine, enabled: false })).toBe("Paused");
    expect(list({ routines: [{ ...routine, enabled: false }] })).not.toContain("Next Jan");
  });

  it("chooses a new pending run ahead of an older run that finished later", () => {
    const pending = { ...run, id: "new", createdAt: 200, scheduledFor: 200, status: "waiting" as const, attention: "Waiting for delegated work to finish" };
    expect(latestRoutineRun(routine.id, [{ ...run, finishedAt: 300 }, pending])).toBe(pending);
    expect(list({ runs: [run, pending] })).toContain("Latest: Waiting");
    expect(list({ runs: [run, pending] })).toContain("Waiting for delegated work to finish");
  });
});
