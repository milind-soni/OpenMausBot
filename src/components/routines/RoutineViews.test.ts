import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Routine, RoutineRun } from "@/lib/routines";
import { RoutineList } from "./RoutineList";
import { RoutineLogs } from "./RoutineLogs";
import { latestRoutineRun, routineNextLabel } from "@/lib/routine-display";

const routine: Routine = {
  id: "brief", name: "Morning brief", prompt: "Report progress", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "interval", everyMinutes: 60, anchorAt: 1 }, durationMinutes: 30, nextRunAt: 3_600_000, createdAt: 1, updatedAt: 1,
};
const run: RoutineRun = { id: "run", routineId: routine.id, routineName: routine.name, target: "bot", botId: routine.botId, runOn: "maus", scheduledFor: 100, createdAt: 100, status: "completed", manual: false, output: "Brief prepared." };

function list(props: Partial<Parameters<typeof RoutineList>[0]> = {}) {
  return renderToStaticMarkup(createElement(RoutineList, { routines: [routine], runs: [run], onOpen: vi.fn(), onLogs: vi.fn(), ...props }));
}
function logs(props: Partial<Parameters<typeof RoutineLogs>[0]> = {}) {
  return renderToStaticMarkup(createElement(RoutineLogs, { runs: [run], bots: [], onClearRoutine: vi.fn(), onOpen: vi.fn(), ...props }));
}

afterEach(() => vi.useRealTimers());

describe("routine list", () => {
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

describe("central routine logs", () => {
  it("keeps deleted-routine receipts and distinguishes all run outcomes", () => {
    const statuses = ["queued", "running", "waiting", "completed", "failed", "missed", "cancelled"] as const;
    const markup = logs({ runs: statuses.map((status, index) => ({ ...run, id: `run-${status}`, routineId: `removed-${index}`, routineName: `Routine ${status}`, status })) });
    for (const status of statuses) expect(markup).toContain(`Open Routine ${status} run:`);
    expect(markup).toContain("Bot unavailable");
    expect(markup).toContain("Recent saved runs");
  });

  it("lands on only the requested routine's history", () => {
    const markup = logs({ routineId: "brief", runs: [run, { ...run, id: "other", routineId: "other", routineName: "Private other routine" }] });
    expect(markup).toContain("Open Morning brief run: Completed");
    expect(markup).not.toContain("Private other routine");
    expect(markup).toContain("Show all routines");
  });

  it("does not confuse delegated waiting with an approval request", () => {
    const markup = logs({ runs: [{ ...run, status: "waiting", attention: "Waiting for delegated work to finish" }] });
    expect(markup).toContain("Open Morning brief run: Waiting");
    expect(markup).toContain("Waiting for delegated work to finish");
    expect(markup).not.toContain("Needs your input");
  });

  it("keeps a team-goal block distinct from successful scheduler completion", () => {
    const markup = logs({ runs: [{ ...run, status: "completed", goalStatus: "blocked" }] });
    expect(markup).toContain("Open Morning brief run: Blocked");
  });

  it("provides distinct initial-loading, failure, and empty states", () => {
    expect(logs({ runs: [], loading: true })).toContain("Loading routines…");
    expect(logs({ runs: [], loading: true })).not.toContain("No runs recorded yet");
    expect(logs({ runs: [], error: true })).toContain('role="alert"');
    expect(logs({ runs: [] })).toContain("No runs recorded yet");
  });
});
