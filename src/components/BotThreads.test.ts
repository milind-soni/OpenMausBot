import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreProvider, type Bot, type Group } from "@/state/store";
import { BotThreadList, GroupThreadList } from "./Sidebar";
import { GroupTaskPicker, TaskPicker } from "./TaskPicker";
import { workingFolderLabel } from "./ChatView";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

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

describe("sidebar bot threads", () => {
  it("hides generated workspace IDs while retaining useful user-chosen folder names", () => {
    expect(workingFolderLabel("/tmp/fixture/task-workspaces/maus/idle", "maus", "idle")).toBe("Thread workspace");
    expect(workingFolderLabel("C:\\fixture\\task-workspaces\\maus\\idle\\", "maus", "idle")).toBe("Thread workspace");
    expect(workingFolderLabel("/Users/example/Projects/Website/", "maus", "idle")).toBe("Website");
    expect(workingFolderLabel("/Users/example/task-workspaces/notes", "maus", "idle")).toBe("notes");
  });
  it("shows indented named threads with separate presence and a usable New thread action", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(BotThreadList, { bot, selected: true })));
    expect(markup).toContain('aria-label="Maus threads"');
    expect(markup).toContain('data-sidebar-thread-row="idle" aria-current="page"');
    expect(markup).toContain("Long research · Working");
    expect(markup).toContain("Needs approval · Waiting · Unread");
    expect(markup).toContain("New thread");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("test");
  });

  it("keeps All threads accessible even with one thread so its history actions remain reachable", () => {
    const render = (candidate: Bot) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(TaskPicker, { bot: candidate })));
    expect(render(bot)).toContain('aria-label="All threads"');
    const single = render({ ...bot, tasks: [bot.tasks![1]!] });
    expect(single).toContain("All threads");
    expect(single).not.toContain('disabled=""');
  });

  it("groups folder threads under one bot while keeping loose threads and empty folders reachable", () => {
    const projectBot = { ...bot, projects: [{ id: "research", name: "Research", emoji: "🧪" }, { id: "empty", name: "Ideas" }],
      tasks: bot.tasks!.map((task) => ({ ...task, ...(task.threadId === "working" ? { projectId: "research" } : {}) })) };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(BotThreadList, { bot: projectBot, selected: true })));
    expect(markup).toContain('data-sidebar-project="research"');
    expect(markup).toContain('aria-label="Research threads"');
    expect(markup).toContain('aria-label="Actions for Research folder"');
    expect(markup).toContain('aria-label="Change Research folder icon"');
    expect(markup).toContain('data-sidebar-folder-row="research" draggable="true"');
    // Native buttons do not inherit their parent's drag gesture in Chromium.
    // Dragging from the label must start the same row-owned folder drag.
    expect(markup).toContain('<button type="button" data-sidebar-folder-label="research" draggable="true"');
    expect(markup).toContain("🧪");
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain('aria-label="New thread in Research"');
    expect(markup).toContain('aria-label="Choose folder for new thread"');
    expect(markup).toContain("Threads");
    expect(markup).toContain("No threads yet");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("test");
    expect(markup).toContain("data-thread-selection-mark");
    expect(markup).toContain('aria-label="Actions for Quick question"');
  });

  it("exposes group history through the same nested thread rows and All threads picker", () => {
    const group: Group = { id: "team", threadId: "group-current", name: "Launch team", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
      tasks: [{ threadId: "group-current", title: "Launch plan", createdAt: 3 }, { threadId: "group-old", title: "Previous review", createdAt: 2 }] };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupThreadList, { group, selected: true })));
    expect(markup).toContain('aria-label="Launch team threads"');
    expect(markup).toContain('data-sidebar-thread-row="group-current" aria-current="page"');
    expect(markup).toContain("Previous review");
    expect(markup).toContain("New thread");
    expect(markup).not.toContain('disabled=""');
    const picker = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupTaskPicker, { group })));
    expect(picker).toContain('aria-label="All threads"');
    expect(picker).not.toContain("Tasks");
    const working = renderToStaticMarkup(createElement(StoreProvider, null, createElement(GroupThreadList, { group: { ...group, working: true }, selected: true })));
    expect(working).toContain('title="Launch plan · Working"');
    expect(working).toContain('disabled=""');
  });
});
