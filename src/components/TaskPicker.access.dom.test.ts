// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { TaskPicker } from "./TaskPicker";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/lib/session", () => ({ readSessionState: async () => ({ kind: "session", cloudGuest: true, openedThreads: ["mine"] }) }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [], groups: [], pendingQueued: {} }, dispatch: fixture.dispatch }),
}));
const bot: Bot = {
  id: "access", name: "Access", threadId: "mine", color: "green", title: "", description: "", notifications: true,
  unread: false, busy: true, activity: "working", messages: [], modelSelection: { instanceId: "fake", model: "fake" },
  projects: [{ id: "folder", name: "Folder" }],
  tasks: [
    { threadId: "mine", title: "My work", createdAt: 1 },
    { threadId: "theirs", title: "Read only", createdAt: 2, busy: false, activity: "idle" },
    { threadId: "routine", title: "Running routine", createdAt: 3, routineRunId: "r", busy: true, activity: "working" },
    { threadId: "ended", title: "Ended routine", createdAt: 4, routineRunId: "done" },
  ],
};
let root: Root;
let host: HTMLDivElement;
afterEach(() => { flushSync(() => root?.unmount()); host?.remove(); fixture.dispatch.mockClear(); });
const mount = async (profile = bot) => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root.render(createElement(TaskPicker, { bot: profile })));
  flushSync(() => host.querySelector<HTMLButtonElement>("[aria-expanded]")!.click());
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Rename My work"]')).not.toBeNull());
};
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button[aria-current], button.min-w-0')].find(b => b.textContent?.includes(text))!;

describe("thread picker access and activity", () => {
  it("uses per-thread guest access for controls and rename gestures, while read-only threads can be opened", async () => {
    await mount();
    const writable = button("My work").parentElement!;
    const readonly = button("Read only").parentElement!;
    expect(writable.querySelector('[aria-label="Rename My work"]')).not.toBeNull();
    expect(writable.querySelector("select")).not.toBeNull();
    expect(readonly.querySelectorAll("button")).toHaveLength(1);
    expect(readonly.querySelector("select")).toBeNull();
    expect(button("Read only").title).toBe("");
    flushSync(() => button("Read only").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    flushSync(() => button("Read only").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(host.querySelector('[aria-label="Rename thread"]')).toBeNull();
    flushSync(() => button("Read only").click());
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "access", threadId: "theirs" });
  });

  it("projects missing current-task activity, disables deletion and retains running routine navigation", async () => {
    await mount();
    const current = button("My work");
    expect(current.textContent).toContain("Working");
    expect(current.parentElement!.querySelector<HTMLButtonElement>('[aria-label="Delete thread"]')!.disabled).toBe(true);
    expect(host.textContent).toContain("Running routine");
    expect(host.textContent).not.toContain("Ended routine");
    expect(button("Read only").textContent).toContain("Idle");
  });

  it("preserves explicit current-task idle values over aggregate bot activity", async () => {
    await mount({ ...bot, tasks: bot.tasks!.map(task => task.threadId === "mine" ? { ...task, busy: false, activity: "idle" } : task) });
    expect(button("My work").textContent).toContain("Idle");
    expect(button("My work").parentElement!.querySelector<HTMLButtonElement>('[aria-label="Delete thread"]')!.disabled).toBe(false);
  });
});
