// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Bot, Task } from "@/state/store";
import { newChatThreadId } from "@/state/new-chat";

const feature = vi.hoisted(() => ({ on: true }));
const dispatch = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ state: { bots: [] as unknown[], newChat: null } }));
vi.mock("@/lib/use-feature", () => ({ useFeature: (name: string) => name === "threadTabs" && feature.on }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => dispatch, useStoreSelector: (select: (state: unknown) => unknown) => select(store.state) }));

import { HeaderThreadTabs, useBotHasThreads, useThreadTabsShown } from "./HeaderThreadTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, title: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: at, lastThreadOrderAt: at, ...extra });
const kiwi = (tasks: Task[], threadId: string): Bot => ({ id: "kiwi", name: "Kiwi", threadId, mainThreadId: "main", tasks, messages: [] } as unknown as Bot);
const FIVE = [
  task("main", "Weekly sales", 5, { busy: true }), task("launch", "Launch plan", 1, { pinned: true }),
  task("invoice", "Invoice for Acme", 4), task("trip", "Berlin trip", 3), task("notes", "Call notes", 2),
];

let root: Root | null = null;
const render = (bot: Bot) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(createElement(HeaderThreadTabs, { bot })));
};
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
const tab = (title: string) => tabs().find((element) => element.textContent?.includes(title))!;
const closeOf = (title: string) => tab(title).querySelector<HTMLButtonElement>("button")!;
const sent = () => dispatch.mock.calls.map(([action]) => action as Action);

beforeEach(() => { feature.on = true; dispatch.mockClear(); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("thread tab strip", () => {
  it("is not there while Thread tabs is off, even for a bot with many threads", () => {
    feature.on = false;
    render(kiwi(FIVE, "launch"));
    expect(document.querySelector("[data-thread-tabs]")).toBeNull();
    act(() => root!.unmount());
    render(kiwi([task("main", "Only", 1)], "main"));
    expect(document.querySelector("[data-thread-tabs]")).toBeNull();
  });

  it("shows for a bot with one thread once Thread tabs is on: one tab with no close, and the + for a new one", () => {
    render(kiwi([task("main", "Only", 1)], "main"));
    expect(document.querySelector("[data-thread-tabs]")).not.toBeNull();
    expect(tabs().map((element) => element.getAttribute("data-tab-id"))).toEqual(["main"]);
    expect(tab("Only").getAttribute("aria-selected")).toBe("true");
    expect(closeOf("Only")).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>("[data-thread-tabs-new]")!.click());
    expect(sent()).toEqual([{ type: "newTask", botId: "kiwi" }]);
  });

  it("shows a brand-new bot's open thread as a tab before it has a thread row", () => {
    render(kiwi([], "main"));
    expect(tabs().map((element) => element.getAttribute("data-tab-id"))).toEqual(["main"]);
    expect(tab("Untitled chat").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-thread-tabs-new]")).not.toBeNull();
  });

  it("lists pinned threads first, then by recent use, with the open one selected", () => {
    render(kiwi(FIVE, "launch"));
    expect(tabs().map((element) => element.querySelector("[data-tab-label] > span")?.textContent)).toEqual(["Launch plan", "Weekly sales", "Invoice for Acme", "Berlin trip", "Call notes"]);
    expect(tab("Launch plan").getAttribute("aria-selected")).toBe("true");
    expect(tab("Weekly sales").querySelector('[aria-label="Working"]')).not.toBeNull();
    expect(tab("Launch plan").querySelector('[aria-label="Pinned"]')).not.toBeNull();
    expect(closeOf("Weekly sales"), "no close on the main or a running thread").toBeNull();
  });

  it("archives with ✕, never deletes, and gives Undo", () => {
    render(kiwi(FIVE, "launch"));
    act(() => closeOf("Berlin trip").click());
    expect(sent()).toEqual([expect.objectContaining({ type: "updateTask", botId: "kiwi", threadId: "trip", patch: { archivedAt: expect.any(Number) } })]);
    expect(sent().some((action) => action.type === "deleteTask" || action.type === "switchTask")).toBe(false);
    const undo = [...document.querySelectorAll("button")].find((button) => button.textContent === "Undo")!;
    act(() => undo.click());
    expect(sent().at(-1)).toMatchObject({ type: "updateTask", threadId: "trip", patch: { archivedAt: null } });
  });

  it("moves to the neighbouring tab when the open one is archived", () => {
    render(kiwi(FIVE, "invoice"));
    act(() => closeOf("Invoice for Acme").click());
    expect(sent().map((action) => action.type)).toEqual(["switchTask", "updateTask"]);
    expect(sent()[0]).toMatchObject({ botId: "kiwi", threadId: "trip" });
  });

  it("closes the blank New thread tab by going back to the thread open before it, archiving nothing", () => {
    store.state = { bots: [{ id: "kiwi", threadId: "launch" }], newChat: null };
    render(kiwi(FIVE, newChatThreadId("kiwi")));
    expect(tab("New thread").getAttribute("aria-selected")).toBe("true");
    act(() => closeOf("New thread").click());
    expect(sent()).toEqual([{ type: "switchTask", botId: "kiwi", threadId: "launch" }]);
  });

  it("archives on a middle click", () => {
    render(kiwi(FIVE, "launch"));
    act(() => { tab("Call notes").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })); });
    expect(sent()).toEqual([expect.objectContaining({ type: "updateTask", threadId: "notes", patch: { archivedAt: expect.any(Number) } })]);
  });

  it("leads with the bot's avatar and name, which open its panel", () => {
    render(kiwi(FIVE, "launch"));
    const chip = document.querySelector<HTMLButtonElement>("[data-thread-tabs-bot]")!;
    expect(chip.textContent).toBe("Kiwi");
    act(() => chip.click());
    expect(sent()).toEqual([{ type: "toggleSettings", open: true }]);
  });

  it("opens a tab on click and makes a new thread with +", () => {
    render(kiwi(FIVE, "launch"));
    act(() => tab("Berlin trip").click());
    act(() => document.querySelector<HTMLButtonElement>("[data-thread-tabs-new]")!.click());
    expect(sent()).toEqual([{ type: "switchTask", botId: "kiwi", threadId: "trip" }, { type: "newTask", botId: "kiwi" }]);
  });

  it("renames a tab in place on a double-click", () => {
    render(kiwi(FIVE, "launch"));
    act(() => { tab("Call notes").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Rename thread"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setValue.call(input, "Call with Dana"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(sent()).toEqual([{ type: "renameTask", botId: "kiwi", threadId: "notes", title: "Call with Dana" }]);
  });
});

describe("whether the header shows tabs, and Simple's pill switcher", () => {
  const Probe = () => createElement("output", { "data-tabs": String(useThreadTabsShown()), "data-pill": String(useBotHasThreads("kiwi")) });
  const render2 = (element: ReturnType<typeof createElement>) => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root!.render(element));
  };
  const probe = (bot: Bot) => {
    store.state = { bots: [bot], newChat: null };
    render2(createElement(Probe));
    const out = document.querySelector("output")!;
    return { tabs: out.dataset.tabs, pill: out.dataset.pill };
  };

  it("shows tabs for one thread with Thread tabs on, and keeps the pill switcher for two threads or more either way", () => {
    expect(probe(kiwi([task("main", "Only", 1)], "main"))).toEqual({ tabs: "true", pill: "false" });
    act(() => root!.unmount());
    feature.on = false;
    expect(probe(kiwi([task("main", "Only", 1)], "main"))).toEqual({ tabs: "false", pill: "false" });
    act(() => root!.unmount());
    expect(probe(kiwi(FIVE, "launch"))).toEqual({ tabs: "false", pill: "true" });
  });
});
