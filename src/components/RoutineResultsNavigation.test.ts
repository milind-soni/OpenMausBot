import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { state: undefined as AppState | undefined, dispatch: vi.fn(), showThreads: true };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }) };
});
// The real useCaptionChrome rides along: it only asks this module for the window chrome.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { initialState } = await import("@/state/store");
const { EventDetails } = await import("./RoutineCalendarPage");
const { ChatView } = await import("./ChatView");

const bot: Bot = {
  id: "runner", threadId: "execution", name: "Runner", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "test" },
  tasks: [
    { threadId: "execution", title: "Run details", createdAt: 1, routineRunId: "run", busy: false },
    { threadId: "new-results", title: "New destination", createdAt: 2 },
    { threadId: "original-source", title: "Original conversation", createdAt: 0 },
  ],
};
const group: Group = {
  id: "room", threadId: "current-room-thread", name: "Team", memberIds: [bot.id],
  createdAt: 0, messages: [], unread: false, defaultResponder: { kind: "mentions" }, bulletin: "",
  tasks: [
    { threadId: "current-room-thread", title: "Current", createdAt: 2 },
    { threadId: "original-room-source", title: "Original request", createdAt: 0 },
  ],
};
const routine: Routine = {
  id: "routine", name: "Daily report", prompt: "Report progress", target: "bot", botId: bot.id,
  runOn: "maus", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] },
  durationMinutes: 30, nextRunAt: 1_000, createdAt: 0, updatedAt: 2,
  resultsThreadId: "new-results", sourceThreadId: "original-source",
};
const run: RoutineRun = {
  id: "run", routineId: routine.id, routineName: routine.name, target: "bot", botId: bot.id,
  runOn: "maus", threadId: "execution", sourceThreadId: "original-source", scheduledFor: 100,
  createdAt: 100, finishedAt: 200, status: "completed", manual: false,
};

type Button = { children?: ReactNode; onClick?: () => void };
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : textOf(child)).join("");
}

/** Captures the real component's returned controls under React's hook dispatcher. */
function buttonsFrom(render: () => ReactNode): Map<string, Button> {
  const buttons = new Map<string, Button>();
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (!isValidElement<Button>(child)) return;
      if (child.type === "button") buttons.set(textOf(child.props.children), child.props);
      visit(child.props.children);
    });
  }
  function Capture() { visit(render()); return null; }
  renderToStaticMarkup(createElement(Capture));
  return buttons;
}

function details(receipt: RoutineRun | null = run, definition: Routine | null = routine) {
  const onClose = vi.fn();
  const buttons = buttonsFrom(() => EventDetails({
    item: { kind: "routine", id: receipt?.id ?? definition!.id, at: 100, durationMinutes: 30, routine: definition, run: receipt },
    bots: fixture.state!.bots, onClose, onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom: vi.fn(),
  }));
  return { buttons, onClose };
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.showThreads = true;
  fixture.state = { ...initialState, bots: [bot], groups: [group], routines: [routine], routineRuns: [run] };
});
afterAll(() => vi.unstubAllGlobals());

describe("routine results navigation", () => {
  it("opens a historical run's source, not a destination configured after that run", () => {
    const { buttons, onClose } = details();
    expect(buttons.has("Open results thread")).toBe(true);
    buttons.get("Open results thread")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: bot.id }],
      [{ type: "switchTask", botId: bot.id, threadId: "original-source" }],
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the definition's destination only for a definition-only view", () => {
    details(null).buttons.get("Open results thread")!.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: bot.id, threadId: "new-results" });
  });

  it("opens the bot's main thread for a definition with no thread of its own, never for a run", () => {
    const { resultsThreadId: _chosen, ...unchosen } = routine;
    fixture.state!.bots = [{ ...bot, mainThreadId: "original-source" }];
    details(null, unchosen).buttons.get("Open results thread")!.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: bot.id, threadId: "original-source" });
    expect(details({ ...run, sourceThreadId: undefined }, unchosen).buttons.has("Open results thread")).toBe(false);
  });

  it("does not redirect a deleted run destination to its source or the current definition", () => {
    expect(details({ ...run, resultsThreadId: "deleted-destination" }).buttons.has("Open results thread")).toBe(false);
    expect(details({ ...run, sourceThreadId: undefined }).buttons.has("Open results thread")).toBe(false);
  });

  it("opens the original group task from a historical run even when the definition has changed", () => {
    details({ ...run, sourceThreadId: "original-room-source" }).buttons.get("Open results thread")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: group.id }],
      [{ type: "switchGroupTask", groupId: group.id, threadId: "original-room-source" }],
    ]);
  });

  it("returns from an execution chat to its group-owned source task", () => {
    fixture.state!.routineRuns = [{ ...run, sourceThreadId: "original-room-source" }];
    const buttons = buttonsFrom(() => ChatView({ bot }));
    expect(buttons.has("Back to results")).toBe(true);
    buttons.get("Back to results")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: group.id }],
      [{ type: "switchGroupTask", groupId: group.id, threadId: "original-room-source" }],
    ]);
  });

  it("with threads hidden opens the run's thread or its results by the switch alone, leaving the thread the bot was on unread", () => {
    fixture.showThreads = false;
    const { buttons } = details();
    buttons.get("Open results thread")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "switchTask", botId: bot.id, threadId: "original-source" }]]);
    fixture.dispatch.mockClear();
    fixture.state!.bots = [{ ...bot, threadId: "new-results" }];
    details().buttons.get("Open thread")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "switchTask", botId: bot.id, threadId: "execution" }]]);
    fixture.showThreads = true;
    fixture.dispatch.mockClear();
    details().buttons.get("Open thread")!.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: bot.id }],
      [{ type: "switchTask", botId: bot.id, threadId: "execution" }],
    ]);
  });

  it("omits Back to results when the execution's recorded destination was deleted", () => {
    fixture.state!.routineRuns = [{ ...run, resultsThreadId: "deleted-destination" }];
    expect(buttonsFrom(() => ChatView({ bot })).has("Back to results")).toBe(false);
  });

  it("shows no run-details bar in a chat a run only joined, like a wait's follow-up or a limit-reset continuation", () => {
    const chat = { ...bot, threadId: "original-source" };
    fixture.state!.bots = [chat];
    fixture.state!.routineRuns = [{ ...run, id: "joined", threadId: "original-source", resultsThreadId: "original-source", sourceThreadId: undefined }, run];
    expect(buttonsFrom(() => ChatView({ bot: chat })).has("Run logs")).toBe(false);
    expect(buttonsFrom(() => ChatView({ bot })).has("Run logs")).toBe(true);
    fixture.state!.routineRuns = [{ ...run, id: "joined", threadId: "original-source" }, run];
    expect(buttonsFrom(() => ChatView({ bot: chat })).has("Run logs")).toBe(false);
    expect(buttonsFrom(() => ChatView({ bot })).has("Run logs")).toBe(true);
  });
});
