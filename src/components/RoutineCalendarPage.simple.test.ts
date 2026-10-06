import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

// Hook-by-call-order harness (as in ModelPicker.simple.test.ts): the page's
// own state survives between captures, so a click followed by a fresh capture
// shows what the page renders next. Effects never run.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    values: [] as unknown[],
    index: 0,
    state: undefined as AppState | undefined,
    dispatch: vi.fn(),
    api: vi.fn(() => new Promise(() => {})),
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { initialState } = await import("@/state/store");
const { EventDetails, EventEditor, RoutinesPage } = await import("./RoutineCalendarPage");
const { calendarRangeLabel, startOfWeek } = await import("@/lib/routine-calendar");
const { scheduleLabel } = await import("@/lib/schedule-label");

afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "runner", threadId: "runner-main", name: "Runner", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: "brief-thread", title: "Morning briefs", createdAt: 1 }],
};
const routine: Routine = {
  id: "brief", name: "Morning brief", prompt: "Summarise my inbox and calendar.", target: "bot", botId: bot.id,
  runOn: "maus", enabled: true, schedule: { type: "daily", time: "06:30", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  durationMinutes: 30, nextRunAt: Date.now() + 3_600_000, createdAt: 0, updatedAt: 0, resultsThreadId: "brief-thread",
};
const cronRoutine: Routine = {
  ...routine, id: "cron", name: "Office hours check", schedule: { type: "cron", expression: "*/20 9-17 * * 1-5", timeZone: "UTC" },
};
const runAt = (day: number, status: RoutineRun["status"]): RoutineRun => ({
  id: `run-${day}`, routineId: routine.id, routineName: routine.name, target: "bot", botId: bot.id, runOn: "maus",
  scheduledFor: day * 86_400_000, createdAt: day * 86_400_000, startedAt: day * 86_400_000,
  finishedAt: day * 86_400_000 + 95_000, status, manual: false,
});
const runs = [runAt(1, "completed"), { ...runAt(2, "failed"), seenAt: 1 }, runAt(3, "completed"), runAt(4, "completed")];

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : textOf(child)).join("");
}
const named = (name: string) => (node: Node) => typeof node.type === "function" && node.type.name === name;

/** One capture of the page's own returned tree, keeping state between calls. */
function capture(render: () => ReactNode): Node[] {
  let tree: Node[] = [];
  function Capture() { fixture.index = 0; tree = nodes(render()); return null; }
  renderToStaticMarkup(createElement(Capture));
  return tree;
}
const page = () => capture(() => RoutinesPage({ onBack: vi.fn(), onOpenRoom: vi.fn() }));
function buttons(tree: Node[]): Map<string, Node["props"]> {
  const map = new Map<string, Node["props"]>();
  for (const node of tree) {
    if (node.type !== "button") continue;
    const props = node.props as { "aria-label"?: string; title?: string; children?: ReactNode };
    map.set(props["aria-label"] ?? props.title ?? textOf(props.children), node.props);
  }
  return map;
}
/** A full render (children included) from fresh state. */
function markup(element: ReactElement): string {
  fixture.values = [];
  fixture.index = 0;
  return renderToStaticMarkup(element);
}
const click = (props: Node["props"] | undefined) => (props!.onClick as () => void)();

function details(item: Parameters<typeof EventDetails>[0]["item"]) {
  const props = { item, bots: [bot], onClose: vi.fn(), onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom: vi.fn(), onOpenRun: vi.fn() };
  return { props, tree: capture(() => EventDetails(props)), html: markup(createElement(EventDetails, props)) };
}
const routineItem = (definition: Routine, run: RoutineRun | null = null) =>
  ({ kind: "routine" as const, id: `next-${definition.id}`, at: definition.nextRunAt ?? 0, durationMinutes: 30, routine: definition, run });

beforeEach(() => {
  fixture.advanced = false;
  fixture.values = [];
  fixture.index = 0;
  fixture.dispatch.mockClear();
  fixture.api.mockClear();
  fixture.state = { ...initialState, bots: [bot], routines: [routine], routineRuns: runs };
});

describe("Routines header", () => {
  it("shows the title, date navigation, view switch, run logs and New routine", () => {
    const tree = page();
    const header = buttons(tree);
    expect(tree.some((node) => node.type === "h1" && textOf(node.props.children) === "Routines")).toBe(true);
    for (const label of ["Previous dates", "Next dates", "Today", "Day", "Week", "List", "Run logs", "New routine"]) {
      expect(header.has(label), label).toBe(true);
    }
    expect(tree.some((node) => textOf(node.props.children) === calendarRangeLabel(startOfWeek(Date.now()), 7))).toBe(true);
    expect(header.get("Week")!["aria-pressed"]).toBe(true);
  });

  it("switches between Day, Week and List", () => {
    let tree = page();
    expect(tree.find(named("CalendarGrid"))!.props.days).toBe(7);

    click(buttons(tree).get("Day"));
    tree = page();
    expect(tree.find(named("CalendarGrid"))!.props.days).toBe(1);
    expect(buttons(tree).get("Day")!["aria-pressed"]).toBe(true);

    click(buttons(tree).get("List"));
    tree = page();
    expect(tree.find(named("CalendarGrid"))).toBeUndefined();
    expect(tree.find(named("RoutineList"))).toBeDefined();
    expect(buttons(tree).has("Previous dates")).toBe(false);

    click(buttons(tree).get("Week"));
    tree = page();
    expect(tree.find(named("CalendarGrid"))!.props.days).toBe(7);
  });

  it("keeps Run logs one click away", () => {
    click(buttons(page()).get("Run logs"));
    expect(page().find(named("RoutineLogs"))).toBeDefined();
  });

  it("offers the Webhooks tab only in Advanced mode", () => {
    expect(buttons(page()).has("Webhooks")).toBe(false);
    fixture.advanced = true;
    fixture.values = [];
    expect(buttons(page()).has("Webhooks")).toBe(true);
  });

  it("opens the plain editor from New routine in Simple mode", () => {
    click(buttons(page()).get("New routine"));
    expect(page().find(named("EventEditor"))!.props.seed).toMatchObject({ kind: "routine", botIds: [] });
  });
});

describe("routine drawer", () => {
  it("opens beside the grid when an occurrence is selected and rings it", () => {
    let tree = page();
    const grid = tree.find(named("CalendarGrid"))!;
    const item = routineItem(routine);
    (grid.props.onOpen as (value: unknown) => void)(item);
    tree = page();
    expect(tree.find(named("EventDetails"))!.props.item).toMatchObject({ id: item.id, routine: { id: routine.id } });
    expect(tree.find(named("CalendarGrid"))!.props.selectedId).toBe(item.id);
  });

  it("shows bot, plain schedule, instructions, where it runs, results and the last three runs", () => {
    const { html } = details(routineItem(routine));
    for (const text of ["Bot", "Runner", "Schedule", scheduleLabel(routine.schedule), "What to do", routine.prompt,
      "Runs on", "This computer", "Post results to", "Morning briefs", "Run logs", "Active"]) {
      expect(html, text).toContain(text);
    }
    expect(html.match(/aria-label="Open Morning brief run:/g)).toHaveLength(3);
    expect(html).toContain("2 min");
  });

  it("opens a recent run in place", () => {
    const { props, tree } = details(routineItem(routine));
    const rows = tree.filter(named("RecentRunRow"));
    expect(rows.map((row) => (row.props.run as RoutineRun).id)).toEqual(["run-4", "run-3", "run-2"]);
    (rows[0]!.props.onOpen as () => void)();
    expect(props.onOpenRun).toHaveBeenCalledWith(runs[3]);
  });

  it("describes the Boat runner in plain words", () => {
    expect(details(routineItem({ ...routine, runOn: "cloud" })).html).toContain("Cloud computer");
  });

  it("Run now and Pause send the same requests as before", () => {
    const { tree } = details(routineItem(routine));
    const controls = buttons(tree);
    click(controls.get("Run now"));
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "runRoutine", routineId: routine.id }));
    click(controls.get("Pause routine"));
    expect(fixture.api).toHaveBeenCalledWith(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  });

  it("offers Resume and a Paused pill for a paused routine", () => {
    const pausedRoutine = { ...routine, enabled: false };
    fixture.state = { ...fixture.state!, routines: [pausedRoutine] };
    const { tree, html } = details(routineItem(pausedRoutine));
    expect(html).toContain("Paused");
    click(buttons(tree).get("Resume routine"));
    expect(fixture.api).toHaveBeenCalledWith(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  });

  it("shows a cron routine's schedule sentence", () => {
    expect(details(routineItem(cronRoutine)).html).toContain(scheduleLabel(cronRoutine.schedule));
  });

  it("keeps Edit and the results thread", () => {
    const { props, tree } = details(routineItem(routine));
    const controls = buttons(tree);
    expect(controls.has("Open results thread")).toBe(true);
    click(controls.get("Edit"));
    expect(props.onEdit).toHaveBeenCalledOnce();
  });
});

describe("routine editor", () => {
  const editor = (routineToEdit?: Routine) => markup(createElement(EventEditor, {
    seed: { kind: "routine", at: Date.now() + 3_600_000, durationMinutes: 30, botIds: [bot.id], routine: routineToEdit },
    bots: [bot], onClose: vi.fn(), onSavedCall: vi.fn(),
  }));
  const hidden = ['<select aria-label="Repeat"', "Routine safety limit", "Runs the whole job on the bot&#x27;s cloud computer", "Add attachment", "Post results to", "Routine type"];

  it("keeps Simple mode to the basics with everything else behind More options", () => {
    const html = editor();
    for (const text of ["New routine", 'placeholder="What should happen?"', "Who does it", "When", "Once", "Every day", "Weekdays", "Every week", "More options"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('aria-expanded="false"');
    for (const text of hidden) expect(html, text).not.toContain(text);
  });

  it("marks the routine's repeat choice", () => {
    expect(editor(routine)).toMatch(/aria-pressed="true"[^>]*>Every day</);
  });

  it("opens More options for a schedule the basics cannot show", () => {
    const html = editor(cronRoutine);
    expect(html).toContain('aria-expanded="true"');
    for (const text of hidden.filter((text) => text !== "Routine type")) expect(html, text).toContain(text);
    expect(html).not.toMatch(/aria-pressed="true"/);
  });

  it("leaves the Advanced editor as it was", () => {
    fixture.advanced = true;
    const html = editor();
    for (const text of ['placeholder="Add title"', '<select aria-label="Repeat"', "Assign a bot", "Runs the whole job on the bot&#x27;s cloud computer", "Post results to", "Routine type", "New event"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain("More options");
    expect(html).not.toContain("What should happen?");
  });
});
