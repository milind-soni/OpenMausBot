// The calendar's paused-routines list is a modal dialog: it must hand its
// element to the shared modal keyboard handling (focus in, Tab trapped, Escape
// closes) and name its icon-only close button. Event details are a drawer
// beside the calendar instead (the grid stays usable while it is open), so it
// must not trap focus; the page's own Escape handling closes it.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { Routine } from "../../shared/routines";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { calls: [] as { ref: RefObject<unknown>; onClose: () => void }[] };
});
vi.mock("@/hooks/use-modal-dialog", () => ({
  useModalDialog: (ref: RefObject<unknown>, onClose: () => void) => { fixture.calls.push({ ref, onClose }); },
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { t } = await import("@/lib/i18n");
const { EventDetails, PausedList } = await import("./RoutineCalendarPage");

const bot = {
  id: "runner", threadId: "execution", name: "Runner", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "test" },
} as Bot;
const routine: Routine = {
  id: "weekly", name: "Weekly digest", prompt: "Summarise the week", target: "bot", botId: bot.id,
  runOn: "maus", enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30,
  nextRunAt: null, createdAt: 1, updatedAt: 1,
};

type Props = { children?: ReactNode; ref?: unknown; role?: string; tabIndex?: number; onClick?: () => void; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
}
function render(element: () => ReactNode) {
  let tree: ReactNode;
  function Capture() { tree = element(); return tree; }
  renderToStaticMarkup(createElement(Capture));
  return nodes(tree);
}

beforeEach(() => { fixture.calls = []; });
afterAll(() => vi.unstubAllGlobals());

describe.each([
  {
    name: "paused routines",
    closeLabel: t("routines.paused.close"),
    render: (onClose: () => void) => PausedList({ routines: [routine], bots: [bot], groups: [], onClose, onEdit: vi.fn(), onOpenRoom: vi.fn() }),
  },
])("calendar $name dialog", ({ closeLabel, render: dialog }) => {
  it("hands its dialog element to the modal keyboard handling", () => {
    const onClose = vi.fn();
    const tree = render(() => dialog(onClose));
    const element = tree.find((node) => node.props.role === "dialog")!;
    expect(fixture.calls).toHaveLength(1);
    expect(element.props.ref).toBe(fixture.calls[0]!.ref);
    // focusable itself, so focus can land on it when it has no field to start in
    expect(element.props.tabIndex).toBe(-1);
    fixture.calls[0]!.onClose();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("names its close button", () => {
    const onClose = vi.fn();
    const close = render(() => dialog(onClose)).find((node) => node.type === "button" && node.props["aria-label"] === closeLabel);
    expect(close).toBeDefined();
    close!.props.onClick!();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("calendar event details drawer", () => {
  const drawer = (onClose: () => void) => EventDetails({
    item: { kind: "routine", id: routine.id, at: 1, durationMinutes: 30, routine, run: null },
    bots: [bot], onClose, onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom: vi.fn(),
  });

  it("is a labelled drawer beside the calendar, not a focus-trapping modal", () => {
    const tree = render(() => drawer(vi.fn()));
    expect(tree.find((node) => node.type === "aside" && node.props["aria-label"] === t("routines.drawer.label"))).toBeDefined();
    expect(tree.some((node) => node.props.role === "dialog")).toBe(false);
    expect(fixture.calls).toHaveLength(0);
  });

  it("names its close button", () => {
    const onClose = vi.fn();
    const close = render(() => drawer(onClose)).find((node) => node.type === "button" && node.props["aria-label"] === t("routines.drawer.close"));
    expect(close).toBeDefined();
    close!.props.onClick!();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
