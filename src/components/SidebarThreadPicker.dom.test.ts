// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Group, type Task } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { BotThreadList, botRowProps } from "./Sidebar";
import { GroupThreadList } from "./SidebarGroupThreadList";
import { TASK_PICKER_DISMISS_MS } from "./TaskPicker";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: initialState, dispatch }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const tasks: Task[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ threadId: `recent-${i}`, title: `Recent ${i}`, createdAt: 100 + i })),
  { threadId: "anki", title: "Anki vocabulary deck", createdAt: 1 },
  { threadId: "archived", title: "Archived lesson", archivedAt: 0, createdAt: 2 },
  { threadId: "closed", title: "Finished review", closedBy: { botId: "other", name: "Other", at: 3 }, createdAt: 3 },
  { threadId: "snoozed", title: "Later discussion", snoozedUntil: Date.now() + 86_400_000, createdAt: 4 },
  { threadId: "helper", title: "Audio matching", openedBy: { botId: "other", name: "Other", at: 5 }, createdAt: 5 },
  { threadId: "filed", title: "Folder conversation", projectId: "research", createdAt: 6 },
];
const bot = { id: "leo", name: "Leo", threadId: "recent-7", tasks: [...tasks, { threadId: "run", title: "Private execution", routineRunId: "run-1", createdAt: 9 }], projects: [{ id: "research", name: "Research" }], messages: [] } as unknown as Bot;
let host: HTMLDivElement;
let root: Root;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label)!;
const click = (target: HTMLElement) => flushSync(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const input = () => document.querySelector<HTMLInputElement>('[aria-label="Search threads"]')!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
  flushSync(() => input().dispatchEvent(new Event("input", { bubbles: true })));
};
const key = (key: string, extra: KeyboardEventInit = {}) => flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
const listed = () => [...document.querySelectorAll<HTMLElement>("[data-task-picker-row]")].map((entry) => entry.dataset.taskPickerRow);
const menu = () => document.querySelector<HTMLElement>("[data-task-picker]");
const row = (id: string) => document.querySelector<HTMLElement>(`[data-task-picker-row="${id}"]`)!;
const choose = (id: string) => {
  click(row(id).querySelector("button")!);
  flushSync(() => vi.advanceTimersByTime(TASK_PICKER_DISMISS_MS));
};
const open = () => {
  const trigger = buttons().find((entry) => entry.textContent?.startsWith("All threads"))!;
  trigger.focus();
  click(trigger);
  return trigger;
};
beforeEach(() => {
  dispatch.mockReset();
  vi.useFakeTimers();
  document.documentElement.dataset.reducedMotion = "true";
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); delete document.documentElement.dataset.reducedMotion; });

describe("finding conversations from the sidebar", () => {
  const renderBot = () => flushSync(() => root.render(createElement(BotThreadList, { ...botRowProps(initialState, dispatch, bot, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true })));

  it("opens the complete bot list and navigates to a conversation beyond the sidebar limit without deleting", () => {
    renderBot();
    expect(host.querySelector('[data-sidebar-thread-row="anki"]')).toBeNull();
    expect(button("Select to delete")).toBeDefined();
    open();
    expect(document.activeElement).toBe(input());
    expect(new Set(listed())).toEqual(new Set(tasks.map((task) => task.threadId)));
    expect(listed()).not.toContain("run");
    choose("anki");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "leo", threadId: "anki" });
    expect(menu()).toBeNull();
  });

  it("searches all titles and folders, recovers from no matches, and clears with Escape", () => {
    renderBot(); open();
    type("research");
    expect(listed()).toEqual(["filed"]);
    type("AnKi");
    expect(listed()).toEqual(["anki"]);
    type("missing title");
    expect(listed()).toEqual([]);
    expect(menu()!.textContent).toContain("Nothing matches");
    key("Escape");
    expect(listed()).toHaveLength(tasks.length);
    expect(document.activeElement).toBe(input());
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens the first search match with Enter and preserves IME composition", () => {
    renderBot(); open(); type("Anki");
    key("Enter", { isComposing: true });
    expect(dispatch).not.toHaveBeenCalled();
    key("Enter");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "leo", threadId: "anki" });
  });

  it("restores focus on Escape, dismisses outside, and resets search on repeated opening", () => {
    renderBot();
    const trigger = open();
    input().focus(); key("Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(dispatch).not.toHaveBeenCalled();
    open(); type("Anki");
    flushSync(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(menu()).toBeNull();
    open(); expect(input().value).toBe("");
  });

  it("uses the same full browser and opening behavior for room histories", () => {
    const group = { id: "team", name: "Team", threadId: "recent-7", createdAt: 1, tasks, memberIds: [], messages: [], unread: false, defaultResponder: { kind: "everyone" }, bulletin: "" } as Group;
    flushSync(() => root.render(createElement(GroupThreadList, { group, selected: true })));
    open(); type("archived");
    choose("archived");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchGroupTask", groupId: "team", threadId: "archived" });
  });

  it("still opens the owning chat when the chosen thread is already current", () => {
    renderBot(); open();
    choose("recent-7");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "leo" });
  });

  it("keeps pin, rename and move actions in the shared picker", () => {
    renderBot(); open(); type("Anki");
    click(row("anki").querySelector<HTMLButtonElement>('[aria-label="Pin"]')!);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "leo", threadId: "anki", patch: { pinned: true } });
    const select = row("anki").querySelector("select")!;
    flushSync(() => { select.value = "research"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "leo", threadId: "anki", patch: { projectId: "research" } });
    click(row("anki").querySelector<HTMLButtonElement>('[aria-label="Rename Anki vocabulary deck"]')!);
    const rename = row("anki").querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(rename, "Renamed lesson");
    flushSync(() => rename.dispatchEvent(new Event("input", { bubbles: true })));
    rename.focus(); key("Enter");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "renameTask", botId: "leo", threadId: "anki", title: "Renamed lesson" });
  });

  it("expands older bot and room threads inline and keeps search available", () => {
    renderBot();
    click(button(`Show all ${tasks.length} threads`));
    expect(host.querySelector('[data-sidebar-thread-row="anki"]')).not.toBeNull();
    expect(button(`Show all ${tasks.length} threads`)).toBeUndefined();
    expect(button("All threads")).toBeDefined();
    const group = { id: "team", name: "Team", threadId: "recent-7", createdAt: 1, tasks, memberIds: [], messages: [], unread: false, defaultResponder: { kind: "everyone" }, bulletin: "" } as Group;
    flushSync(() => root.render(createElement(GroupThreadList, { group, selected: false })));
    expect(host.querySelector('[data-sidebar-thread-row="anki"]')).toBeNull();
    click(button(`Show all ${tasks.length} threads`));
    expect(host.querySelector('[data-sidebar-thread-row="anki"]')).not.toBeNull();
    open(); type("Anki"); key("Enter");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchGroupTask", groupId: "team", threadId: "anki" });
  });

  it("hides the single-thread bot and room footer and keeps deletion distinct", () => {
    const single = { ...bot, tasks: [tasks[0]!] };
    flushSync(() => root.render(createElement(BotThreadList, { ...botRowProps(initialState, dispatch, single, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true })));
    expect(button("All threads")).toBeUndefined();
    expect(button("Select to delete")).toBeUndefined();
    const group = { id: "team", name: "Team", threadId: "recent-0", createdAt: 1, tasks: [tasks[0]!], memberIds: [], messages: [], unread: false, defaultResponder: { kind: "everyone" }, bulletin: "" } as Group;
    flushSync(() => root.render(createElement(GroupThreadList, { group, selected: true })));
    expect(button("All threads")).toBeUndefined();
    renderBot(); click(button("Select to delete"));
    expect(host.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(menu()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shares the list clock with the picker and wakes a snoozed row without opening the picker", () => {
    const interval = vi.spyOn(window, "setInterval");
    const now = Date.now();
    const snoozing: Bot = { ...bot, projects: [], threadId: "current", tasks: [
      { threadId: "current", title: "Current chat", createdAt: now - 10_000 },
      { threadId: "napping", title: "Napping", createdAt: now - 300_000, snoozedUntil: now + 60_000 },
    ] };
    flushSync(() => root.render(createElement(BotThreadList, { ...botRowProps(initialState, dispatch, snoozing, { density: "comfortable", query: "", onMenu: vi.fn() }), selected: true })));
    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30_000);
    expect(host.querySelector('[data-sidebar-thread-row="napping"]')).toBeNull();
    open();
    expect(interval).toHaveBeenCalledTimes(1);
    key("Escape");
    flushSync(() => vi.advanceTimersByTime(60_001));
    expect(host.querySelector('[data-sidebar-thread-row="napping"]')).not.toBeNull();
    expect(menu()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shares the room list clock while its picker is open", () => {
    const interval = vi.spyOn(window, "setInterval");
    const group = { id: "team", name: "Team", threadId: "recent-7", createdAt: 1, tasks, memberIds: [], messages: [], unread: false, defaultResponder: { kind: "everyone" }, bulletin: "" } as Group;
    flushSync(() => root.render(createElement(GroupThreadList, { group, selected: true })));
    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 30_000);
    open();
    expect(interval).toHaveBeenCalledTimes(1);
  });
});
