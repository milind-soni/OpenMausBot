import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group, GroupTask, Message } from "@/state/store";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    threadsShown: false,
    findOpen: false,
    menus: [] as { ariaLabel: string; items: SidebarMenuItem[]; trigger: string }[],
    dispatch: vi.fn(),
    find: vi.fn(),
    copy: vi.fn(async (_markdown: string) => true),
    download: vi.fn(),
    format: vi.fn((input: { title: string; isGroup?: boolean }) => `# ${input.title}${input.isGroup ? " (room)" : ""}`),
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, config: { rooms: { turnTimeoutMinutes: 5 } } }, dispatch: fixture.dispatch }),
  };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.threadsShown }));
vi.mock("@/lib/chat-find", () => ({ requestChatFind: fixture.find, useChatFindOpen: () => fixture.findOpen }));
vi.mock("@/lib/export-transcript", () => ({
  copyTranscriptToClipboard: fixture.copy,
  downloadMarkdownTranscript: fixture.download,
  formatTranscriptMarkdown: fixture.format,
  slugifyTranscriptFilename: (title: string) => title.toLowerCase().replace(/\s+/g, "-"),
}));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: SidebarMenuItem[]; renderTrigger: (state: { open: boolean }) => React.ReactNode }) => {
    const trigger = props.renderTrigger({ open: false });
    fixture.menus.push({ ...props, trigger: renderToStaticMarkup(createElement("div", null, trigger)) });
    return trigger;
  },
}));

const { RoomMoreMenu } = await import("./RoomMoreMenu");
afterAll(() => vi.unstubAllGlobals());

const task = (threadId: string, title: string, at: number, extra: Partial<GroupTask> = {}): GroupTask => ({ threadId, title, createdAt: at, ...extra });
const hello: Message = { id: "hi", role: "user", kind: "text", text: "Hello room", at: 1 };
const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "launch", name: "Desk HQ", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [hello],
  tasks: [task("main", "Desk HQ", 1), task("launch", "Launch plan", 3), task("old", "", 2)],
  ...patch,
});
const menuOf = (group: Group) => {
  fixture.menus = [];
  renderToStaticMarkup(createElement(RoomMoreMenu, { group }));
  return fixture.menus.at(-1)!;
};
const item = (group: Group, key: string) => menuOf(group).items.find((entry) => entry.key === key)!;

beforeEach(() => {
  fixture.threadsShown = false;
  fixture.findOpen = false;
  fixture.dispatch.mockClear();
  fixture.find.mockClear();
  fixture.copy.mockClear();
  fixture.download.mockClear();
  fixture.format.mockClear();
});

describe("RoomMoreMenu, the Room panel's round ⋯", () => {
  it("is a round 32px button labelled More, lit while the find bar is open", () => {
    const menu = menuOf(room());
    expect(menu.ariaLabel).toBe("More");
    expect(menu.trigger).toContain('data-testid="room-more"');
    expect(menu.trigger).toMatch(/class="[^"]*\bsize-8\b[^"]*\brounded-full\b[^"]*\bbg-raised\/50\b/);
    expect(menu.trigger).not.toContain("text-accent");
    fixture.findOpen = true;
    expect(menuOf(room()).trigger).toContain("text-accent");
    expect(item(room(), "find").active).toBe(true);
  });

  it("offers find, threads, share and the time per turn, and usage once the room has some", () => {
    expect(menuOf(room()).items.map((entry) => entry.key)).toEqual(["find", "new-thread", "threads", "copy", "download", "turn-limit"]);
    const used = room({ usage: { input: 1200, output: 300, costUsd: 0.42, turns: 2 } });
    expect(menuOf(used).items.map((entry) => entry.key)).toEqual(["find", "new-thread", "threads", "copy", "download", "turn-limit", "usage"]);
    expect(menuOf(room()).items.find((entry) => entry.key === "new-thread")).toMatchObject({ label: "New thread", heading: "Threads", separatorBefore: true });
    expect(menuOf(room()).items.find((entry) => entry.key === "copy")).toMatchObject({ label: "Copy as Markdown", heading: "Share", separatorBefore: true });
  });

  it("opens the room's find bar for the thread on screen", () => {
    item(room(), "find").onSelect();
    expect(fixture.find).toHaveBeenCalledWith("launch");
  });

  it("starts a new thread in the room", () => {
    item(room(), "new-thread").onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newGroupTask", groupId: "desk" });
  });

  it("lists the room's threads newest first, marks the open one and switches to another", () => {
    const threads = item(room(), "threads");
    expect(threads).toMatchObject({ label: "All threads", value: "3" });
    expect(threads.submenu!.map((entry) => [entry.label, Boolean(entry.active)])).toEqual([
      ["Launch plan", true],
      ["New thread", false],
      ["Desk HQ", false],
    ]);
    threads.submenu![2]!.onSelect();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchGroupTask", groupId: "desk", threadId: "main" });
  });

  it("leaves the thread items to the sidebar when it shows threads, and All threads out with one thread", () => {
    fixture.threadsShown = true;
    expect(menuOf(room()).items.map((entry) => entry.key)).toEqual(["find", "copy", "download", "turn-limit"]);
    fixture.threadsShown = false;
    expect(menuOf(room({ tasks: [task("launch", "Launch plan", 3)] })).items.map((entry) => entry.key)).not.toContain("threads");
  });

  it("copies and downloads the room's transcript as Markdown", async () => {
    item(room(), "copy").onSelect();
    await Promise.resolve();
    expect(fixture.format).toHaveBeenCalledWith({ title: "Desk HQ", messages: [hello], isGroup: true });
    expect(fixture.copy).toHaveBeenCalledWith("# Desk HQ (room)");
    item(room(), "download").onSelect();
    expect(fixture.download).toHaveBeenCalledWith("desk-hq", "# Desk HQ (room)");
    expect(item(room({ messages: [] }), "copy").disabled).toBe(true);
    expect(item(room({ messages: [] }), "download").disabled).toBe(true);
  });

  it("sets the conversation's time per turn from a submenu, as the header's turn limit does", () => {
    const limit = item(room(), "turn-limit");
    expect(limit).toMatchObject({ label: "Time per turn", value: "5 min" });
    expect(limit.submenu!.map((entry) => [entry.label, Boolean(entry.active)])).toEqual([
      ["Default (5 min)", true],
      ["30 min", false],
      ["1 hour", false],
      ["2 hours", false],
    ]);
    for (const entry of limit.submenu!) entry.onSelect();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([null, 30, 60, 120].map((minutes) => ({
      type: "setConversationTurnLimit", groupId: "desk", threadId: "launch", minutes, dm: false,
    })));
  });

  it("shows the open conversation's own limit, a custom one included", () => {
    const withLimit = (minutes: number) => room({ tasks: [task("launch", "Launch plan", 3, { turnTimeoutMinutes: minutes })] });
    expect(item(withLimit(120), "turn-limit").value).toBe("2 hours");
    expect(item(withLimit(120), "turn-limit").submenu!.find((entry) => entry.active)?.label).toBe("2 hours");
    expect(item(withLimit(45), "turn-limit").value).toBe("45 min");
    expect(item(withLimit(45), "turn-limit").submenu!.some((entry) => entry.active)).toBe(false);
  });

  it("shows the room's usage with the same short text as the header chip", () => {
    const usage = item(room({ usage: { input: 1200, output: 300, costUsd: 0.42, turns: 2 } }), "usage");
    expect(usage.label).toBe("Usage");
    const markup = renderToStaticMarkup(createElement("div", null, usage.trailing));
    expect(markup).toContain(">$0.42</span>");
    expect(markup).toContain('title="This thread:');
  });
});
