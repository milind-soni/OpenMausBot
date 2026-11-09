// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { CompactBotThreads } from "./CompactBotThreads";
import { threadStatus } from "./ThreadStatus";
import { requestThreadList } from "@/lib/thread-list-navigation";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async importOriginal => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [], groups: [], pendingQueued: {} }, dispatch: fixture.dispatch }),
}));
const { TaskPicker } = await import("./TaskPicker");
let root: Root;
let container: HTMLDivElement;
let bot: Bot;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fixture.dispatch.mockClear();
  bot = {
    id: "navigation", name: "Navigation", color: "green", threadId: "a", title: "", description: "", notifications: true,
    unread: false, busy: false, activity: "idle", messages: [], modelSelection: { instanceId: "fake", model: "fake" },
    tasks: [
      { threadId: "a", title: "Network audit", createdAt: 1, activity: "idle" },
      { threadId: "b", title: "Device inventory", createdAt: 2, busy: true, activity: "working" },
      { threadId: "c", title: "Permission review", createdAt: 3, activity: "waiting-on-you" },
      { threadId: "d", title: "Next report", createdAt: 4 },
    ],
  };
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
const row = (id: string) => container.querySelector<HTMLButtonElement>(`[data-agent-thread="${id}"]`)!;
const click = (button: HTMLElement) => flushSync(() => button.click());
const mount = () => flushSync(() => root.render(createElement(CompactBotThreads, { bot, selected: true, pendingQueued: { d: [{}] }, dispatch: fixture.dispatch })));

describe("persistent thread navigation", () => {
  it("keeps both conversations visible after switching and marks only the current one", () => {
    const original = structuredClone(bot);
    mount();
    click(row("b"));
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: bot.id, threadId: "b" });
    expect(bot).toEqual(original);
    bot = { ...bot, threadId: "b" };
    mount();
    expect(row("a")).not.toBeNull();
    expect(row("b").getAttribute("aria-current")).toBe("page");
    expect(row("a").hasAttribute("aria-current")).toBe(false);
    click(row("a"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: bot.id, threadId: "a" });
    expect(container.querySelectorAll("[data-agent-thread]")).toHaveLength(4);
  });

  it("updates per-thread status without borrowing another thread's activity or hiding a settled row", () => {
    bot = { ...bot, busy: true, activity: "working" };
    mount();
    expect(row("b").textContent).toContain("Working");
    expect(row("c").textContent).toContain("Waiting for you");
    expect(row("d").textContent).toContain("Queued");
    bot = { ...bot, tasks: bot.tasks!.map(task => task.threadId === "b" ? { ...task, busy: false, activity: "idle" } : task) };
    mount();
    expect(row("b").textContent).toContain("Idle");
    expect(container.querySelectorAll("[data-agent-thread]")).toHaveLength(4);
    click(container.querySelector<HTMLButtonElement>("[aria-controls]")!);
    expect(container.querySelector("nav")!.hidden).toBe(true);
    click(container.querySelector<HTMLButtonElement>("[aria-controls]")!);
    expect(row("b").textContent).toContain("Idle");
  });

  it("opens the same picker on menu requests, exposes current title, switches exact IDs and dismisses with Escape", () => {
    flushSync(() => root.render(createElement(TaskPicker, { bot })));
    expect(container.querySelector("[aria-expanded]")!.getAttribute("aria-label")).toBe("All threads: Network audit");
    flushSync(() => requestThreadList(bot.id));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const target = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.includes("Device inventory"))!;
    click(target);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: bot.id, threadId: "b" });
    bot = { ...bot, threadId: "b" };
    flushSync(() => root.render(createElement(TaskPicker, { bot })));
    expect(container.querySelector("[aria-expanded]")!.getAttribute("aria-label")).toBe("All threads: Device inventory");
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => root.render(createElement(TaskPicker, { bot })));
    expect(container.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("distinguishes waiting, working, queued, completed and idle", () => {
    expect(threadStatus({ busy: true, activity: "waiting-on-you" }, true)).toBe("waitingForYou");
    expect(threadStatus({ busy: true, waitingForTeammates: true })).toBe("waitingForTeammate");
    expect(threadStatus({ activity: "working" }, true)).toBe("working");
    expect(threadStatus({}, true)).toBe("queued");
    expect(threadStatus({ archivedAt: 0 })).toBe("completed");
    expect(threadStatus({})).toBe("idle");
  });
});
