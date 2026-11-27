import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";
import type { RoutineRun } from "@/lib/routines";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { state: undefined as AppState | undefined, dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }) };
});
// The real useDesktopCapabilities rides along: it only asks this module for the window chrome.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { initialState } = await import("@/state/store");
const { TriggersPage: RoutinesPage } = await import("./TriggersPage");

const bot: Bot = {
  id: "runner", threadId: "execution", name: "Runner", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "test" },
};
const failed: RoutineRun = {
  id: "failed-run", routineId: "broken", routineName: "Broken report", target: "bot", botId: bot.id,
  runOn: "maus", scheduledFor: 100, createdAt: 100, status: "failed", manual: false, error: "Provider crashed",
};
const missed: RoutineRun = { ...failed, id: "missed-run", routineId: "stale", routineName: "Stale digest", status: "missed" };
const completed: RoutineRun = { ...failed, id: "fine-run", routineId: "fine", routineName: "Fine brief", status: "completed" };

function markupOf() {
  function Capture() { return RoutinesPage({ onBack: vi.fn(), onOpenRoom: vi.fn() }); }
  return renderToStaticMarkup(createElement(Capture));
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.state = { ...initialState, bots: [bot], routineRuns: [failed, missed, completed] };
});
afterAll(() => vi.unstubAllGlobals());

describe("failures on the Automations page", () => {
  const routine = (id: string, name: string) => ({
    id, name, prompt: `Write the ${name.toLowerCase()}.`, target: "bot" as const, botId: bot.id, runOn: "maus" as const, enabled: true,
    schedule: { type: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: Date.now() + 3_600_000, createdAt: 0, updatedAt: 0,
  });

  it("shows a schedule that failed twice running as Needs you, first, with Run now to fix it", () => {
    fixture.state = { ...initialState, bots: [bot], routines: [routine("fine", "Fine brief"), routine("broken", "Broken report")], routineRuns: [
      { ...failed, id: "f1", scheduledFor: 200, createdAt: 200 }, { ...failed, id: "f2", scheduledFor: 100, createdAt: 100 }, completed,
    ] };
    const markup = markupOf();
    expect(markup.indexOf("writes the broken report")).toBeGreaterThan(-1);
    expect(markup.indexOf("writes the broken report")).toBeLessThan(markup.indexOf("writes the fine brief"));
    expect(markup).toContain("Needs you: It didn&#x27;t finish the last 2 times.");
    expect(markup).toContain("Run now</button>");
  });

  it("keeps a schedule Working after one failure it recovered from, with no problem pill or run logs", () => {
    fixture.state = { ...initialState, bots: [bot], routines: [routine("fine", "Fine brief")], routineRuns: [
      { ...completed, scheduledFor: 300, createdAt: 300 }, { ...failed, id: "old", routineId: "fine", scheduledFor: 100, createdAt: 100 },
    ] };
    const markup = markupOf();
    expect(markup).not.toContain("Needs you");
    expect(markup).not.toMatch(/Open problem run logs|Mark all as read|Run logs/);
  });

  it("lands a 'problems' link from a chat or notice on the list, needs-you first, instead of a separate log", () => {
    fixture.state = { ...initialState, bots: [bot], routines: [routine("broken", "Broken report")], routineRuns: [failed, { ...failed, id: "f0", scheduledFor: 50, createdAt: 50 }],
      routinesFocus: { section: "logs", runStatus: "problems", nonce: 1 } };
    expect(markupOf()).toContain("Needs you: It didn&#x27;t finish the last 2 times.");
  });
});
