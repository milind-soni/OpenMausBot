import { Children, createElement, isValidElement, type ReactNode } from "react";
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
// The real useDesktopCapabilities rides along: it only asks this module for the
// window chrome, and these tests render the desktop-neutral layout.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { initialState } = await import("@/state/store");
const { RoutinesPage } = await import("./RoutineCalendarPage");

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

type Button = { "aria-label"?: string; title?: string; children?: ReactNode; onClick?: () => void };
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : textOf(child)).join("");
}

/** Capture the real page's returned controls under React's hook dispatcher. */
function buttonsFrom(render: () => ReactNode): Map<string, Button> {
  const buttons = new Map<string, Button>();
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (!isValidElement<Button>(child)) return;
      if (child.type === "button") buttons.set(child.props["aria-label"] ?? child.props.title ?? textOf(child.props.children), child.props);
      visit(child.props.children);
    });
  }
  function Capture() { visit(render()); return null; }
  renderToStaticMarkup(createElement(Capture));
  return buttons;
}

function page() {
  return buttonsFrom(() => RoutinesPage({ onBack: vi.fn(), onOpenRoom: vi.fn() }));
}

function markupOf() {
  function Capture() { return RoutinesPage({ onBack: vi.fn(), onOpenRoom: vi.fn() }); }
  return renderToStaticMarkup(createElement(Capture));
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.state = { ...initialState, bots: [bot], routineRuns: [failed, missed, completed] };
});
afterAll(() => vi.unstubAllGlobals());

describe("routine failure indicators", () => {
  it("shows the errors pill and mark-all control only while failures are unread", () => {
    const buttons = page();
    expect(textOf(buttons.get("Open problem run logs")!.children)).toBe("2");
    expect(buttons.has("Mark all as read")).toBe(true);

    fixture.state = { ...initialState, bots: [bot], routineRuns: [
      { ...failed, seenAt: 1 }, { ...missed, seenAt: 1 }, completed,
    ] };
    const read = markupOf();
    expect(read).not.toContain('aria-label="Open problem run logs"');
    expect(read).not.toContain('aria-label="Mark all as read"');
  });

  it("clears every failure indicator in one action from the header", () => {
    page().get("Mark all as read")!.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "markAllRoutineRunsSeen" });
  });

  it("opens the logs on the shared problems set from the errors pill", () => {
    page().get("Open problem run logs")!.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "showRoutines", section: "logs", runStatus: "problems" });
  });

  it("lands the focused problems filter on the logs instead of every status", () => {
    fixture.state = { ...initialState, bots: [bot], routineRuns: [failed, missed, completed],
      routinesFocus: { section: "logs", runStatus: "problems", nonce: 1 } };
    const markup = markupOf();
    expect(markup).toContain("Broken report");
    expect(markup).toContain("Stale digest");
    expect(markup).not.toContain("Fine brief");
    expect(markup).toContain('<option value="problems" selected="">Problems</option>');
  });
});
