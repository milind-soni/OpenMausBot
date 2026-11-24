// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { RoomFeedRow, type FeedRowData } from "./RoomFeedRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const bot = (id: string, name: string, color: Bot["color"]) => ({ id, name, color, threadId: `${id}-main`, messages: [] } as unknown as Bot);
const BOTS = [bot("kiwi", "Kiwi", "green"), bot("pip", "Pip", "purple")];
const row = (extra: Partial<FeedRowData> = {}): FeedRowData => ({
  threadId: "t1", speaker: { person: { name: "Ana" } }, text: "Plan the launch", at: NOW - 3_600_000,
  replies: 0, lastReplyAt: null, repliers: [], mark: null, working: false, workingBotId: null, ...extra,
});

let root: Root | null = null;
const render = (data: FeedRowData, onOpen = vi.fn(), open = false) => {
  root = createRoot(document.body.appendChild(document.createElement("ol")));
  act(() => root!.render(createElement(RoomFeedRow, { row: data, bots: BOTS, you: "Sam", now: NOW, open, onOpen })));
  return onOpen;
};
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
});
