// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot, type Group, type Task } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import { BotThreadList, botRowProps } from "./Sidebar";
import { GroupThreadList } from "./SidebarGroupThreadList";
import { ThreadBrowser } from "./ThreadBrowser";

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
const listed = () => [...document.querySelectorAll<HTMLElement>("[data-thread-browser-row]")].map((entry) => entry.dataset.threadBrowserRow);
const open = () => {
  const trigger = buttons().find((entry) => entry.textContent?.startsWith("All threads"))!;
  trigger.focus();
  click(trigger);
  return trigger;
};
beforeEach(() => {
  dispatch.mockReset();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

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
    click(document.querySelector<HTMLElement>('[data-thread-browser-row="anki"]')!);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "leo", threadId: "anki" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("searches all titles and folders, recovers from no matches, and clears with focus retained", () => {
    renderBot(); open();
    type("research");
    expect(listed()).toEqual(["filed"]);
    type("AnKi");
    expect(listed()).toEqual(["anki"]);
    type("missing title");
    expect(listed()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Nothing matches");
    click(button("Clear"));
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

  it("traps keyboard focus and restores the browser button on Escape without navigation", () => {
    renderBot();
    const trigger = open();
    const close = button("Close");
    close.focus(); key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(document.querySelector('[data-thread-browser-row="anki"]'));
    key("Tab"); expect(document.activeElement).toBe(close);
    input().focus(); key("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(dispatch).not.toHaveBeenCalled();
    open(); expect(input().value).toBe("");
  });

  it("uses the same full browser and opening behavior for room histories", () => {
    const group = { id: "team", name: "Team", threadId: "recent-7", createdAt: 1, tasks, memberIds: [], messages: [], unread: false, defaultResponder: { kind: "everyone" }, bulletin: "" } as Group;
    flushSync(() => root.render(createElement(GroupThreadList, { group, selected: true })));
    open(); type("archived");
    click(document.querySelector<HTMLElement>('[data-thread-browser-row="archived"]')!);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchGroupTask", groupId: "team", threadId: "archived" });
  });

  it("still opens the owning chat when the chosen thread is already current", () => {
    renderBot(); open();
    click(document.querySelector<HTMLElement>('[data-thread-browser-row="recent-7"]')!);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "leo" });
  });

  it("offers a localized empty state for an empty history", () => {
    setLocale("fr");
    flushSync(() => root.render(createElement(ThreadBrowser, { tasks: [], name: "Leo", currentThreadId: "none", onOpen: dispatch })));
    click(host.querySelector("button")!);
    expect(listed()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(t("task.empty"));
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Search threads");
  });
});
