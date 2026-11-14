import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

// RoutineCalendarPage imports DesktopCapabilities, which reads window.ogb at import time; the node environment has no
// window.
vi.mock("@/components/DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { routinesLoadState: "ready" }, dispatch }),
}));

// The real list, its props kept for the tests that call its handlers.
const listProps = vi.hoisted(() => ({ last: null as null | { onToggle?: (routine: Routine) => void } }));
vi.mock("../routines/RoutineList", async (importOriginal) => {
  const real = await importOriginal<typeof import("../routines/RoutineList")>();
  return {
    ...real,
    RoutineList: (props: Parameters<typeof real.RoutineList>[0]) => {
      listProps.last = props;
      return real.RoutineList(props);
    },
  };
});

const { RoutinesSection } = await import("./RoutinesSection");

const bot: Bot = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Scout",
  title: "Scout",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "local", model: "test-model" },
  messages: [],
};

const activeRoutine: Routine = {
  id: "r1",
  name: "Morning brief",
  prompt: "Summarize overnight news",
  target: "bot",
  botId: bot.id,
  runOn: "maus",
  enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
  durationMinutes: 5,
  nextRunAt: Date.UTC(2026, 8, 7, 9),
  createdAt: 0,
  updatedAt: 0,
};

const pausedRoutine: Routine = {
  id: "r2",
  name: "Weekly digest",
  prompt: "Summarize the week",
  target: "bot",
  botId: bot.id,
  runOn: "maus",
  enabled: false,
  schedule: { type: "once", at: Date.now() + 86_400_000 },
  durationMinutes: 5,
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const finishedRun: RoutineRun = {
  id: "run-1",
  routineId: "r1",
  routineName: "Morning brief",
  target: "bot",
  botId: bot.id,
  runOn: "maus",
  scheduledFor: Date.UTC(2026, 8, 6, 9),
  status: "completed",
  manual: false,
  finishedAt: Date.UTC(2026, 8, 6, 9, 2),
  createdAt: Date.UTC(2026, 8, 6, 9),
};

function render(routines: Routine[], runs: RoutineRun[]) {
  return renderToStaticMarkup(
    createElement(RoutinesSection, { bot, routines, runs }),
  );
}

describe("RoutinesSection", () => {
  it("shows an empty state when the bot has no routines", () => {
    const markup = render([], []);
    expect(markup).toContain("No schedules yet.");
  });

  it("renders a capitalized schedule sentence and name for each routine", () => {
    const markup = render([activeRoutine, pausedRoutine], []);
    expect(markup).toContain("Every weekday at");
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Weekly digest");
  });

  it("gives each routine an on/off switch, and says Paused under one that is off", () => {
    const markup = render([activeRoutine, pausedRoutine], []);
    expect(markup).toMatch(/aria-label="Run Morning brief on its schedule"[^>]*role="switch" aria-checked="true"/);
    expect(markup).toMatch(/aria-label="Run Weekly digest on its schedule"[^>]*role="switch" aria-checked="false"/);
    expect(markup).not.toContain(">Active<");
    expect(markup).toContain(">Paused<");
  });

  it("pauses and resumes from the switch through the same update the Routines page sends", () => {
    render([activeRoutine, pausedRoutine], []);
    listProps.last!.onToggle!(activeRoutine);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r1", patch: { enabled: false } });
    listProps.last!.onToggle!(pausedRoutine);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r2", patch: { enabled: true } });
  });

  it("shows the next run time for a routine that has one", () => {
    const markup = render([activeRoutine], []);
    expect(markup).toContain("Next Sep");
  });

  it("omits Next for a routine with no future run and shows nothing extra without a run history", () => {
    const markup = render([pausedRoutine], []);
    expect(markup).not.toContain("Next ");
    expect(markup).toContain("Not run yet");
  });

  it("shows the newest run's status without relying on completion order", () => {
    const olderRun: RoutineRun = {
      ...finishedRun,
      id: "run-0",
      status: "failed",
      finishedAt: Date.UTC(2026, 8, 5, 9, 2),
      createdAt: Date.UTC(2026, 8, 5, 9),
    };
    const markup = render([activeRoutine], [olderRun, finishedRun]);
    expect(markup).toContain("Latest: Completed");
    expect(markup).not.toContain("Latest: Failed");
    expect(markup).toContain('aria-label="Run logs for Morning brief"');
  });
});
