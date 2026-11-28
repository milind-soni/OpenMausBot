// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Group, GroupTask } from "@/state/store";
import type { FeedThread } from "./use-room-threads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ threads: null as FeedThread[] | null }));
const state = { bots: [], config: {}, groups: [], error: null, notice: null, forkPanel: null };
vi.mock("@/state/api", async (original) => ({ ...(await original<typeof import("@/state/api")>()), api: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => vi.fn(), useStoreSelector: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("@/state/store-ref", () => ({ useStoreRef: () => ({ state: () => state }) }));
vi.mock("./use-room-threads", () => ({ useRoomThreads: () => ({ threads: fixture.threads, failed: false, retry: () => {} }) }));
vi.mock("./use-room-work", () => ({ useRoomWorkStatuses: () => new Map() }));
vi.mock("./FeedComposer", () => ({ FeedComposer: () => null }));
vi.mock("../RoomHeader", () => ({ RoomHeader: () => null }));
vi.mock("../RoomBulletin", () => ({ RoomBulletin: () => null }));
vi.mock("../RoomChiefAbsent", () => ({ RoomChiefAbsent: () => null }));
vi.mock("../RoomHoldsBanner", () => ({ RoomHoldsBanner: () => null }));

const { RoomFeedView } = await import("./RoomFeedView");

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const task = (threadId: string, extra: Partial<GroupTask> = {}) => ({ threadId, title: threadId, createdAt: NOW - 7_200_000, ...extra }) as GroupTask;
const thread = (threadId: string, extra: Partial<GroupTask> = {}): FeedThread => ({
  task: task(threadId, extra),
  summary: { threadId, first: { speaker: { person: { name: "Ana" } }, text: `Start ${threadId}`, at: NOW - 7_200_000 }, replies: 57, lastReplyAt: NOW - 600_000, repliers: [] },
} as FeedThread);
const group = (tasks: GroupTask[]) => ({ id: "room", name: "Project room", memberIds: [], threadId: "main", tasks }) as unknown as Group;

let root: Root | null = null;
const render = (threads: FeedThread[]) => {
  fixture.threads = threads;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(createElement(RoomFeedView, { group: group(threads.map((one) => one.task)) })));
};
const column = () => document.querySelector<HTMLElement>("[data-room-feed] .glass-scroller-content")!;
afterEach(() => { act(() => root?.unmount()); root = null; fixture.threads = null; document.body.innerHTML = ""; });

describe("a room's feed with few threads", () => {
  it("starts its threads at the top, under the header, instead of under an empty block", () => {
    render([thread("t1"), thread("t2")]);
    expect(document.querySelectorAll("[data-feed-thread]")).toHaveLength(2);
    expect(column().classList).toContain("flex-col");
    expect(column().classList).not.toContain("justify-end");
  });

  it("keeps a thread closed by a bot folded at the top too", () => {
    render([thread("t1", { closedAt: NOW - 600_000, closedBy: { id: "maus", name: "MausBot" } } as Partial<GroupTask>)]);
    expect(document.querySelector("[data-feed-fold]")?.textContent).toBe("1 closed thread");
    expect(column().classList).not.toContain("justify-end");
  });

  it("keeps the empty room's hint at the foot, next to the composer it points to", () => {
    render([]);
    const hint = [...column().children].find((child) => child.textContent?.includes("No threads yet"));
    expect(hint?.classList).toContain("mt-auto");
  });
});
