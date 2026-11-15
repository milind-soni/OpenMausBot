// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Task } from "@/state/store";
import { PEEK_CLOSE_MS, SidebarBotThreadsPeek } from "./SidebarBotThreadsPeek";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...extra });

let row: HTMLElement;
let scroller: HTMLElement;
let chat: HTMLElement;
let root: Root;
const dispatch = vi.fn<(action: Action) => void>();

const mount = async (tasks: Task[]) => {
  scroller = document.createElement("div");
  chat = document.createElement("div");
  document.body.append(scroller, chat);
  root = createRoot(scroller);
  await act(async () => {
    root.render(createElement("div", { "data-row": "" },
      createElement(SidebarBotThreadsPeek, { bot: { id: "atlas", name: "Atlas", threadId: "main", mainThreadId: "main", tasks: [task("main"), ...tasks] }, dispatch })));
  });
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

describe("the hover sheet of a bot's other conversations", () => {
  it("stays open while the pointer goes from the row onto it", async () => {
    await mount([task("a")]);
    await open();
    await cross(row, sheet()!);
    await wait(PEEK_CLOSE_MS * 5);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(sheet()).not.toBeNull();
  });

  it("stays open when the pointer crosses something else on the way, and closes shortly after leaving both", async () => {
    await mount([task("a")]);
    await open();
    await cross(row, chat);
    await wait(PEEK_CLOSE_MS / 2);
    await cross(chat, sheet()!);
    await wait(PEEK_CLOSE_MS * 5);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    await cross(sheet()!, row);
    await wait(PEEK_CLOSE_MS * 5);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    await cross(row, chat);
    await wait(PEEK_CLOSE_MS - 1);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    await wait(1);
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
});
