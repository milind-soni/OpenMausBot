import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMapSession } from "@/lib/team-map";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), showThreads: true, groups: [] as unknown[] }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, groups: fixture.groups }, dispatch: fixture.dispatch }) };
});
const { TeamMapSessions } = await import("./TeamMapSessions");

function session(overrides: Partial<TeamMapSession> = {}): TeamMapSession {
  return { botId: "ada", threadId: "ada-1", title: "Fix the flaky test", state: "running", startedAt: 0, ...overrides };
}

function clickFirst(sessions: TeamMapSession[]) {
  let tree: ReactNode;
  function Capture() { tree = TeamMapSessions({ sessions, now: 0 }); return tree; }
  renderToStaticMarkup(createElement(Capture));
  const buttons = (tree as ReactElement<{ children: ReactNode[] }>).props.children as ReactNode[];
  const [cards] = buttons;
  (cards as ReactElement<{ onClick: () => void }>[])[0].props.onClick();
  return fixture.dispatch.mock.calls.map(([action]) => action);
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.showThreads = true;
  fixture.groups = [];
});

describe("team map session cards", () => {
  it("renders nothing under a bot with no open sessions", () => {
    expect(renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [], now: 0 }))).toBe("");
  });

  it("shows each state as readable text, never colour alone", () => {
    for (const [state, label] of [["running", "Working"], ["stuck", "Stuck"], ["waiting", "Waiting for you"], ["queued", "Queued"]] as const) {
      const html = renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [session({ state })], now: 0 }));
      expect(html).toContain(label);
    }
  });

  it("marks an estimated cost and leaves a settled one unmarked", () => {
    const estimated = renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [session({ usd: 1.2, usdEstimated: true })], now: 0 }));
    expect(estimated).toContain("Estimated");
    const settled = renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [session({ usd: 1.2, usdEstimated: false })], now: 0 }));
    expect(settled).not.toContain("Estimated");
    expect(settled).toContain("1.20");
  });

  it("shows no cost when the server has none to report", () => {
    const html = renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [session()], now: 0 }));
    expect(html).not.toContain("Estimated");
  });

  it("caps the visible stack at four cards and counts the rest", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session({ threadId: `t${index}`, startedAt: index }));
    const html = renderToStaticMarkup(createElement(TeamMapSessions, { sessions, now: 0 }));
    expect(html).toContain("+2 more");
  });

  it("puts a stuck session ahead of a running one regardless of start time", () => {
    const sessions = [session({ threadId: "old-running", state: "running", startedAt: 100 }), session({ threadId: "new-stuck", state: "stuck", startedAt: 1 })];
    const html = renderToStaticMarkup(createElement(TeamMapSessions, { sessions, now: 0 }));
    expect(html.indexOf("Stuck")).toBeLessThan(html.indexOf("Working"));
  });

  it("opens the room when the session is on the room's own thread", () => {
    fixture.groups = [{ id: "room-1", threadId: "room-main", tasks: [] }];
    const actions = clickFirst([session({ groupId: "room-1", threadId: "room-main" })]);
    expect(actions).toContainEqual({ type: "select", id: "room-1" });
    expect(actions.some((action) => (action as { type: string }).type === "switchGroupTask")).toBe(false);
  });

  it("opens the room's side task itself when the session is on one", () => {
    fixture.groups = [{ id: "room-1", threadId: "room-main", tasks: [{ threadId: "room-side" }] }];
    const actions = clickFirst([session({ groupId: "room-1", threadId: "room-side" })]);
    expect(actions).toContainEqual({ type: "select", id: "room-1" });
    expect(actions).toContainEqual({ type: "switchGroupTask", groupId: "room-1", threadId: "room-side" });
  });

  it("opens the bot's own thread when the session has no room", () => {
    fixture.showThreads = false;
    const actions = clickFirst([session({ botId: "ada", threadId: "ada-chat" })]);
    expect(actions).toContainEqual({ type: "revealThread", threadId: "ada-chat" });
  });

  it("pulses only the running session's dot, leaving stuck, waiting and queued still", () => {
    for (const [state, shouldPulse] of [["running", true], ["stuck", false], ["waiting", false], ["queued", false]] as const) {
      const html = renderToStaticMarkup(createElement(TeamMapSessions, { sessions: [session({ state })], now: 0 }));
      expect(html.includes("animate-status-pulse")).toBe(shouldPulse);
    }
  });
});
