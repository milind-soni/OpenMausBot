// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Bot, Task } from "@/state/store";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => dispatch, useStoreSelector: (select: (state: unknown) => unknown) => select({ settingsOpen: false, pendingQueued: {}, bots: [], newChat: null }) }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { ChatHeadPill } from "./ChatHeadPill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, title: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: at, lastThreadOrderAt: at, ...extra });
const pepper = (tasks: Task[], threadId: string): Bot => ({ id: "pepper", name: "Pepper", threadId, mainThreadId: "sales", tasks, messages: [] } as unknown as Bot);
const THREADS = [task("sales", "Weekly sales", 5, { busy: true }), task("launch", "Launch plan", 1, { pinned: true }), task("trip", "Berlin trip", 3)];

let root: Root | null = null;
const onToggle = vi.fn();
const render = (bot: Bot) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(createElement(ChatHeadPill, { bot, avatar: {} as never, privacy: null, onToggle, switcher: true })));
};
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const chips = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const sent = () => dispatch.mock.calls.map(([action]) => action as Action);

beforeEach(() => { dispatch.mockClear(); onToggle.mockClear(); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the pill's thread switcher", () => {
  it("shows only the bot's name, which still opens its panel", () => {
    render(pepper(THREADS, "launch"));
    expect(q("[data-chathead-conversation]")).toBeNull();
    expect(q("[data-chathead-switch]")?.textContent).toBe("Pepper");
    act(() => q("[data-chathead-pill]")!.click());
    expect(onToggle).toHaveBeenCalledOnce();
    expect(q("[role=listbox]")).toBeNull();
  });

  it("opens on a click of its chevron, never on hover, into the threads: the main one first, then pinned, the open one selected", () => {
    render(pepper(THREADS, "launch"));
    act(() => { q("[data-chathead-threads]")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(q("[role=listbox]")).toBeNull();
    act(() => q("[data-chathead-threads]")!.click());
    expect(chips().map((chip) => chip.textContent)).toEqual(["Weekly sales", "Launch plan", "Berlin trip"]);
    expect(chips()[1].getAttribute("aria-selected")).toBe("true");
    expect(chips()[0].querySelector('[aria-label="Working"]')).not.toBeNull();
    expect(chips()[1].querySelector('[aria-label="Pinned"]')).not.toBeNull();
  });

  it("stars the main thread", () => {
    render(pepper([task("sales", "Weekly sales", 1), task("trip", "Berlin trip", 3)], "trip"));
    act(() => q("[data-chathead-threads]")!.click());
    expect(chips()[0].textContent).toBe("Weekly sales");
    expect(chips()[0].querySelector('[aria-label="Main"]')).not.toBeNull();
    expect(chips()[1].querySelector('[aria-label="Main"]')).toBeNull();
  });

  it("folds back from the same chevron, which says what it will do", () => {
    render(pepper(THREADS, "launch"));
    const chevron = q("[data-chathead-threads]")!;
    expect(chevron.getAttribute("aria-label")).toBe("Expand Pepper threads");
    act(() => chevron.click());
    expect(q("[role=listbox]")).not.toBeNull();
    expect(q("[data-chathead-threads]")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("[data-chathead-threads]")!.getAttribute("aria-label")).toBe("Collapse Pepper threads");
    act(() => q("[data-chathead-threads]")!.click());
    expect(q("[role=listbox]")).toBeNull();
    expect(q("[data-chathead-threads]")!.getAttribute("aria-expanded")).toBe("false");
    expect(sent()).toEqual([]);
  });

  it("switches to a picked thread and folds back", () => {
    render(pepper(THREADS, "launch"));
    act(() => q("[data-chathead-threads]")!.click());
    act(() => chips()[2].click());
    expect(sent()).toEqual([{ type: "switchTask", botId: "pepper", threadId: "trip" }]);
    expect(q("[role=listbox]")).toBeNull();
  });

  it("moves between threads with the arrow keys, and folds back on Escape", () => {
    render(pepper(THREADS, "launch"));
    act(() => q("[data-chathead-threads]")!.click());
    act(() => chips()[0].focus());
    act(() => { chips()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(document.activeElement).toBe(chips()[1]);
    act(() => { chips()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(q("[role=listbox]")).toBeNull();
    expect(sent()).toEqual([]);
  });

  it("starts a new thread from its plus, folded or open", () => {
    render(pepper(THREADS, "launch"));
    act(() => q("[data-thread-chip-new]")!.click());
    expect(sent()).toEqual([{ type: "newTask", botId: "pepper" }]);
    act(() => q("[data-chathead-threads]")!.click());
    act(() => q("[data-thread-chip-new]")!.click());
    expect(sent()).toHaveLength(2);
    expect(q("[role=listbox]")).toBeNull();
  });

  it("has no plus for someone who can only view the bot", () => {
    render({ ...pepper(THREADS, "launch"), yourAccess: "view" } as Bot);
    expect(q("[data-chathead-threads]")).not.toBeNull();
    expect(q("[data-thread-chip-new]")).toBeNull();
  });

  it("stays the plain pill for a bot with one thread", () => {
    render(pepper([task("sales", "Weekly sales", 5)], "sales"));
    expect(q("[data-chathead-threads]")).toBeNull();
    expect(q("[data-chathead-switch]")).toBeNull();
    expect(q("[data-chathead-pill]")).not.toBeNull();
  });
});
