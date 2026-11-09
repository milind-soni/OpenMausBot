// @vitest-environment happy-dom
import { forgetSearchDisclosuresForTests } from "@/lib/search-disclosure";
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/lib/thread-list-navigation", () => ({ useThreadListRequest: () => 0 }));
vi.mock("@/state/store", async (original) => {
  const source = await original<typeof import("@/state/store")>();
  return { ...source, currentTaskBot: (bot: Bot, threadId: string) => ({ ...bot, threadId }) };
});
const { CompactBotThreads } = await import("./CompactBotThreads");

const task = (threadId: string, title: string, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: 1, ...extra });
const base: Bot = {
  id: "atlas", threadId: "current", name: "Atlas", title: "", description: "", notifications: true, color: "green",
  unread: false, modelSelection: { instanceId: "fake", model: "fake" }, messages: [], projects: [{ id: "work", name: "Work Folder" }], tasks: [],
};
let host: HTMLDivElement;
let root: Root;
const render = (bot: Bot, query = "") => flushSync(() => root.render(createElement(CompactBotThreads, { bot, selected: false, query, pendingQueued: { queued: [{}] }, dispatch: fixture.dispatch })));
const ids = () => [...host.querySelectorAll("[data-agent-thread]")].map((row) => row.getAttribute("data-agent-thread"));
const disclose = () => host.querySelector("[aria-expanded]")!.getAttribute("aria-expanded");

beforeEach(() => {
  forgetSearchDisclosuresForTests();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("CompactBotThreads", () => {
  it("opens on search and filters matching titles and folders on an unselected bot", async () => {
    await act(async () => render({ ...base, tasks: [task("current", "Home"), task("match", "A different title", { projectId: "work" }), task("other", "Unrelated")] }));
    expect(disclose()).toBe("false");
    await act(async () => render({ ...base, tasks: [task("current", "Home"), task("match", "A different title", { projectId: "work" }), task("other", "Unrelated")] }, "work folder"));
    expect(disclose()).toBe("true");
    expect(ids()).toEqual(["match"]);
    await act(async () => render({ ...base, tasks: [task("current", "Home"), task("match", "Find the launch plan"), task("other", "Unrelated")] }, "launch"));
    expect(ids()).toEqual(["match"]);
    await act(async () => render({ ...base, tasks: [task("current", "Home"), task("match", "Find the launch plan")] }));
    expect(disclose()).toBe("false");
  });

  it("hides idle snoozed threads but keeps attention and history accessible", async () => {
    const tasks = [
      task("current", "Current", { snoozedUntil: 20_000 }), task("idle", "Idle snoozed", { snoozedUntil: 20_000 }),
      task("pinned", "Pinned", { snoozedUntil: 20_000, pinned: true }), task("unread", "Unread", { snoozedUntil: 20_000, unread: true }),
      task("queued", "Queued", { snoozedUntil: 20_000 }), task("working", "Working", { snoozedUntil: 20_000, activity: "working" }),
      task("waiting", "Waiting", { snoozedUntil: 20_000, activity: "waiting-on-you" }),
      task("teammate", "Teammate", { snoozedUntil: 20_000, waitingForTeammates: true }),
      task("closed", "Completed history", { closedBy: { botId: "human", name: "Human", at: 1 } }),
      task("archived", "Archived history", { archivedAt: 0 }),
    ];
    await act(async () => render({ ...base, tasks }));
    expect(ids()).toEqual(["pinned", "current", "unread", "queued", "working", "waiting", "teammate", "closed", "archived"]);
    await act(async () => { vi.advanceTimersByTime(10_001); });
    expect(ids()).toContain("idle");
  });
});
