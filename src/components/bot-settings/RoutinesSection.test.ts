import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

// RoutinesSection mounts RoutineEditor from RoutineCalendarPage.tsx (only
// when "New schedule" is clicked, which these tests never do) but that
// module's top-level import of DesktopCapabilities reads `window.ogb` at
// import time; the src test suite runs under vitest's "node" environment
// (no window), so it must be stubbed as SidebarBotListItem.test.ts does.
vi.mock("@/components/DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));

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
  schedule: { type: "once", at: Date.UTC(2026, 8, 10, 12) },
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
    createElement(StoreProvider, null, createElement(RoutinesSection, { bot, routines, runs })),
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

  it("chips an enabled routine Active and a disabled one Paused", () => {
    const markup = render([activeRoutine, pausedRoutine], []);
    expect(markup).toContain(">Active<");
    expect(markup).toContain(">Paused<");
  });

  it("shows the next run time for a routine that has one", () => {
    const markup = render([activeRoutine], []);
    expect(markup).toMatch(/Next \d{1,2}:\d{2}/);
  });

  it("omits Next for a routine with no future run and shows nothing extra without a run history", () => {
    const markup = render([pausedRoutine], []);
    expect(markup).not.toContain("Next ");
    expect(markup).not.toContain("Last ");
  });

  it("shows the newest run's status and time as Last, picking the latest by finishedAt", () => {
    const olderRun: RoutineRun = {
      ...finishedRun,
      id: "run-0",
      status: "failed",
      finishedAt: Date.UTC(2026, 8, 5, 9, 2),
    };
    const markup = render([activeRoutine], [olderRun, finishedRun]);
    expect(markup).toMatch(/Last completed \d{1,2}:\d{2}/);
    expect(markup).not.toContain("Last failed");
  });
});
