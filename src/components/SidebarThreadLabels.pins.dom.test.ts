// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, Task } from "@/state/store";
import { SidebarThreadLabels } from "./SidebarThreadLabels";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const thread = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, updatedAt: 1, ...extra });
const bot = (pinned: boolean) => ({ id: "counsel", name: "Counsel", threadId: "main", messages: [], tasks: [thread("main"), thread("weekly", { pinned: pinned || undefined }), thread("once")] }) as unknown as Bot;
const show = (pinned: boolean) => act(async () => root.render(createElement(SidebarThreadLabels, { bot: bot(pinned), selected: false, rowThreadId: "main", pendingQueued: {}, dispatch: () => {} })));
const row = () => container.querySelector('[data-thread-label="weekly"]');

it("keeps a pinned thread under its folded bot, marked, and folds it away with the fold motion once unpinned", async () => {
  await show(true);
  expect(row()?.textContent).toContain("weekly");
  expect(row()?.querySelector('[aria-label="Pinned"]')).not.toBeNull();
  expect(container.querySelector('[data-thread-label="once"]')).toBeNull();
  await show(false);
  expect(row()?.className).toContain("animate-pop-out");
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(row()).toBeNull();
});
