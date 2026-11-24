// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { setThreadsUnfolded } from "@/lib/thread-fold-preferences";
import { SidebarThreadLabels } from "./SidebarThreadLabels";

const now = Date.now();
const task = (threadId: string, title: string, hoursAgo: number, extra: Partial<Task> = {}): Task =>
  ({ threadId, title, createdAt: now - hoursAgo * 3_600_000, updatedAt: now - hoursAgo * 3_600_000, ...extra });
const research = (extra: Partial<Bot> = {}): Bot => ({
  id: "research", threadId: "pricing", name: "Research", title: "", description: "", notifications: true, color: "green",
  unread: false, modelSelection: { instanceId: "fake", model: "fake" }, messages: [],
  tasks: [task("pricing", "Competitor pricing", 1), task("home", "A long title for the conversation this bot always comes back to", 2), task("deck", "Board deck", 3)],
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
const render = (bot: Bot) => flushSync(() => root.render(createElement(SidebarThreadLabels, { bot, selected: true, rowThreadId: bot.threadId, pendingQueued: {}, dispatch: vi.fn() })));
const marked = () => [...host.querySelectorAll("[data-main-thread-mark]")].map((mark) => mark.closest("[data-thread-label]")?.getAttribute("data-thread-label"));

beforeEach(() => {
  localStorage.clear();
  setThreadsUnfolded("research", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("a bot's threads unfolded under its row in Simple mode", () => {
  it("marks the bot's main thread, and no other row, with a mark a long title cannot push out", () => {
    render(research({ mainThreadId: "home" }));
    expect(marked()).toEqual(["home"]);
    const mark = host.querySelector("[data-main-thread-mark]")!;
    expect([mark.getAttribute("role"), mark.getAttribute("aria-label"), mark.textContent]).toEqual(["img", "Main thread", "Main"]);
    expect(mark.className).toContain("shrink-0");
    render(research({ mainThreadId: "deck" }));
    expect(marked()).toEqual(["deck"]);
    render(research());
    expect(marked()).toEqual([]);
  });
});
