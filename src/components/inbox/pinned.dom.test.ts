// @vitest-environment happy-dom
// The Inbox's pinned section.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, GroupTask, Task } from "@/state/store";
import { t } from "@/lib/i18n";
import type { AttentionThread } from "../SidebarBotActivity";
import { PinnedThreads, pinnedThreadRows } from "./PinnedThreads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-16T08:00:00Z");
const task = (threadId: string, patch: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 0, updatedAt: NOW, ...patch });
const bot = (id: string, tasks: Task[]): Bot => ({ id, name: id, tasks } as unknown as Bot);
const room = (tasks: GroupTask[]): Group =>
  ({ id: "room", threadId: "room-main", name: "Room", memberIds: [], unread: false, createdAt: 0, tasks } as unknown as Group);

let root: Root;
const onOpen = vi.fn();
const onUnpin = vi.fn();
const mount = (bots: Bot[], groups: Group[] = [], current?: { kind: "bot"; botId: string; threadId: string }) => act(async () => {
  root.render(createElement(PinnedThreads, { rows: pinnedThreadRows(bots, groups, {}), now: NOW, current, onOpen, onUnpin }));
});
const rowTitles = () => [...document.querySelectorAll<HTMLElement>("[data-pinned-row]")].map((row) => row.querySelector("[data-pinned-title]")?.textContent);

beforeEach(() => {
  onOpen.mockReset();
  onUnpin.mockReset();
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the pinned section", () => {
  it("lists only the pinned conversations", async () => {
    await mount([bot("eli", [task("pinned", { pinned: true }), task("loose")])]);
    expect(rowTitles()).toEqual(["pinned"]);
  });

  it("puts the most recently active conversation first, the order its label reads in", async () => {
    await mount([bot("eli", [
      task("older", { pinned: true, updatedAt: NOW - 3 * 60 * 60_000 }),
      task("newer", { pinned: true, updatedAt: NOW - 60_000 }),
    ])]);
    expect(rowTitles()).toEqual(["newer", "older"]);
  });

  it("says who the conversation belongs to and when it last moved", async () => {
    await mount([bot("eli", [task("pinned", { pinned: true, updatedAt: NOW - 5 * 60_000 })])]);
    const stamp = document.querySelector("[data-pinned-when]");
    expect(stamp?.textContent).toBe(t("task.updated.minutes", { count: 5 }));
    expect(stamp?.getAttribute("dateTime")).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  it("marks the conversation the chat window has open, and only that one", async () => {
    await mount([bot("eli", [task("open", { pinned: true }), task("elsewhere", { pinned: true, updatedAt: NOW - 60_000 })])],
      [], { kind: "bot", botId: "eli", threadId: "open" });
    const rows = [...document.querySelectorAll<HTMLElement>("[data-pinned-row]")];
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(rows[0]!.className.split(" ")).toContain("bg-raised");
  });

  it("gathers a room's pinned conversation too", async () => {
    await mount([], [room([{ threadId: "room-main", title: "room chat", createdAt: 0, updatedAt: NOW, pinned: true }])]);
    expect(rowTitles()).toEqual(["room chat"]);
    expect(pinnedThreadRows([], [room([{ threadId: "room-main", title: "room chat", createdAt: 0, pinned: true }])], {})[0]!.kind).toBe("group");
  });

  it("unpins the row it was asked to, naming that row's own conversation", async () => {
    await mount([bot("eli", [task("pinned", { pinned: true })])]);
    await act(async () => { document.querySelector<HTMLElement>("[data-inbox-unpin]")!.click(); });
    expect(onUnpin).toHaveBeenCalledTimes(1);
    const entry = onUnpin.mock.calls[0]![0] as AttentionThread;
    expect([entry.kind, entry.kind === "bot" ? entry.botId : null, entry.task.threadId]).toEqual(["bot", "eli", "pinned"]);
  });

  it("renders nothing when nothing is pinned", async () => {
    await mount([bot("eli", [task("loose")])]);
    expect(document.querySelector("[data-inbox-pinned]")).toBeNull();
  });
});
