import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const bots = [{
    id: "b1", threadId: "t1", name: "Research Lead", title: "", description: "", notifications: true, color: "green", unread: false, busy: false,
    activity: "idle", modelSelection: { instanceId: "claude", model: "m" }, approvalMode: "ask", alwaysAllow: [], messages: [], activeLeafId: null,
  }];
  return { ...actual, useStore: () => ({ state: { ...actual.initialState, bots }, dispatch: vi.fn() }), api: vi.fn(() => new Promise(() => {})) };
});
const { GroupBars, RunRow } = await import("./UsageSection");

const group = (key: string, label: string) => ({ key, label, turns: 1, input: 1_000, output: 0, cachedInput: 0, costUsd: null });

describe("usage by bot", () => {
  it("shows a renamed bot under its current name, not the name its first usage row was booked under", () => {
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "bot", groups: [group("bot:b1", "Bot 7")] }));
    expect(html).toContain("Research Lead");
    expect(html).not.toContain("Bot 7");
  });

  it("keeps the booked name for a bot that no longer exists", () => {
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "bot", groups: [group("bot:gone", "Old helper")] }));
    expect(html).toContain("Old helper");
  });

  it("names a renamed bot by its current name in the runs list", () => {
    const root = {
      id: "r1", title: "", source: "owner" as const, startedAt: 0, endedAt: 0, running: false, timed: false, usageStatus: "complete" as const,
      bots: [{ id: "b1", name: "Bot 7" }, { id: "gone", name: "Old helper" }],
      durationMs: 0, costUsd: null, tokens: 0, input: 0, cachedInput: 0, output: 0, steps: 0, tools: 0, errors: 0,
    };
    const html = renderToStaticMarkup(createElement(RunRow, { root, onOpen: () => {} }));
    expect(html).toContain("A message to Research Lead");
    expect(html).toContain("Research Lead, Old helper");
    expect(html).not.toContain("Bot 7");
  });
});
