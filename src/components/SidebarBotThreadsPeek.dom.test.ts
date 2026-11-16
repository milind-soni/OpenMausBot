// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPEAHEAD_RESET_MS } from "@/lib/menu-keys";
import type { Action, Task } from "@/state/store";
import { SidebarBotThreadsPeek } from "./SidebarBotThreadsPeek";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...extra });

let row: HTMLElement;
let scroller: HTMLElement;
let chat: HTMLElement;
let root: Root;
const dispatch = vi.fn<(action: Action) => void>();

const show = async (tasks: Task[], shown: { threadId?: string; onScreen?: boolean } = {}) => {
  await act(async () => {
    root.render(createElement("div", { "data-row": "" },
      createElement(SidebarBotThreadsPeek, { bot: { id: "atlas", name: "Atlas", threadId: shown.threadId ?? "main", mainThreadId: "main", tasks: [task("main"), ...tasks] }, onScreen: shown.onScreen, dispatch })));
  });
};
const mount = async (tasks: Task[], shown: { threadId?: string; onScreen?: boolean } = {}) => {
  scroller = document.createElement("div");
  chat = document.createElement("div");
  document.body.append(scroller, chat);
  root = createRoot(scroller);
  await show(tasks, shown);
  row = scroller.querySelector<HTMLElement>("[data-row]")!;
};
const chevron = () => row.querySelector<HTMLButtonElement>("[data-bot-threads-peek]")!;
const sheet = () => document.querySelector<HTMLElement>("[data-bot-threads-sheet]:not([inert])");
const open = async () => { await act(async () => { chevron().click(); }); };
const pointer = (type: string, target: Element, relatedTarget: Element) =>
  target.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", relatedTarget, bubbles: !/enter|leave/.test(type) }));
// The order a browser reports one crossing in: out and leave on the old element, then over and enter on the new one.
const cross = async (from: Element, to: Element) => {
  await act(async () => { for (const [type, target, related] of [["pointerout", from, to], ["pointerleave", from, to], ["pointerover", to, from], ["pointerenter", to, from]] as const) pointer(type, target, related); });
};
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const action = (threadId: string, kind: string) => sheet()!.querySelector(`[data-peek-thread="${threadId}"]`)!.parentElement!.querySelector<HTMLButtonElement>(`[data-peek-action="${kind}"]`)!;

beforeEach(() => { vi.useFakeTimers(); dispatch.mockClear(); });
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the sheet of a bot's other conversations", () => {
  it("opens on a click of the chevron only, never on hover, and stays open when the pointer moves away", async () => {
    await mount([task("a")]);
    await cross(chat, row);
    await wait(5_000);
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(sheet()).toBeNull();

    await open();
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    await cross(row, chat);
    await wait(5_000);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    await open();
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
  });

  it("drops the disclosure's tooltip while the sheet is open", async () => {
    await mount([task("a")]);
    expect(chevron().title).toBe("Expand Atlas threads");
    await open();
    expect(chevron().hasAttribute("title")).toBe(false);
    expect(chevron().getAttribute("aria-label")).toBe("Expand Atlas threads");
  });

  it("closes when the list holding its row scrolls, not when anything else does", async () => {
    await mount([task("a")]);
    await open();
    await act(async () => { chat.dispatchEvent(new Event("scroll")); });
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
  });

  it("lists the main conversation first, with no way to archive or delete it, and opens it", async () => {
    await mount([task("a")], { threadId: "a", onScreen: true });
    await open();
    const rows = [...sheet()!.querySelectorAll<HTMLElement>("[data-peek-thread]")];
    expect(rows.map((entry) => entry.dataset.peekThread)).toEqual(["main", "a"]);
    expect(rows[0].querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Main thread");
    expect(rows[0].parentElement!.querySelector("[data-peek-action]")).toBeNull();
    await act(async () => { rows[0].click(); });
    expect(dispatch.mock.calls).toEqual([[{ type: "switchTask", botId: "atlas", threadId: "main" }]]);
  });

  it("marks the conversation on screen, and none for a bot that is not on screen", async () => {
    const marked = () => [...sheet()!.querySelectorAll<HTMLElement>("[data-peek-thread]")].filter((entry) => entry.getAttribute("aria-current") === "page" && entry.querySelector("svg.lucide-check")).map((entry) => entry.dataset.peekThread);
    await mount([task("a"), task("b")], { threadId: "a", onScreen: true });
    await open();
    expect(marked()).toEqual(["a"]);
    expect(sheet()!.querySelectorAll("svg.lucide-check")).toHaveLength(1);
    await act(async () => { root.unmount(); });
    await mount([task("a"), task("b")], { threadId: "a" });
    await open();
    expect(sheet()!.querySelector("[aria-current], svg.lucide-check")).toBeNull();
  });

  it("keeps the conversation on screen in the list when newer ones fill it", async () => {
    await mount([task("old", { updatedAt: 1 }), task("b", { updatedAt: 4 }), task("c", { updatedAt: 3 }), task("d", { updatedAt: 2 })], { threadId: "old", onScreen: true });
    await open();
    expect([...sheet()!.querySelectorAll<HTMLElement>("[data-peek-thread]")].map((entry) => entry.dataset.peekThread)).toEqual(["main", "b", "c", "d", "old"]);
    expect(sheet()!.querySelector('[data-peek-thread="old"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("archives a conversation from its row without opening it or closing the sheet", async () => {
    await mount([task("a"), task("b")]);
    await open();
    const archive = action("a", "archive");
    expect(archive.getAttribute("aria-labelledby")!.split(" ").map((id) => document.getElementById(id)?.textContent || document.getElementById(id)?.getAttribute("aria-label"))).toEqual(["Archive", "a"]);
    await act(async () => { archive.click(); });
    expect(dispatch.mock.calls).toEqual([[{ type: "updateTask", botId: "atlas", threadId: "a", patch: { archivedAt: expect.any(Number) } }]]);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
  });

  it("deletes a conversation only after the same confirmation its thread row asks", async () => {
    await mount([task("a")]);
    await open();
    await act(async () => { action("a", "delete").click(); });
    expect(dispatch).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>("[role=alertdialog], [role=dialog]")!;
    expect(dialog.textContent).toContain("Delete thread?");
    expect(dialog.textContent).toContain("“a” and its conversation will be deleted.");
    await act(async () => { [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!.click(); });
    expect(dispatch.mock.calls).toEqual([[{ type: "deleteTask", botId: "atlas", threadId: "a" }]]);
  });

  it("does not delete a conversation that started working while the confirmation was open", async () => {
    await mount([task("a")]);
    await open();
    await act(async () => { action("a", "delete").click(); });
    await show([task("a", { busy: true })]);
    const dialog = document.querySelector<HTMLElement>("[role=alertdialog], [role=dialog]")!;
    await act(async () => { [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete thread")!.click(); });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stays inside the window when its rows are taller than a mouse's, as on a touch screen", async () => {
    await mount([task("a"), task("b"), task("c")]);
    row.getBoundingClientRect = () => ({ left: 8, right: 300, top: window.innerHeight - 20 }) as DOMRect;
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(185);
    await open();
    height.mockRestore();
    expect(sheet()!.style.top).toBe(`${window.innerHeight - 185 - 8}px`);
  });

  it("moves up when it grows taller while open, and stops watching its height once closed", async () => {
    const watchers: { resized: () => void; target?: Element; live: boolean }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      private entry: (typeof watchers)[number];
      constructor(resized: () => void) { this.entry = { resized, live: true }; watchers.push(this.entry); }
      observe(target: Element) { this.entry.target = target; }
      disconnect() { this.entry.live = false; }
    });
    await mount([task("a"), task("b"), task("c")]);
    row.getBoundingClientRect = () => ({ left: 8, right: 300, top: window.innerHeight - 20 }) as DOMRect;
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(180);
    await open();
    expect(sheet()!.style.top).toBe(`${window.innerHeight - 180 - 8}px`);

    height.mockReturnValue(225);
    const watching = watchers.filter((entry) => entry.live);
    expect(watching.map((entry) => entry.target)).toEqual([sheet()]);
    await act(async () => { watching[0].resized(); });
    expect(sheet()!.style.top).toBe(`${window.innerHeight - 225 - 8}px`);

    await open();
    height.mockRestore();
    vi.unstubAllGlobals();
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(watchers.filter((entry) => entry.live)).toEqual([]);
  });

  it("lists a snoozed conversation once its snooze ends, with nothing else changing", async () => {
    const tasks = [task("a", { snoozedUntil: Date.now() + 60_000 })];
    await mount(tasks);
    expect(row.querySelector("[data-bot-new-thread]")).not.toBeNull();
    expect(row.querySelector("[data-bot-threads-peek]")).toBeNull();
    await wait(60_000);
    expect(row.querySelector("[data-bot-threads-peek]")).toBeNull();
    await wait(1);
    expect(row.querySelector("[data-bot-new-thread]")).toBeNull();
    await open();
    expect([...sheet()!.querySelectorAll<HTMLElement>("[data-peek-thread]")].map((entry) => entry.dataset.peekThread)).toEqual(["main", "a"]);
  });

  it("offers neither action for a conversation that is working", async () => {
    await mount([task("a", { busy: true })]);
    await open();
    expect(action("a", "archive").disabled).toBe(true);
    expect(action("a", "delete").disabled).toBe(true);
  });

  it("reaches a row's actions with the arrow keys and moves on to the next row", async () => {
    await mount([task("a"), task("b")]);
    await open();
    const key = async (name: string) => { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); }); };
    const thread = (id: string) => sheet()!.querySelector<HTMLElement>(`[data-peek-thread="${id}"]`)!;
    thread("a").focus();
    await key("ArrowRight");
    expect(document.activeElement).toBe(action("a", "archive"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(action("a", "delete"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(thread("a"));
    await key("ArrowLeft");
    expect(document.activeElement).toBe(action("a", "delete"));
    await key("ArrowDown");
    expect(document.activeElement).toBe(thread("b"));
  });

  it("jumps to the conversation whose title starts with the letters typed", async () => {
    await mount([task("a", { title: "Pricing review" }), task("b", { title: "Supplier follow-up" }), task("c", { title: "Price list" })]);
    await open();
    const type = async (text: string) => {
      for (const key of text) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true });
        Object.defineProperty(event, "timeStamp", { value: Date.now() });
        await act(async () => { document.activeElement!.dispatchEvent(event); });
      }
    };
    const thread = (id: string) => sheet()!.querySelector<HTMLElement>(`[data-peek-thread="${id}"]`)!;
    sheet()!.querySelector<HTMLElement>("[role=menuitem]")!.focus();
    await type("s");
    expect(document.activeElement).toBe(thread("b"));
    await wait(TYPEAHEAD_RESET_MS);
    await type("pric");
    expect(document.activeElement).toBe(thread("c"));
    await type("i");
    expect(document.activeElement).toBe(thread("a"));
    action("a", "archive").focus();
    await wait(TYPEAHEAD_RESET_MS);
    await type("n");
    expect(document.activeElement?.textContent).toBe("New thread");
  });
});
