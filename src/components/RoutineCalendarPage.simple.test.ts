import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

// Hook-by-call-order harness: the page's own state survives between captures, so a click then a fresh capture shows
// what renders next. Effects never run.
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
const { EventDetails, EventEditor, RoutineEditor } = await import("./RoutineCalendarPage");
const { TriggersPage: RoutinesPage } = await import("./TriggersPage");
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

describe("Automations page", () => {
  const failing: RoutineRun = { ...runAt(5, "failed"), id: "fail-1", routineId: "inbox", routineName: "Inbox check", error: "Claude is signed out" };
  const inbox: Routine = { ...routine, id: "inbox", name: "Inbox check", prompt: "Check the inbox for urgent mail.", nextRunAt: Date.now() + 7_200_000 };

  it("shows the title, List · Calendar, and New, and nothing else above the list", () => {
    const tree = page();
    const header = buttons(tree);
    expect(tree.some((node) => node.type === "h1" && textOf(node.props.children) === "Automations")).toBe(true);
    for (const label of ["List", "Calendar", "New"]) expect(header.has(label), label).toBe(true);
    for (const gone of ["Day", "Week", "History", "Run logs", "All", "Schedules", "Webhooks"]) expect(header.has(gone), gone).toBe(false);
    expect(header.get("List")!["aria-pressed"]).toBe(true);
  });

  it("lists each automation as one sentence with a plain status line and a switch", () => {
    const html = markup(createElement(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() }));
    expect(html).toContain("Every day at 6:30 AM, Runner summarises my inbox and calendar".replace("my inbox", "your inbox"));
    expect(html).toMatch(/On · last ran [^<]+ · next: [^<]+/);
    expect(html).not.toMatch(/Latest: |Not run yet|runs OK this week|Run logs/);
  });

  it("puts Needs you first, with its plain reason and the one button that fixes it", () => {
    fixture.state = { ...fixture.state!, routines: [routine, inbox], routineRuns: [...runs, failing] };
    const html = markup(createElement(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() }));
    expect(html.indexOf('data-automation-status="needs-you"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-automation-status="needs-you"')).toBeLessThan(html.indexOf('data-automation-status="working"'));
    expect(html).toContain("Needs you: It&#x27;s signed out. Sign in again so it can run.");
    expect(html).toContain("Sign in</button>");
  });

  it("opens one simple panel from its name", () => {
    click(buttons(page()).get("Morning brief"));
    expect(page().find(named("AutomationPanel"))!.props.automation).toMatchObject({ id: routine.id, kind: "schedule" });
  });

  it("switches to the calendar, where an event opens the same panel", () => {
    click(buttons(page()).get("Calendar"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", view: "calendar", botId: undefined });
    fixture.state = { ...fixture.state!, routinesFocus: { view: "calendar", nonce: 1 } };
    let tree = page();
    const calendar = tree.find(named("AutomationsCalendar"))!;
    expect(calendar).toBeDefined();
    (calendar.props.onOpenAutomation as (id: string) => void)(routine.id);
    tree = page();
    expect(tree.find(named("AutomationPanel"))!.props.automation).toMatchObject({ id: routine.id });
  });

  it("opens the New box, and shows the bot filter only for a long list shared by several bots", () => {
    click(buttons(page()).get("New"));
    expect(page().find(named("NewAutomation"))!.props.initialText).toBe("");
    expect(page().some((node) => node.props["aria-label"] === "All bots")).toBe(false);
    const many = Array.from({ length: 9 }, (_, index) => ({ ...routine, id: `r${index}`, botId: index % 2 ? bot.id : "other" }));
    fixture.state = { ...fixture.state!, routines: many, bots: [bot, { ...bot, id: "other", name: "Other" }] };
    expect(page().some((node) => node.props["aria-label"] === "All bots")).toBe(true);
  });

  it("starts Set it up yourself with the bot the New box would have asked, else the only bot, so Save is not dead", () => {
    click(buttons(page()).get("New"));
    (page().find(named("NewAutomation"))!.props.onSetUpYourself as (kind: string, botId: string) => void)("schedule", bot.id);
    const editor = page().find(named("RoutineEditor"))!;
    expect(editor.props.initialBotId).toBe(bot.id);
    const chosen = (props: Record<string, unknown>) => (RoutineEditor(props as never) as ReactElement<{ seed: { botIds: string[] } }>).props.seed.botIds;
    const other = { ...bot, id: "other", name: "Other" };
    expect(chosen(editor.props)).toEqual([bot.id]);
    expect(chosen({ ...editor.props, initialBotId: "other", bots: [bot, other] })).toEqual(["other"]);
    expect(chosen({ ...editor.props, initialBotId: undefined })).toEqual([bot.id]);
    expect(chosen({ ...editor.props, initialBotId: undefined, bots: [bot, other] })).toEqual([]);
  });

  it("starts the webhook editor with the bot the New box would have asked too", async () => {
    const { WebhookEditor } = await import("./WebhookTrigger");
    click(buttons(page()).get("New"));
    (page().find(named("NewAutomation"))!.props.onSetUpYourself as (kind: string, botId: string) => void)("webhook", bot.id);
    expect(page().find(named("WebhookEditor"))!.props.initialBotId).toBe(bot.id);
    const other = { ...bot, id: "other", name: "Other" };
    fixture.values = [];
    const tree = capture(() => WebhookEditor({ bots: [bot, other], initialBotId: "other", onClose: vi.fn(), onCredential: vi.fn() }));
    const picked = tree.filter((node) => node.type === "button" && String(node.props.className).includes("border-accent/70")).map((node) => textOf(node.props.children));
    expect(picked).toContain("Other");
    expect(picked).not.toContain(bot.name);
  });

  it("greets an empty list, and its example fills the New box", () => {
    fixture.state = { ...fixture.state!, hydrated: true, routines: [], webhooks: [], routineRuns: [], routinesLoadState: "ready" };
    const html = markup(createElement(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() }));
    expect(html).toContain("Your bots can do things on their own.");
    expect(html).toContain("Try: every morning, summarize my inbox");
    click(buttons(page()).get("Try: every morning, summarize my inbox"));
    expect(page().find(named("NewAutomation"))!.props.initialText).toBe("every morning, summarize my inbox");
  });
});

describe("routine drawer", () => {
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
    expect(details(routineItem({ ...routine, runOn: "cloud" })).html).toContain("Cloud desktop");
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
  const hidden = ['<select aria-label="Repeat"', "Routine safety limit", "Runs the whole job on the bot&#x27;s cloud desktop", "Add attachment", "Post results to", "Routine type"];

  it("keeps Simple mode to the basics with everything else behind More options", () => {
    const html = editor();
    for (const text of ["New routine", 'placeholder="What should happen?"', "Who does it", "When", "Once", "Every day", "Weekdays", "Every week", "More options"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('aria-expanded="false"');
    for (const text of hidden) expect(html, text).not.toContain(text);
    expect(html).toMatch(/>Save<\/button>/);
    expect(html).not.toMatch(/routine<\/button>/i);
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

  it("shows a saved startup choice when the simple editor opens", () => {
    const html = editor({ ...routine, runOnStartup: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<input type="checkbox" aria-label="Also run when MausBot starts"[^>]*checked[^>]*>/);
  });

  it("offers Remember the last run for a repeating routine, off unless the routine has it", () => {
    expect(editor(routine)).toMatch(/<input type="checkbox" aria-label="Remember the last run"(?![^>]*checked)[^>]*>/);
    expect(editor({ ...routine, continuity: true })).toMatch(/<input type="checkbox" aria-label="Remember the last run"[^>]*checked[^>]*>/);
    expect(editor(routine)).toContain("Each run starts with the previous run&#x27;s report");
  });

  it("schedules a goal in the bot's own chat when no group is chosen", () => {
    const ownGoal: Routine = { ...routine, id: "own-goal", name: "Ship the fix", target: "room-goal", groupId: undefined, resultsThreadId: undefined };
    const html = editor(ownGoal);
    expect(html).toContain("Where it runs");
    expect(html).toMatch(/<option value="" selected="">Just the bot, in its own chat<\/option>/);
    expect(html).toContain("The bot works on the goal in its own chat until it is done.");
    expect(html).toContain("Runner");
    expect(html).not.toContain("Create a group from the sidebar first");

    fixture.values = [];
    const props = { seed: { kind: "routine" as const, at: Date.now() + 3_600_000, durationMinutes: 30, botIds: [bot.id], routine: ownGoal }, bots: [bot], onClose: vi.fn(), onSavedCall: vi.fn() };
    click(buttons(capture(() => EventEditor(props))).get("Save"));
    const [, init] = fixture.api.mock.calls.at(-1) as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ target: "room-goal", botId: bot.id, groupId: null });
  });

  it("hides Remember the last run for a one-time routine", () => {
    expect(editor()).not.toContain("Remember the last run");
  });

  it("saves the switch with the routine, and turning it off saves false", () => {
    const props = {
      seed: { kind: "routine" as const, at: Date.now() + 3_600_000, durationMinutes: 30, botIds: [bot.id], routine },
      bots: [bot], onClose: vi.fn(), onSavedCall: vi.fn(),
    };
    fixture.values = [];
    let tree = capture(() => EventEditor(props));
    const toggle = () => tree.find((node) => node.type === "input" && node.props["aria-label"] === "Remember the last run")!;
    (toggle().props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = capture(() => EventEditor(props));
    expect(toggle().props.checked).toBe(true);
    click(buttons(tree).get("Save"));
    const [path, init] = fixture.api.mock.calls.at(-1) as unknown as [string, { method: string; body: string }];
    expect(path).toBe(`/api/routines/${routine.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ continuity: true });

    fixture.values = [];
    const on = { ...props, seed: { ...props.seed, routine: { ...routine, continuity: true } } };
    tree = capture(() => EventEditor(on));
    (toggle().props.onChange as (event: unknown) => void)({ target: { checked: false } });
    tree = capture(() => EventEditor(on));
    click(buttons(tree).get("Save"));
    const [, off] = fixture.api.mock.calls.at(-1) as unknown as [string, { body: string }];
    expect(JSON.parse(off.body)).toMatchObject({ continuity: false });
  });

  it("turns a one-time routine that already happened back on when it is saved with a new time, and leaves any other's switch alone", async () => {
    const save = async (saved: Routine) => {
      fixture.values = [];
      const props = { seed: { kind: "routine" as const, at: Date.now() + 3_600_000, durationMinutes: 30, botIds: [bot.id], routine: saved }, bots: [bot], onClose: vi.fn(), onSavedCall: vi.fn() };
      click(buttons(capture(() => EventEditor(props))).get("Save"));
      await vi.waitFor(() => expect(fixture.api).toHaveBeenCalled());
      const [, init] = fixture.api.mock.calls.at(-1) as unknown as [string, { body: string }];
      fixture.api.mockClear();
      return JSON.parse(init.body);
    };
    const once = { ...routine, schedule: { type: "once" as const, at: Date.now() - 3_600_000 }, nextRunAt: null };
    expect(await save({ ...once, enabled: false })).toMatchObject({ enabled: true });
    expect(await save({ ...once, enabled: false, schedule: { type: "once", at: Date.now() + 7_200_000 } })).not.toHaveProperty("enabled");
    expect(await save({ ...routine, enabled: false })).not.toHaveProperty("enabled");
  });

  it("shows a routine with no thread of its own reporting into the bot's main thread", () => {
    fixture.advanced = true;
    const { resultsThreadId: _chosen, ...unchosen } = routine;
    const destination = (html: string) => html.slice(html.indexOf("Post results to")).match(/^[\s\S]*?<\/select>/)![0];
    expect(destination(editor(unchosen))).toContain('<option value="new" selected="">The bot&#x27;s main thread</option>');
    expect(destination(editor(routine))).toContain('<option value="brief-thread" selected="">Morning briefs</option>');
  });

  it("leaves the Advanced editor as it was", () => {
    fixture.advanced = true;
    const html = editor();
    for (const text of ['placeholder="Add title"', '<select aria-label="Repeat"', "Assign a bot", "Runs the whole job on the bot&#x27;s cloud desktop", "Post results to", "Routine type", "New event"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain("More options");
    expect(html).not.toContain("What should happen?");
  });
});
