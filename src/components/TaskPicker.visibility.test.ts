import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { Select } from "./Select";

const fixture = vi.hoisted(() => ({ showThreads: true, allThreadsMenu: false, advanced: true, menuOpen: false, queued: {} as Record<string, unknown[]>, bots: [] as Bot[], dispatch: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({
  useShowThreads: () => fixture.showThreads,
  useAllThreadsMenu: () => fixture.allThreadsMenu,
}));
// Full replacement: useAdvancedMode is a useSyncExternalStore hook whose static-markup server snapshot is a
// literal false, so only a mock can turn Advanced mode on here.
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advanced,
  setAdvancedMode: vi.fn(),
}));
// Static markup never runs the click that opens the menu; this renders it open for the attention-section case.
vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: () => ({ shown: fixture.menuOpen, closing: false, className: "", exitProps: {} }),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.bots, pendingQueued: fixture.queued }, dispatch: fixture.dispatch }),
}));

const { TaskPicker, BotActivityPicker, GroupTaskPicker } = await import("./TaskPicker");
const bot: Bot = {
  id: "pepper", name: "Pepper", color: "green", threadId: "current", title: "", description: "",
  notifications: true, unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
  tasks: [
    { threadId: "current", title: "Current chat", createdAt: 1, busy: true, activity: "working" },
    { threadId: "idle", title: "Quiet history", createdAt: 2, busy: false },
    { threadId: "waiting", title: "Approval needed", createdAt: 3, busy: false, activity: "waiting-on-you" },
    { threadId: "working", title: "Research", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5, busy: false },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
beforeEach(() => { fixture.showThreads = true; fixture.allThreadsMenu = false; fixture.advanced = true; fixture.menuOpen = false; fixture.queued = {}; fixture.bots = []; fixture.dispatch.mockClear(); });

describe("optional bot thread picker", () => {
  it("shows the All threads menu with the setting on and Threads sidebar setting off", () => {
    fixture.allThreadsMenu = true;
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(TaskPicker, { bot }));
    expect(markup).toContain('aria-label="All threads"');
    // The panel is closed under static markup, so the resting background can only be the trigger's.
    expect(markup).toContain("bg-raised/60");
    // noCompact: the trigger yields by truncation under its 220px bound, never a count-only collapse.
    expect(markup).toContain("max-w-[220px]");
    expect(markup).toContain('<span class="truncate">All threads</span>');
    expect(markup).not.toContain("@max-4xl/chathead");
  });

  it("renders nothing with the setting off, whatever the Threads display toggle", () => {
    for (const showThreads of [true, false]) {
      fixture.showThreads = showThreads;
      expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toBe("");
    }
  });

  it("shows the All threads menu in Advanced mode with the setting on, and nothing in Simple mode", () => {
    fixture.allThreadsMenu = true;
    fixture.advanced = true;
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toContain('aria-label="All threads"');
    fixture.advanced = false;
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toBe("");
  });

  it("keeps BotActivityPicker rendering when the Threads sidebar display is off, whatever the All threads setting", () => {
    fixture.showThreads = false;
    fixture.queued = { queued: [{ queueId: "pending" }] };
    fixture.allThreadsMenu = true;
    expect(renderToStaticMarkup(createElement(BotActivityPicker, { bot }))).toContain('aria-label="Other activity (4)"');
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toContain('aria-label="All threads"');
    fixture.allThreadsMenu = false;
    expect(renderToStaticMarkup(createElement(BotActivityPicker, { bot }))).toContain('aria-label="Other activity (4)"');
  });

  it("hides quiet histories and creation but keeps sibling activity reachable", () => {
    fixture.showThreads = false;
    fixture.queued = { queued: [{ queueId: "pending" }] };
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toBe("");
    const markup = renderToStaticMarkup(createElement(BotActivityPicker, { bot }));
    expect(markup).toContain('aria-label="Other activity (4)"');
    expect(markup).toContain('value="waiting">Approval needed · Waiting');
    expect(markup).toContain('value="working">Research · Working');
    expect(markup).toContain('value="queued">Next job · Queued');
    expect(markup).toContain('value="unread">Finished reply · Unread');
    expect(markup).not.toContain("Quiet history");
    expect(markup).toContain("Current chat");
    expect(markup).not.toContain('value="current"');
    expect(markup).not.toContain("All threads");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Rename");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("selects the exact sibling without creating or stopping work", () => {
    fixture.showThreads = false;
    const picker = BotActivityPicker({ bot });
    const select = picker!.props.children[0];
    expect(select.type).toBe(Select);
    select.props.onChange({ target: { value: "waiting" } });
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "pepper", threadId: "waiting" });
  });

  it("renders nothing when only the selected conversation is working", () => {
    fixture.showThreads = false;
    expect(renderToStaticMarkup(createElement(BotActivityPicker, { bot: { ...bot, tasks: bot.tasks!.slice(0, 2) } }))).toBe("");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not remove channel history controls", () => {
    fixture.showThreads = false;
    const group: Group = { id: "team", name: "Team", threadId: "team-current", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 1, unread: false, messages: [],
      tasks: [{ threadId: "team-current", title: "Channel discussion", createdAt: 1 }] };
    const markup = renderToStaticMarkup(createElement(GroupTaskPicker, { group }));
    expect(markup).toContain('aria-label="All threads"');
    // GroupTaskPicker passes no noCompact: the compact rules stay on the room trigger.
    expect(markup).toContain("@max-4xl/chathead:size-[30px]");
    expect(markup).toContain('@max-4xl/chathead:hidden');
  });

  it("caps the open menu to the viewport so narrow widths keep every action reachable", () => {
    fixture.allThreadsMenu = true;
    fixture.menuOpen = true;
    fixture.bots = [bot];
    try {
      const markup = renderToStaticMarkup(createElement(TaskPicker, { bot }));
      expect(markup).toContain('aria-label="All threads"');
      expect(markup).toContain("w-[300px]");
      expect(markup).toContain("max-w-[calc(100vw-3rem)]");
    } finally {
      fixture.menuOpen = false;
      fixture.bots = [];
    }
  });

  it("lists the bot's own threads and no attention section when cross-bot attention is present", () => {
    fixture.allThreadsMenu = true;
    fixture.menuOpen = true;
    fixture.bots = [
      bot,
      { ...bot, id: "atlas", name: "Atlas", threadId: "atlas-current",
        tasks: [{ threadId: "atlas-busy", title: "Atlas researching", createdAt: 1, busy: true, activity: "working" }] },
    ];
    try {
      const markup = renderToStaticMarkup(createElement(TaskPicker, { bot }));
      expect(markup).toContain('aria-label="All threads"');
      expect(markup).toContain("Quiet history");
      expect(markup).not.toContain("Active Threads");
      expect(markup).not.toContain("Atlas researching");
    } finally {
      fixture.menuOpen = false;
      fixture.bots = [];
    }
  });
});
