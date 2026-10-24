import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, type Bot, type Group } from "@/state/store";
import { BotThreadList, botRowProps, GroupThreadList } from "./Sidebar";
import { formatUpdatedAt } from "./SidebarThreadRow";
import { GroupTaskPicker, TaskPicker } from "./TaskPicker";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}), useCaptionChrome: () => ({}) }));
// Threads are an Advanced-mode surface (Simple keeps one conversation per bot), so these render as Advanced.
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));
// The one-thread guarantee is checked under the new opt-in All threads menu gate.
vi.mock("@/lib/thread-preferences", async (original) => ({
  ...await original<typeof import("@/lib/thread-preferences")>(),
  useAllThreadsMenu: () => true,
}));

const bot: Bot = {
  id: "maus", threadId: "idle", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: true, busy: true, activity: "working", messages: [],
  modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "idle", title: "Quick question", createdAt: 1, busy: false, activity: "idle" },
    { threadId: "working", title: "Long research", createdAt: 2, busy: true, activity: "working" },
    { threadId: "waiting", title: "Needs approval", createdAt: 3, busy: true, activity: "waiting-on-you", unread: true },
  ],
};

const threadList = (candidate: Bot, query = "") => createElement(BotThreadList, {
  ...botRowProps(initialState, vi.fn(), candidate, { density: "comfortable", quiet: false, query, onMenu: vi.fn() }),
  selected: true,
});

describe("sidebar bot threads", () => {
  it("shows named threads flush with the bot row, with separate presence and no trailing New thread row", () => {
    const markup = renderToStaticMarkup(threadList(bot));
    expect(markup).toContain('aria-label="Maus threads"');
    expect(markup).toContain('data-sidebar-thread-row="idle" aria-current="page"');
    expect(markup).toContain(`Long research · ${formatUpdatedAt(2)} · Working`);
    expect(markup).toContain(`Needs approval · ${formatUpdatedAt(3)} · Waiting · Unread`);
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("border-l");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("test");
  });

  it("keeps All threads reachable with one thread under the new setting", () => {
    const render = (candidate: Bot) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(TaskPicker, { bot: candidate })));
    expect(render(bot)).toContain('aria-label="All threads"');
    const single = render({ ...bot, tasks: [bot.tasks![1]!] });
    expect(single).toContain("All threads");
    expect(single).not.toContain('disabled=""');
  });

  it("shows fresh threads with a relative stamp while the tooltip keeps the full date", () => {
    const recent = Date.now() - 5 * 60_000;
    const fresh = { ...bot, unread: false, busy: false, activity: "idle" as const, tasks: [{ threadId: "fresh", title: "Fresh question", createdAt: recent, busy: false, activity: "idle" as const }] };
    const markup = renderToStaticMarkup(threadList(fresh));
    expect(markup).toContain("5 min ago");
    expect(markup).toContain(`title="Fresh question · ${formatUpdatedAt(recent)}"`);
  });

  it("groups folder threads under one bot while keeping loose threads and empty folders reachable", () => {
    const projectBot = { ...bot, projects: [{ id: "research", name: "Research", emoji: "🧪" }, { id: "empty", name: "Ideas" }],
      tasks: bot.tasks!.map((task) => ({ ...task, ...(task.threadId === "working" ? { projectId: "research" } : {}) })) };
    const markup = renderToStaticMarkup(threadList(projectBot));
    expect(markup).toContain('data-sidebar-project="research"');
    expect(markup).toContain('aria-label="Research threads"');
    expect(markup).toContain('aria-label="Actions for Research folder"');
    expect(markup).toContain('aria-label="Change Research folder icon"');
    expect(markup).toContain('data-sidebar-folder-row="research" draggable="true"');
    // Native buttons do not inherit their parent's drag gesture in Chromium.
    expect(markup).toContain('<button type="button" data-sidebar-folder-label="research" draggable="true"');
    expect(markup).toContain("🧪");
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain('aria-label="New thread in Research"');
    expect(markup).not.toContain('aria-label="Choose folder for new thread"');
    const folderToggle = markup.match(/<button[^>]*aria-label="Collapse Research threads"[^>]*>/)?.[0];
    expect(folderToggle).toContain("focus-visible:ring-1");
    expect(folderToggle).not.toContain("hover:bg-");
    expect(markup.indexOf('aria-label="Collapse Research threads"')).toBeLessThan(markup.indexOf('data-sidebar-folder-label="research"'));
    expect(markup).toContain("Threads");
    expect(markup).toContain("No threads yet");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("test");
    expect(markup).toContain('data-sidebar-thread-row="idle" aria-current="page"');
    expect(markup).toContain('aria-label="Actions for Quick question"');
  });

  it("keeps internal routine execution out of ordinary folders while showing the results conversation", () => {
    const routineBot: Bot = {
      ...bot, projects: [{ id: "daily", name: "Daily work" }],
      tasks: [
        ...bot.tasks!,
        { threadId: "routine-result", title: "Daily digest results", projectId: "daily", createdAt: 4, unread: true },
        { threadId: "routine-execution", title: "Internal daily digest execution", projectId: "daily", createdAt: 5, routineRunId: "run-daily", unread: true, busy: true, activity: "waiting-on-you" },
      ],
    };
    for (const query of ["", "daily"]) {
      const markup = renderToStaticMarkup(threadList(routineBot, query));
      expect(markup).toContain('data-sidebar-thread-row="routine-result"');
      expect(markup).toContain("Daily digest results");
      expect(markup).not.toContain("routine-execution");
      expect(markup).not.toContain("Internal daily digest execution");
    }
  });

  it("folds open threads another bot opened into one collapsed group outside the six visible rows", () => {
    const openedBy = { botId: "pepper", name: "Pepper", at: 1 };
    const own = Array.from({ length: 7 }, (_, index) => ({ threadId: `own-${index}`, title: `Own ${index}`, createdAt: 10 + index, busy: false, activity: "idle" as const }));
    const helpers = [
      { threadId: "email", title: "Draft launch email", createdAt: 30, busy: true, activity: "working" as const, openedBy },
      { threadId: "pricing", title: "Check pricing page", createdAt: 31, busy: false, activity: "idle" as const, openedBy },
      { threadId: "review", title: "Review copy", createdAt: 5, busy: false, activity: "idle" as const, openedBy, unread: true },
    ];
    const markup = renderToStaticMarkup(threadList({ ...bot, threadId: "own-6", tasks: [...own, ...helpers] }));
    const group = markup.slice(markup.indexOf("data-sidebar-helper-threads"));
    expect(group).toContain('aria-expanded="false" aria-label="Expand Opened by bots threads"');
    expect(group).toContain('opacity-50">2</span>');
    expect(group).toContain("animate-spin");
    expect(markup).not.toContain('data-sidebar-thread-row="email"');
    expect(markup).not.toContain('data-sidebar-thread-row="pricing"');
    expect(markup).toContain('data-sidebar-thread-row="review"');
    for (let index = 1; index < 7; index += 1) expect(markup).toContain(`data-sidebar-thread-row="own-${index}"`);
    expect(markup).toContain("Show all 8 threads");
    const searched = renderToStaticMarkup(threadList({ ...bot, threadId: "own-6", tasks: [...own, ...helpers] }, "pricing"));
    expect(searched).toContain('data-sidebar-thread-row="pricing"');
    expect(searched).not.toContain("data-sidebar-helper-threads");
  });

  it("exposes group history through the same nested thread rows and All threads picker", () => {
    const group: Group = { id: "team", threadId: "group-current", name: "Launch team", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
      tasks: [{ threadId: "group-current", title: "Launch plan", createdAt: 3 }, { threadId: "group-old", title: "Previous review", createdAt: 2 }] };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupThreadList, { group, selected: true })));
    expect(markup).toContain('aria-label="Launch team threads"');
    expect(markup).toContain('data-sidebar-thread-row="group-current" aria-current="page"');
    expect(markup).toContain("Previous review");
    expect(markup).not.toContain("New thread");
    const picker = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupTaskPicker, { group })));
    expect(picker).toContain('aria-label="All threads"');
    expect(picker).not.toContain("Tasks");
    const working = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupThreadList, { group: { ...group, working: true }, selected: true })));
    expect(working).toContain(`title="Launch plan · ${formatUpdatedAt(3)} · Working"`);
  });
});
