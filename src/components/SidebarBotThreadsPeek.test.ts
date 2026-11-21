import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "@/state/store";
import { PEEK_LIMIT, peekPlace, peekThreads, SidebarBotThreadsPeek } from "./SidebarBotThreadsPeek";

const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...extra });
const bot = (tasks: Task[], threadId = "main") => ({ threadId, mainThreadId: "main", tasks: [task("main"), ...tasks] });

describe("peekThreads", () => {
  const ids = (listed: Task[]) => listed.map((entry) => entry.threadId);
  const four = [task("a", { updatedAt: 10 }), task("b", { updatedAt: 40 }), task("c", { updatedAt: 30 }), task("d", { updatedAt: 20 })];

  it("is only the main conversation for a bot with nothing else open", () => {
    expect(ids(peekThreads(bot([])))).toEqual(["main"]);
  });

  it("lists the main conversation first, then the newest open ones up to the limit", () => {
    const listed = peekThreads(bot([task("new", { updatedAt: 50 }), ...four]));
    expect(ids(listed)).toEqual(["main", "new", "b", "c"]);
    expect(listed).toHaveLength(PEEK_LIMIT + 1);
  });

  it("lists the main conversation first while another one is on screen", () => {
    expect(ids(peekThreads(bot([task("a", { updatedAt: 10 })], "a"), "a"))).toEqual(["main", "a"]);
  });

  it("keeps the conversation on screen when newer ones fill the limit", () => {
    expect(ids(peekThreads(bot(four, "a"), "a"))).toEqual(["main", "b", "c", "d", "a"]);
    expect(ids(peekThreads(bot(four, "a")))).toEqual(["main", "b", "c", "d"]);
  });

  it("leaves out routine runs, burst helpers and closed, archived or snoozed conversations", () => {
    const closed = [
      task("run", { routineRunId: "r1" }),
      task("burst", { openedBy: { botId: "x", name: "X", at: 1, burstId: "b1" } }),
      task("closed", { closedBy: { botId: "x", name: "X", at: 1 } }),
      task("archived", { archivedAt: 5 }),
      task("snoozed", { snoozedUntil: Date.now() + 60_000 }),
    ];
    expect(ids(peekThreads(bot([...closed, task("open")])))).toEqual(["main", "open"]);
  });

  it("leads with the conversation in view for a bot without a main one", () => {
    expect(ids(peekThreads({ threadId: "a", tasks: [task("a"), task("b")] }))).toEqual(["a", "b"]);
  });
});

describe("peekPlace", () => {
  const viewport = { width: 1440, height: 900 };

  it("sits beside the row, level with its top", () => {
    expect(peekPlace({ left: 8, right: 300, top: 200 }, 4, viewport, false)).toEqual({ left: 300, top: 200 });
  });

  it("stays inside the window near its bottom and right edges", () => {
    expect(peekPlace({ left: 8, right: 1400, top: 880 }, 4, viewport, false)).toEqual({ left: 1192, top: 748 });
  });

  it("opens on the other side in a right-to-left layout", () => {
    expect(peekPlace({ left: 1140, right: 1432, top: 200 }, 4, viewport, true)).toEqual({ left: 900, top: 200 });
  });
});

describe("SidebarBotThreadsPeek", () => {
  const render = (tasks: Task[]) => renderToStaticMarkup(createElement(SidebarBotThreadsPeek, { bot: { id: "atlas", name: "Atlas", ...bot(tasks) }, dispatch: () => {} }));

  it("offers only a new conversation for a bot with nothing else open", () => {
    const markup = render([]);
    expect(markup).toContain('data-bot-new-thread="atlas" aria-label="New thread"');
    expect(markup).not.toContain("aria-expanded");
  });

  it("discloses the other open conversations, closed until pressed", () => {
    const markup = render([task("a")]);
    expect(markup).toContain('data-bot-threads-peek="atlas" aria-haspopup="menu" aria-expanded="false" aria-label="Expand Atlas threads"');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain("data-bot-new-thread");
  });

  it("hides its control on phones and shows it without hover on other touch screens", () => {
    expect(render([])).toMatch(/class="[^"]*\bmax-md:hidden touch:pointer-events-auto touch:opacity-70\b/);
  });
});
