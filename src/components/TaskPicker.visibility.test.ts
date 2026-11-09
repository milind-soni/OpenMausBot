// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ showThreads: true, queued: {} as Record<string, unknown[]>, bots: [] as Bot[], dispatch: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: (_id: string, level?: string) => level !== "view" }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.bots, pendingQueued: fixture.queued }, dispatch: fixture.dispatch }),
}));

const { TaskPicker, BotActivityPicker, GroupTaskPicker } = await import("./TaskPicker");
const bot: Bot = {
  id: "pepper", name: "Pepper", color: "green", threadId: "current", title: "", description: "",
  notifications: true, unread: false, busy: true, messages: [], modelSelection: { instanceId: "fake", model: "fake" },
  tasks: [
    { threadId: "current", title: "Current chat", createdAt: 1, busy: true, activity: "working" },
    { threadId: "idle", title: "Quiet history", createdAt: 2, busy: false },
    { threadId: "waiting", title: "Approval needed", createdAt: 3, busy: false, activity: "waiting-on-you" },
    { threadId: "working", title: "Research", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5, busy: false },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
beforeEach(() => { fixture.showThreads = true; fixture.queued = {}; fixture.bots = []; fixture.dispatch.mockClear(); });

describe("task picker IME keyboard handling", () => {
  const group: Group = {
    id: "team", name: "Team", threadId: "current", memberIds: [], defaultResponder: { kind: "everyone" },
    bulletin: "", createdAt: 1, unread: false, messages: [],
    tasks: [{ threadId: "current", title: "Current chat", createdAt: 1 }, { threadId: "other", title: "Other chat", createdAt: 2 }],
  };
  const composing = [{ isComposing: true }, { keyCode: 229 }];
  let host: HTMLDivElement;
  let root: Root;

  const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const search = () => input(t("task.search"));
  const rename = () => input(t("task.renameAria"));
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    flushSync(() => target.dispatchEvent(event));
    return event;
  };
  const type = (target: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setValue.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const startRename = () => {
    const button = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === t("task.renameNamed", { title: "Current chat" }))!;
    flushSync(() => button.click());
    type(rename()!, "新的名字");
  };

  beforeEach(() => {
    document.documentElement.dataset.reducedMotion = "true";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => root.render(createElement(GroupTaskPicker, { group })));
    flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    delete document.documentElement.dataset.reducedMotion;
  });

  it.each(composing)("does not select or close on a composing search Enter: %j", (init) => {
    type(search()!, "Other");
    expect(press(search()!, "Enter", init).defaultPrevented).toBe(false);
    expect(search()?.value).toBe("Other");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(press(search()!, "Enter").defaultPrevented).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchGroupTask", groupId: "team", threadId: "other" });
    expect(search()).toBeNull();
  });

  describe.each(["", "Other"])("with search query %j", (query) => {
    it.each(composing)("does not clear or dismiss on a composing search Escape: %j", (init) => {
      type(search()!, query);
      expect(press(search()!, "Escape", init).defaultPrevented).toBe(false);
      expect(search()?.value).toBe(query);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(press(search()!, "Escape").defaultPrevented).toBe(true);
      if (query) {
        expect(search()?.value).toBe("");
        press(search()!, "Escape");
      }
      expect(search()).toBeNull();
    });
  });

  it.each(composing)("does not commit a rename on a composing Enter: %j", (init) => {
    startRename();
    expect(press(rename()!, "Enter", init).defaultPrevented).toBe(false);
    expect(rename()?.value).toBe("新的名字");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(press(rename()!, "Enter").defaultPrevented).toBe(true);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "renameGroupTask", groupId: "team", threadId: "current", title: "新的名字" });
    expect(rename()).toBeNull();
    expect(search()).not.toBeNull();
  });

  it.each(composing)("does not cancel a rename on a composing Escape: %j", (init) => {
    startRename();
    expect(press(rename()!, "Escape", init).defaultPrevented).toBe(false);
    expect(rename()?.value).toBe("新的名字");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(press(rename()!, "Escape").defaultPrevented).toBe(true);
    expect(rename()).toBeNull();
    expect(search()).not.toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});

describe("optional bot thread picker", () => {
  it("keeps the usual picker when threads are shown", () => {
    expect(renderToStaticMarkup(createElement(TaskPicker, { bot }))).toContain('aria-label="All threads: Current chat"');
  });

  it("keeps the current title and status visible when the thread tree is hidden", () => {
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(BotActivityPicker, { bot }));
    expect(markup).not.toContain(">Current thread<");
    expect(markup).toContain("Current chat");
    expect(markup).toContain('data-thread-status="working"');
    expect(markup).toContain('aria-label="Working in other threads: 1"');
  });

  it("keeps current-thread navigation visible even with no background work", () => {
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(BotActivityPicker, { bot: { ...bot, busy: false, tasks: bot.tasks!.slice(0, 2).map(task => ({ ...task, busy: false })) } }));
    expect(markup).toContain("Current chat");
    expect(markup).toContain('aria-label="All threads: Current chat"');
  });

  it("does not remove channel history controls", () => {
    fixture.showThreads = false;
    const group: Group = { id: "team", name: "Team", threadId: "team-current", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 1, unread: false, messages: [],
      tasks: [{ threadId: "team-current", title: "Channel discussion", createdAt: 1 }] };
    expect(renderToStaticMarkup(createElement(GroupTaskPicker, { group }))).toContain('aria-label="All threads"');
  });
});
