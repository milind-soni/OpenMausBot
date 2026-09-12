import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarThreadRow, threadByline, threadOpenerLabel, visibleSidebarThreads } from "./SidebarThreadRow";

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

describe("threads a bot closed", () => {
  const openedBy = { botId: "pm", name: "Parker", at: 5 };
  const closedBy = { botId: "pm", name: "Parker", at: 9 };
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"], current = false) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task, current, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
  }));
  it("folds closed threads out of the default list without spending the six recent rows on them", () => {
    // newest first: three helper threads the PM opened and closed sit on top of the person's own
    const helpers = Array.from({ length: 3 }, (_, index) => ({ threadId: `h${index}`, title: `Helper ${index}`, openedBy, closedBy }));
    const own = Array.from({ length: 8 }, (_, index) => ({ threadId: String(index), title: `Thread ${index}` }));
    expect(visibleSidebarThreads([...helpers, ...own], "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5"]);
    // show all and search still list them — closing is never a deletion
    expect(visibleSidebarThreads([...helpers, ...own], "0", "", [], true)).toHaveLength(11);
    expect(visibleSidebarThreads([...helpers, ...own], "0", "helper 1").map((task) => task.threadId)).toEqual(["h1"]);
  });
  it("keeps a closed thread on screen while the person is in it or it has something new", () => {
    const rows = [
      { threadId: "current", title: "Reading it", closedBy },
      { threadId: "unread", title: "Answered again", closedBy, unread: true },
      { threadId: "busy", title: "Picked back up", closedBy, busy: true },
      { threadId: "quiet", title: "Done", closedBy },
    ];
    expect(visibleSidebarThreads(rows, "current").map((task) => task.threadId)).toEqual(["current", "unread", "busy"]);
  });
  it("says who closed it under the title, dims the row, and says Closed in the tooltip", () => {
    expect(threadByline({ openedBy, closedBy: { ...closedBy, name: "Scout" } })).toBe("closed by Scout");
    expect(threadByline({ openedBy })).toBe("opened by Parker");
    expect(threadByline({})).toBeNull();
    const markup = render({ threadId: "h", title: "Helper 1", openedBy, closedBy });
    expect(markup).toContain("closed by Parker");
    expect(markup).not.toContain("opened by");
    expect(markup).toContain('title="Helper 1 · Closed"');
    expect(markup).toContain("text-ink-secondary/70");
    // a live status outranks the closed note; the selected row is not dimmed
    expect(render({ threadId: "h", title: "Helper 1", closedBy, busy: true })).toContain('title="Helper 1 · Working"');
    expect(render({ threadId: "h", title: "Helper 1", closedBy }, true)).not.toContain("text-ink-secondary/70");
  });
});
