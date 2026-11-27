// @vitest-environment happy-dom
// Live bot tasks: a `bot-task` frame reloads the open list, and the open task only when it is the one that changed.
// Nothing polls: without a frame nothing is fetched again.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTask, BotTaskSummary } from "../../../shared/bot-tasks";
import { announceBotTask } from "@/lib/bot-task-events";
import { botTasksStatus } from "@/lib/bot-tasks";
import { setLocale } from "@/lib/i18n";
import { BotTaskDetail } from "./BotTaskDetail";
import { BotTasksView } from "./BotTasksPage";

const summary = (id: string, title: string): BotTaskSummary => ({
  id, title, status: "open", ownerBotId: "b1", ownerName: "Lin", createdBy: { kind: "system" }, createdAt: 1, updatedAt: 2, activityCount: 0,
} as BotTaskSummary);

let host: HTMLDivElement;
let root: Root;
let listed: BotTaskSummary[];
let title: string;
const fetched: string[] = [];
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));

beforeEach(() => {
  setLocale("en");
  localStorage.setItem("omb.botTasks.view", "list");
  fetched.length = 0;
  listed = [summary("t1", "Fix login")];
  title = "Fix login";
  vi.stubGlobal("fetch", (input: string) => {
    const path = String(input);
    fetched.push(path);
    if (path.startsWith("/api/bot-tasks/")) return json({ task: { ...summary("t1", title), activity: [] } as unknown as BotTask, ownerName: "Lin" });
    return json({ enabled: true, tasks: listed });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
  vi.unstubAllGlobals();
});

const settings = botTasksStatus({ botTasks: { ...botTasksStatus(null), enabled: true } });

describe("live bot tasks", () => {
  it("reloads the open list when any task changes", async () => {
    flushSync(() => root.render(createElement(BotTasksView, { settings, bots: [], onOpenSettings: () => {}, openId: null, onOpen: () => {} })));
    await settle();
    expect(host.querySelectorAll("[data-bot-task-row]")).toHaveLength(1);
    const before = fetched.length;
    await settle();
    expect(fetched.length, "no polling").toBe(before);

    listed = [summary("t1", "Fix login"), summary("t2", "Write notes")];
    announceBotTask("t2");
    await settle();
    expect([...host.querySelectorAll<HTMLElement>("[data-bot-task-row]")].map((row) => row.dataset.botTaskRow)).toEqual(["t1", "t2"]);
  });

  it("submits the same link and head that were held by the merge confirmation", async () => {
    let number = 5;
    const sha = "a".repeat(40);
    const posted = vi.fn();
    const task = () => ({ ...summary("t1", title), github: { repo: "org/repo", number, kind: "pull" }, activity: [] });
    vi.stubGlobal("fetch", (input: string, { body }: RequestInit = {}) => {
      const path = String(input);
      if (path.includes("/merge-head?")) return json({ sha });
      if (path.endsWith("/post")) {
        posted(JSON.parse(String(body)));
        return json({ url: "https://github.com/org/repo/pull/5#issuecomment-1", task: task() });
      }
      return json({ task: task(), ownerName: "Lin" });
    });
    const enabled = { ...settings, githubSync: true, allowOutboundComments: true, allowMerge: true };
    flushSync(() => root.render(createElement(BotTaskDetail, { id: "t1", settings: enabled, botName: (id: string) => id, onChanged: () => {} })));
    await settle();
    host.querySelector<HTMLButtonElement>("[data-bot-task-compose]")!.click();
    await settle();
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, "Confirmed comment");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>("[data-bot-task-post-send]")!.click();
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("org/repo#5");
    expect(dialog.querySelector("code")?.textContent).toBe(sha.slice(0, 12));
    number = 6;
    announceBotTask("t1");
    await settle();
    expect(dialog.textContent).toContain("org/repo#5");
    [...dialog.querySelectorAll("button")].at(-1)!.click();
    await settle();
    expect(posted).toHaveBeenCalledExactlyOnceWith({
      text: "Confirmed comment", expectedRef: { repo: "org/repo", number: 5 }, merge: true, sha,
    });
  });

  it("reloads the open task only for its own id", async () => {
    flushSync(() => root.render(createElement(BotTaskDetail, { id: "t1", settings, botName: (id: string) => id, onChanged: () => {} })));
    await settle();
    expect(host.textContent).toContain("Fix login");
    const before = fetched.length;

    title = "Fix login redirect";
    announceBotTask("t9");
    await settle();
    expect(fetched.length, "another task changing fetches nothing").toBe(before);
    expect(host.textContent).not.toContain("Fix login redirect");

    announceBotTask("t1");
    await settle();
    expect(fetched.slice(before)).toEqual(["/api/bot-tasks/t1"]);
    expect(host.textContent).toContain("Fix login redirect");
  });
});
