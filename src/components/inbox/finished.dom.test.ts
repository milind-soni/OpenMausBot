// @vitest-environment happy-dom
// The finished list shows when each conversation last moved.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Task } from "@/state/store";
import { t } from "@/lib/i18n";
import { FinishedThreads } from "./FinishedThreads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-15T16:00:00Z");
const task = (threadId: string, patch: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 0, updatedAt: NOW, ...patch });
const bot = (id: string, tasks: Task[]): Bot => ({ id, name: id, tasks } as unknown as Bot);

let root: Root;
const mount = (bots: Bot[], groups: Group[] = [], current?: { kind: "bot"; botId: string; threadId: string }) => act(async () => {
  root.render(createElement(FinishedThreads, { bots, groups, queued: {}, now: NOW, current, onOpen: vi.fn() }));
});

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the finished list", () => {
  it("says how long ago each conversation last moved", async () => {
    const bots = [bot("eli", [task("recent", { updatedAt: NOW - 5 * 60_000 }), task("older", { updatedAt: NOW - 3 * 60 * 60_000 })])];
    await mount(bots);
    const stamps = [...document.querySelectorAll<HTMLElement>("[data-finished-when]")];
    expect(stamps.map((stamp) => stamp.textContent)).toEqual([
      t("task.updated.minutes", { count: 5 }),
      t("task.updated.hours", { count: 3 }),
    ]);
    expect(stamps[0]!.getAttribute("dateTime")).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  it("marks the conversation the chat window has open, and only that one", async () => {
    const bots = [bot("eli", [task("open", { updatedAt: NOW }), task("elsewhere", { updatedAt: NOW - 60_000 })])];
    await mount(bots, [], { kind: "bot", botId: "eli", threadId: "open" });
    const rows = [...document.querySelectorAll<HTMLElement>("[data-inbox-finished] button")];
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(rows.map((row) => row.hasAttribute("data-open-thread"))).toEqual([true, false]);
    expect(rows[0]!.className.split(" ")).toContain("bg-raised");
  });
});
