// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { RoomFeedRow, type FeedRowActions, type FeedRowData } from "./RoomFeedRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/state/api", async (original) => ({ ...(await original<typeof import("@/state/api")>()), api: vi.fn(() => new Promise(() => {})) }));

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const bot = (id: string, name: string, color: Bot["color"]) => ({ id, name, color, threadId: `${id}-main`, messages: [] } as unknown as Bot);
const BOTS = [bot("kiwi", "Kiwi", "green"), bot("pip", "Pip", "purple")];
const row = (extra: Partial<FeedRowData> = {}): FeedRowData => ({
  threadId: "t1", speaker: { person: { name: "Ana" } }, text: "Plan the launch", at: NOW - 3_600_000,
  replies: 0, lastReplyAt: null, repliers: [], mark: null, working: false, workingBotId: null, ...extra,
});

let root: Root | null = null;
const render = (data: FeedRowData, onOpen = vi.fn(), open = false, actions?: FeedRowActions) => {
  root = createRoot(document.body.appendChild(document.createElement("ol")));
  act(() => root!.render(createElement(RoomFeedRow, { row: data, groupId: "room", bots: BOTS, you: "Sam", now: NOW, open, onOpen, actions })));
  return onOpen;
};
const roomActions = (deletable = true): FeedRowActions => ({ onRename: vi.fn(), onDelete: vi.fn(), onPin: vi.fn(), onArchive: vi.fn(), onSetClosed: vi.fn(), deletable });
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-thread-overlay] button")].find((button) => button.textContent?.includes(label));
const item = () => document.querySelector<HTMLElement>("[data-feed-thread]")!;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("a room feed row", () => {
  it("shows the first line, who said it and when, and opens its thread from anywhere on the row", () => {
    const onOpen = render(row());
    expect(item().textContent).toContain("Ana");
    expect(item().textContent).toContain("Plan the launch");
    expect(item().textContent).toContain("1 h ago");
    expect(item().textContent).toContain("No replies yet");
    const button = item().querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Ana, Plan the launch, No replies yet");
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("counts the replies, shows who wrote them and when the last came", () => {
    render(row({ replies: 4, lastReplyAt: NOW - 5 * 60_000, repliers: [{ botId: "kiwi" }, { person: { name: "Ana" } }, { botId: "pip" }, { botId: "kiwi" }] }));
    expect(item().textContent).toContain("4 replies");
    expect(item().textContent).toContain("Last reply 5 min ago");
    expect(item().querySelector("[data-feed-repliers]")!.children).toHaveLength(3);
    act(() => root!.unmount());
    render(row({ replies: 1, lastReplyAt: NOW - 30_000, repliers: [{ botId: "kiwi" }] }));
    expect(item().textContent).toContain("1 reply");
    expect(item().textContent).toContain("Last reply just now");
  });

  it("names a bot in its colour, and a person with no name by the profile's", () => {
    render(row({ speaker: { botId: "pip" }, text: "**Morning** brief" }));
    expect(item().querySelector('[data-bot-color="purple"]')?.textContent).toBe("Pip");
    expect(item().querySelector("strong")?.textContent).toBe("Morning");
    act(() => root!.unmount());
    render(row({ speaker: { person: {} } }));
    expect(item().textContent).toContain("Sam");
  });

  it("marks a thread waiting on the person over unread, and says a bot is answering", () => {
    render(row({ mark: "waiting" }));
    expect(item().querySelector("[data-feed-mark]")?.getAttribute("data-feed-mark")).toBe("waiting");
    expect(item().querySelector("button")!.getAttribute("aria-label")).toContain("Waiting for you…");
    act(() => root!.unmount());
    render(row({ mark: "unread", working: true, workingBotId: "kiwi", replies: 2 }));
    expect(item().querySelector("[data-feed-mark]")?.getAttribute("data-feed-mark")).toBe("unread");
    expect(item().textContent).toContain("Kiwi is working…");
    expect(item().textContent).not.toContain("2 replies");
  });

  it("shows a work thread's one status beside its time, where Closed would be, and says it to a screen reader", () => {
    render(row({ work: { kind: "needs", label: "Needs you" }, closedBy: { botId: "kiwi", name: "Kiwi", at: NOW } }));
    const work = item().querySelector("[data-feed-work]")!;
    expect([work.getAttribute("data-feed-work"), work.textContent]).toEqual(["needs", "Needs you"]);
    expect(work.className).toContain("text-ink");
    expect(item().querySelector("[data-feed-closed]")).toBeNull();
    expect(item().querySelector("button")!.getAttribute("aria-label")).toBe("Ana, Plan the launch, No replies yet, Needs you");
    act(() => root!.unmount());
    render(row({ work: { kind: "next", label: "Up next" } }));
    expect(item().querySelector("[data-feed-work]")?.className).toContain("text-ink-tertiary");
  });

  it("says a bot is working on a work thread once: the line under it does while its turn runs", () => {
    render(row({ work: { kind: "working", label: "Kiwi working" }, working: true, workingBotId: "kiwi" }));
    expect(item().querySelector("[data-feed-work]")).toBeNull();
    expect(item().textContent).toContain("Kiwi is working…");
    act(() => root!.unmount());
    render(row({ work: { kind: "working", label: "Kiwi working" } }));
    expect(item().querySelector("[data-feed-work]")?.textContent).toBe("Kiwi working");
  });

  it("fades a long line, ends a clipped one with an ellipsis, and names an attachment-only line", () => {
    render(row({ text: "word ".repeat(80), clipped: true }));
    const body = item().querySelector<HTMLElement>(".chat-text")!;
    expect(body.className).toContain("mask-image");
    expect(body.textContent?.endsWith("…")).toBe(true);
    act(() => root!.unmount());
    render(row({ text: '<attached-image path="/tmp/omb-uploads/a.png" name="a.png" />' }));
    expect(item().textContent).toContain("An attachment");
  });

  it("shows the row whose thread is open beside the feed as current", () => {
    render(row(), vi.fn(), true);
    expect(item().querySelector("button")!.getAttribute("aria-current")).toBe("true");
    expect(item().className).toContain("bg-raised");
  });

  it("gives a thread the sidebar row's menu from a quiet More button: pin, archive and rename it there", () => {
    const actions = roomActions();
    render(row({ title: "Launch plan" }), vi.fn(), false, actions);
    const more = item().querySelector<HTMLButtonElement>('button[aria-label="Actions for Launch plan"]')!;
    expect(more.className).toContain("group-hover:opacity-100");
    expect(more.className).toContain("focus-visible:opacity-100");
    expect(more.className).toContain("touch:opacity-70");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(["Rename thread", "Pin", "Archive", "Delete"].every((label) => menuItem(label))).toBe(true);
    act(() => menuItem("Pin")!.click());
    expect(actions.onPin).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1", title: "Launch plan" }), true);
    act(() => more.click());
    act(() => menuItem("Archive")!.click());
    expect(actions.onArchive).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" }), expect.any(Number));
    act(() => more.click());
    act(() => menuItem("Rename thread")!.click());
    const field = item().querySelector<HTMLInputElement>('input[aria-label="Rename thread"]')!;
    expect(field.value).toBe("Launch plan");
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Launch week"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(actions.onRename).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" }), "Launch week");
  });

  it("marks a pinned thread with the pin, an archived one as archived with Unarchive in its menu, keeps a room's only thread, and gives a line on its way no menu", () => {
    render(row({ title: "Launch plan", pinned: true, archived: true }), vi.fn(), false, roomActions());
    expect(item().querySelector("[data-feed-pinned]")?.getAttribute("aria-label")).toBe("Pin");
    expect(item().textContent).toContain("Archived");
    act(() => item().querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(menuItem("Unpin")).toBeDefined();
    expect(menuItem("Unarchive")).toBeDefined();
    act(() => root!.unmount());
    render(row({ title: "Only thread" }), vi.fn(), false, roomActions(false));
    act(() => item().querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(menuItem("Archive")).toBeDefined();
    expect(menuItem("Delete")).toBeUndefined();
    act(() => root!.unmount());
    render(row({ threadId: "" }), vi.fn(), false, roomActions());
    expect(item().querySelector("button[aria-expanded]")).toBeNull();
  });
});
