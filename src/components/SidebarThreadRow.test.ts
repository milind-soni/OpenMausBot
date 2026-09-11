import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarThreadRow, threadOpenerLabel, visibleSidebarThreads } from "./SidebarThreadRow";

describe("sidebar thread visibility", () => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({ threadId: String(index), title: `Thread ${index}`, ...(index > 7 ? { projectId: "research" } : {}) }));
  it("keeps the active and attention-needed threads visible beyond the six recent rows", () => {
    const rows = tasks.map((task) => ({ ...task, busy: task.threadId === "7", unread: task.threadId === "9" }));
    expect(visibleSidebarThreads(rows, "8").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "7", "8", "9"]);
    expect(visibleSidebarThreads(rows, "8", "", [], true)).toEqual(rows);
  });
  it("searches folder names and historical thread titles without the recent-row limit", () => {
    expect(visibleSidebarThreads(tasks, "0", " RESEARCH ", [{ id: "research", name: "Research" }]).map((task) => task.threadId)).toEqual(["8", "9"]);
    expect(visibleSidebarThreads(tasks, "0", "thread 9").map((task) => task.threadId)).toEqual(["9"]);
    expect(visibleSidebarThreads(tasks, "0", "missing")).toEqual([]);
  });
  it("keeps queued older threads visible", () => {
    const rows = tasks.map((task) => ({ ...task, queued: task.threadId === "9" }));
    expect(visibleSidebarThreads(rows, "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "9"]);
  });
  it("never hides an older approval just because its busy flag is false", () => {
    const rows = tasks.map((task) => ({ ...task, busy: false, activity: task.threadId === "9" ? "waiting-on-you" as const : "idle" as const }));
    expect(visibleSidebarThreads(rows, "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "9"]);
  });
  it("shows Queued only for idle threads, preserving Working and Waiting", () => {
    const render = (busy = false, activity?: "waiting-on-you") => renderToStaticMarkup(createElement(SidebarThreadRow, {
      task: { threadId: "queued", title: "Next job", queued: true, busy, activity },
      current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
    }));
    expect(render()).toContain("Next job · Queued");
    expect(render(true)).toContain("Next job · Working");
    expect(render(true)).not.toContain("Queued");
    expect(render(true, "waiting-on-you")).toContain("Next job · Waiting");
    expect(render(true, "waiting-on-you")).not.toContain("Queued");
  });
});

describe("threads a bot opened", () => {
  const openedBy = { botId: "scout", name: "Scout", at: 5 };
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"]) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task, current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
  }));
  it("says who opened the thread in plain words, and nothing for the person's own", () => {
    expect(threadOpenerLabel({ openedBy })).toBe("opened by Scout");
    expect(threadOpenerLabel({})).toBeNull();
    expect(threadOpenerLabel({ openedBy: { ...openedBy, name: "  " } })).toBeNull();
  });
  it("shows the opener quietly under the title without changing the row's name or status", () => {
    const markup = render({ threadId: "qa", title: "QA PR 245", openedBy, activity: "waiting-on-you" });
    expect(markup).toContain("opened by Scout");
    expect(markup).toContain('title="QA PR 245 · Waiting"');
    expect(markup.indexOf("QA PR 245")).toBeLessThan(markup.indexOf("opened by Scout"));
    expect(render({ threadId: "own", title: "Quick question" })).not.toContain("opened by");
  });
  it("gives a bot-opened thread the same waiting and unread signals as any other", () => {
    const waiting = render({ threadId: "qa", title: "QA PR 245", openedBy, activity: "waiting-on-you", unread: true });
    expect(waiting).toContain('title="QA PR 245 · Waiting · Unread"');
    expect(waiting).toContain(">Waiting</span>");
    expect(waiting).toContain('aria-label="Unread"');
    expect(waiting).toContain("opened by Scout");
    // and it stays on screen past the six recent rows, exactly like a thread the person opened
    const rows = Array.from({ length: 9 }, (_, index) => ({ threadId: String(index), title: `Thread ${index}` }));
    const opened = [...rows, { threadId: "qa", title: "QA PR 245", openedBy, activity: "waiting-on-you" as const, busy: false }];
    expect(visibleSidebarThreads(opened, "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "qa"]);
  });
});
