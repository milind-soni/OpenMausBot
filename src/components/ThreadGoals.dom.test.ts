// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishLiveFrame } from "@/lib/live-events";
import { ApiError } from "@/state/api";
import type { Action, AppState, Bot, Group, Message } from "@/state/store";
import { StoreRefContext } from "@/state/store-ref-context";
import { ThreadGoals } from "./ThreadGoals";

const fixture = vi.hoisted(() => ({ api: vi.fn(), viewer: "first@example.org" }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/default-bot", () => ({ useViewerEmail: () => fixture.viewer }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  fixture.api.mockReset();
  fixture.viewer = "first@example.org";
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const row = (id: string, at: number, parentId?: string): Message => ({ id, at, parentId, role: "bot", kind: "text", text: id });
const goal = (id: string, at: number, status: NonNullable<Message["goalRun"]>["status"], parentId?: string): Message => ({
  ...row(id, at, parentId),
  kind: "goal.run",
  goalRun: { runId: id, goal: id, status, turnCount: 2, maxTurns: 10, coordinatorBotId: "bot", coordinatorName: "Scout", startedAt: at,
    ...(status !== "working" ? { finishedAt: at + 50 } : {}) },
});
const button = (name: string) => [...document.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
const click = (name: string) => act(async () => { button(name).click(); });
const latestTitle = () => document.querySelector("[aria-label=Goals] h2")?.textContent;
const listedGoals = () => [...document.querySelectorAll("[role=dialog] li h3")].map((heading) => heading.textContent);
const cursor = (path: string) => new URL(path, "http://test").searchParams.get("before");

async function mount(thread: Pick<Bot, "threadId" | "messages" | "hasMore"> & { activeLeafId?: string }, botId?: string, canSwitchVersion = false) {
  const state = { bots: botId ? [thread as Bot] : [], groups: botId ? [] : [thread as Group], transcriptGeneration: { [thread.threadId]: 3 } } as AppState;
  const dispatch = vi.fn((action: Action) => {
    if (action.type === "olderMessages") thread.messages = [...action.messages, ...thread.messages];
  });
  const mounted = root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const render = () => act(async () => mounted.render(createElement(StoreRefContext.Provider, {
    value: { dispatch, state: () => state },
  }, createElement(ThreadGoals, { key: thread.threadId, thread, botId, canSwitchVersion }))));
  await render();
  return { dispatch, render };
}

it("pins a far-back goal before the panel opens and pages only goals until the reader requests a jump", async () => {
  const latest = goal("Newest goal", 30, "working");
  const oldest = goal("Oldest goal", 10, "paused");
  const pages: Record<string, { messages: Message[]; hasMore: boolean }> = {
    tail: { messages: [row("p2", 4_000)], hasMore: true },
    p2: { messages: [row("p1", 20), latest], hasMore: true },
    p1: { messages: [oldest], hasMore: false },
  };
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/threads/room-thread/goals?limit=1") return { messages: [latest], nextBefore: latest.id };
    if (path === "/api/threads/room-thread/goals?before=Newest+goal") return { messages: [oldest], nextBefore: null };
    return pages[cursor(path)!];
  });
  const thread = { threadId: "room-thread", messages: [row("tail", 5_000)], hasMore: true };
  const { dispatch } = await mount(thread);
  expect(latestTitle()).toBe("Newest goal");
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/threads/room-thread/goals?limit=1", expect.objectContaining({ background: true }));
  expect(thread.messages.map((message) => message.id)).toEqual(["tail"]);

  await click("Goals");
  expect(fixture.api.mock.calls.map(([path]) => path)).toEqual([
    "/api/threads/room-thread/goals?limit=1", "/api/threads/room-thread/goals?before=Newest+goal",
  ]);
  expect(latestTitle()).toBe("Newest goal");
  expect(listedGoals()).toEqual(["Newest goal", "Oldest goal"]);
  expect(button("Dismiss goal card for Newest goal")).toBeUndefined();

  const completed = { ...latest, goalRun: { ...latest.goalRun!, status: "completed" as const, finishedAt: 75 } };
  await act(async () => publishLiveFrame({ kind: "message.patch", threadId: thread.threadId, message: completed }));
  expect(document.querySelector("[aria-label=Goals]")?.textContent).toContain("Completed");
  expect(document.querySelector("[role=dialog] li")?.textContent).toMatch(/Completed · 2 turns.*Started .*Ended /);
  expect(document.querySelector("[role=dialog] li:last-child")?.textContent).toContain("Paused");

  await click("Jump to message for Oldest goal");
  expect(fixture.api.mock.calls.slice(2).map(([path]) => cursor(path))).toEqual(["tail", "p2", "p1"]);
  expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["olderMessages", "focusMessage"]);
  expect(dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "room-thread", messageId: "Oldest goal" });
  expect(document.querySelector("[role=dialog]")).toBeNull();
});

it("does no more history work for a long thread without goals", async () => {
  fixture.api.mockResolvedValue({ messages: [], nextBefore: null });
  await mount({ threadId: "room-thread", messages: [row("tail", 5_000)], hasMore: true });
  expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/threads/room-thread/goals?limit=1", expect.anything());
  expect(button("Goals")).toBeUndefined();
});

it("dismisses each inactive panel entry for this viewer and thread while retaining all messages", async () => {
  const messages = [goal("Finished goal", 5, "completed"), goal("Working goal", 10, "working"), goal("Paused goal", 15, "paused")];
  const thread = { threadId: "thread", messages };
  const { dispatch } = await mount(thread);
  await click("Goals");
  expect(listedGoals()).toEqual(["Paused goal", "Working goal", "Finished goal"]);
  expect(button("Dismiss goal card for Working goal")).toBeUndefined();
  await click("Dismiss goal card for Finished goal");
  expect(listedGoals()).toEqual(["Paused goal", "Working goal"]);
  expect(latestTitle()).toBe("Paused goal");
  await click("Dismiss goal card for Paused goal");
  expect(listedGoals()).toEqual(["Working goal"]);
  expect(latestTitle()).toBeUndefined();
  expect(dispatch).not.toHaveBeenCalled();
  expect(fixture.api).not.toHaveBeenCalled();
  expect(thread.messages).toBe(messages);

  await mount({ ...thread, threadId: "another-thread" });
  await click("Goals");
  expect(listedGoals()).toEqual(["Paused goal", "Working goal", "Finished goal"]);
  fixture.viewer = "second@example.org";
  const { render } = await mount(thread);
  await click("Goals");
  expect(listedGoals()).toEqual(["Paused goal", "Working goal", "Finished goal"]);
  fixture.viewer = "first@example.org";
  await render();
  expect(listedGoals()).toEqual(["Working goal"]);
  expect(latestTitle()).toBeUndefined();
  await click("Restore dismissed goals");
  expect(listedGoals()).toEqual(["Paused goal", "Working goal", "Finished goal"]);
  expect(latestTitle()).toBe("Paused goal");
});

it("honors a refused history read and shows a different version's card without changing a read-only chat", async () => {
  const working = goal("Current goal", 20, "working");
  const other = goal("Other version", 10, "stopped");
  const thread = { threadId: "thread", messages: [other, working], activeLeafId: working.id, hasMore: true };
  fixture.api.mockRejectedValue(new ApiError("no such conversation", 404));
  const { dispatch } = await mount(thread, "bot");
  await click("Goals");
  expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't load earlier goals.");
  expect(fixture.api).toHaveBeenCalledOnce();
  await click("Jump to message for Other version");
  expect(document.querySelector("[role=dialog] [aria-label='Goal run: Stopped']")).not.toBeNull();
  expect(fixture.api).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  expect(thread.activeLeafId).toBe(working.id);
});

it("waits for the existing branch permission check before focusing a goal on another version", async () => {
  const working = goal("Current goal", 20, "working");
  const other = goal("Other version", 10, "stopped");
  const thread = { threadId: "thread", messages: [other, working], activeLeafId: working.id };
  fixture.api.mockRejectedValueOnce(new ApiError("view only", 403)).mockResolvedValueOnce({ activeLeafId: other.id });
  const { dispatch } = await mount(thread, "bot", true);
  await click("Goals");
  await click("Jump to message for Other version");
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/bot/active-branch", expect.objectContaining({
    method: "POST", body: JSON.stringify({ messageId: other.id, threadId: thread.threadId }),
  }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't open that goal message.");

  await click("Jump to message for Other version");
  expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["threadActive", "focusMessage"]);
  expect(dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "thread", messageId: other.id });
});
