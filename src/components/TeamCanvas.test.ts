import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { TeamMapEdge, TeamMapSection } from "@/lib/team-map";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), showThreads: true }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});
const { TeamCanvas } = await import("./TeamCanvas");

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "lead", threadId: "thread-lead", name: "Lead", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    ...overrides,
  };
}

function section(chiefs: Bot[], members: Bot[]): TeamMapSection<Bot>[] {
  return [{ key: "", name: "General", chiefs, members }];
}

function render(sections: TeamMapSection<Bot>[], edges: TeamMapEdge[] = []) {
  return renderToStaticMarkup(createElement(TeamCanvas, {
    sections, edges, canManage: false, onMove: async () => true, onInstructions: () => {},
    onEditTeam: () => {}, onDeleteTeam: () => {}, isEmpty: () => false,
  }));
}

beforeEach(() => {
  fixture.dispatch.mockClear();
});

describe("team canvas motion", () => {
  it("pulses a bot's status dot only while it is working", () => {
    const working = render(section([bot({ busy: true })], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]));
    expect(working).toContain("animate-status-pulse");
    const waiting = render(section([bot({ activity: "waiting-on-you" })], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]));
    expect(waiting).not.toContain("animate-status-pulse");
  });

  it("leaves the lead-to-team arrow static with no handoff", () => {
    const html = render(section([bot()], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]));
    expect(html).not.toContain("animate-link-flow");
  });

  it("animates the lead-to-team arrow while the lead has a running or queued handoff to a teammate", () => {
    const running = render(section([bot()], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]),
      [{ sourceBotId: "lead", targetBotId: "mate", state: "running", threadId: "t-mate" }]);
    expect(running).toContain("animate-link-flow");

    const queued = render(section([bot()], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]),
      [{ sourceBotId: "lead", targetBotId: "mate", state: "queued" }]);
    expect(queued).toContain("animate-link-flow");
  });

  it("leaves the arrow static for a handoff outside this section's own lead and teammate", () => {
    const html = render(section([bot()], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]),
      [{ sourceBotId: "mate", targetBotId: "lead", state: "running", threadId: "t-mate" }]);
    expect(html).not.toContain("animate-link-flow");
  });

  it("leaves a merely-connected (past, not active) handoff static", () => {
    const html = render(section([bot()], [bot({ id: "mate", threadId: "t-mate", name: "Mate" })]),
      [{ sourceBotId: "lead", targetBotId: "mate", state: "connected", groupId: "g1" }]);
    expect(html).not.toContain("animate-link-flow");
  });
});
