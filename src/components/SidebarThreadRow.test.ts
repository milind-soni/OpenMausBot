import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUpdatedAt, nextSnoozeExpiry, orderedSidebarThreads, orderedThreadList, SidebarThreadRow, threadByline, threadOpenerLabel, visibleSidebarThreads } from "./SidebarThreadRow";

// The More menu lives behind component state and a portal, which a static
// render never reaches. SidebarThreadRow uses exactly useState, useRef and
// useEffect; stubbing those three (initial values first, state kept across a
// re-render) lets this suite render the row directly, click the real action
// button, and see the menu the click opened — the same extract-and-call
// approach the ThreadRefs tests use for onClick props.
const rowHooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  const begin = (fresh: boolean) => {
    cursor = 0;
    if (fresh) slots.length = 0;
  };
  const useState = (initial: unknown): [unknown, (value: unknown) => void] => {
    const index = cursor++;
    if (index >= slots.length) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const setValue = (value: unknown) => {
      slots[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(slots[index]) : value;
    };
    return [slots[index], setValue];
  };
  return { begin, useState };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: rowHooks.useState as unknown as typeof actual.useState,
    useRef: ((initial: unknown) => ({ current: initial })) as unknown as typeof actual.useRef,
    useEffect: (() => undefined) as unknown as typeof actual.useEffect,
  };
});

beforeEach(() => rowHooks.begin(true));

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
      ownerId: "scout",
      current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
    }));
    expect(render()).toContain("Next job · Queued");
    expect(render(true)).toContain("Next job · Working");
    expect(render(true)).not.toContain("Queued");
    expect(render(true, "waiting-on-you")).toContain("Next job · Waiting");
    expect(render(true, "waiting-on-you")).not.toContain("Queued");
  });
});

describe("threads waiting on a teammate", () => {
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"], props: Partial<Parameters<typeof SidebarThreadRow>[0]> = {}) =>
    renderToStaticMarkup(createElement(SidebarThreadRow, {
      task, ownerId: "scout", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), ...props,
    }));
  // #1223: the parent thread dispatched a teammate and its own turn is done.
  it("shows the wait as a quiet label over the busy paint, never the work spinner", () => {
    const markup = render({ threadId: "dispatch", title: "Dispatch", waitingForTeammates: true, busy: true, activity: "working" });
    expect(markup).toContain('title="Dispatch · Waiting on teammate"');
    expect(markup).toContain('aria-label="Waiting on teammate"');
    expect(markup).not.toContain("animate-spin");
  });
  it("keeps an older waiting thread visible past the six recent rows", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ threadId: String(index), title: `Thread ${index}` }));
    const waiting = [...rows, { threadId: "dispatch", title: "Dispatch", waitingForTeammates: true as const, busy: false }];
    expect(visibleSidebarThreads(waiting, "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "dispatch"]);
  });
  it("surfaces the live activity label the chat pane derives while the row works", () => {
    const markup = render({ threadId: "live", title: "Live work", busy: true, activity: "working" }, { activityLabel: "Reading a file" });
    expect(markup).toContain('title="Live work · Reading a file"');
    expect(markup).toContain('aria-label="Reading a file"');
  });
});

describe("threads a bot opened", () => {
  const openedBy = { botId: "scout", name: "Scout", at: 5 };
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"]) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task, ownerId: "scout", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
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

describe("snoozed threads", () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({ threadId: String(index), title: `Thread ${index}` }));
  it("never strands an approval: a snoozed thread that is waiting on the person stays visible", () => {
    const snoozed = [...rows, { threadId: "approval", title: "Approve deploy", snoozedUntil: 0, activity: "waiting-on-you" as const, busy: false }];
    expect(visibleSidebarThreads(snoozed, "0").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "approval"]);
  });
  it("folds an idle snoozed thread out of the default list while show-all and search still list it", () => {
    const withSnoozed = [{ ...rows[0], snoozedUntil: Date.now() + 3_600_000 }, ...rows.slice(1)];
    expect(visibleSidebarThreads(withSnoozed, "8").map((task) => task.threadId)).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
    expect(visibleSidebarThreads(withSnoozed, "8", "", [], true)).toEqual(withSnoozed);
    expect(visibleSidebarThreads(withSnoozed, "8", "thread 0").map((task) => task.threadId)).toEqual(["0"]);
  });
  it("treats snoozedUntil: 0 as snoozed — presence, not truthiness — and says so in the byline", () => {
    const sentinel = [{ ...rows[0], snoozedUntil: 0 }, ...rows.slice(1)];
    expect(visibleSidebarThreads(sentinel, "8").map((task) => task.threadId)).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
    expect(threadByline({ snoozedUntil: 0 })).toBe("Snoozed");
    expect(threadByline({ archivedAt: 5, snoozedUntil: 0 })).toBe("Archived");
    expect(threadByline({})).toBeNull();
  });
  it("wakes a timed snooze once its moment passes, without waiting for a fresh snapshot", () => {
    const now = Date.now();
    const expired = [{ ...rows[0], snoozedUntil: now - 1 }, ...rows.slice(1)];
    expect(visibleSidebarThreads(expired, "8").map((task) => task.threadId)).toEqual(["0", "1", "2", "3", "4", "5", "8"]);
    expect(threadByline({ snoozedUntil: now - 1 })).toBeNull();
    expect(visibleSidebarThreads([{ ...rows[0], snoozedUntil: now + 3_600_000 }, ...rows.slice(1)], "8").map((task) => task.threadId)).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
  });
  it("schedules the next wake at the soonest future timed snooze, skipping the sentinel and the past", () => {
    const now = Date.now();
    expect(nextSnoozeExpiry([{ snoozedUntil: 0 }, { snoozedUntil: now - 1 }, { snoozedUntil: now + 3_600_000 }, { snoozedUntil: now + 60_000 }, {}], now)).toBe(now + 60_000);
    expect(nextSnoozeExpiry([{ snoozedUntil: 0 }, { snoozedUntil: now - 1 }], now)).toBeUndefined();
  });
});

describe("threads a bot opened", () => {
  const openedBy = { botId: "scout", name: "Scout", at: 5 };
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"]) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task, ownerId: "scout", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
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
    task, ownerId: "pm", current, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
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

describe("formatUpdatedAt", () => {
  it("uses the runtime locale and timezone, and skips a missing stamp", () => {
    const at = Date.UTC(2026, 0, 15, 0, 30);
    expect(formatUpdatedAt(at)).toBe(new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }));
    expect(formatUpdatedAt(0)).toBe("");
    expect(formatUpdatedAt(Number.NaN)).toBe("");
    const markup = renderToStaticMarkup(createElement(SidebarThreadRow, {
      task: { threadId: "t", title: "Notes", updatedAt: at },
      ownerId: "b", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
    }));
    expect(markup).toContain(formatUpdatedAt(at));
    expect(markup).toContain(new Date(at).toISOString());
  });
});

describe("orderedThreadList", () => {
  const task = (threadId: string, over: Record<string, unknown> = {}) => ({
    threadId,
    title: threadId,
    createdAt: 1,
    ...over,
  });

  it("pins first, then newest update, and keeps equal stamps in stored order", () => {
    const ordered = orderedThreadList([
      task("old", { updatedAt: 10 }),
      task("pinned-old", { pinned: true, updatedAt: 5 }),
      task("new", { updatedAt: 30 }),
      task("pinned-new", { pinned: true, updatedAt: 20 }),
      task("tie-b", { updatedAt: 10 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["pinned-new", "pinned-old", "new", "old", "tie-b"]);
  });

  it("does not let waiting or working outrank a newer idle thread", () => {
    const ordered = orderedThreadList([
      task("waiting", { updatedAt: 1, activity: "waiting-on-you" }),
      task("fresh", { updatedAt: 5 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["fresh", "waiting"]);
  });

  it("uses createdAt when the thread has never been updated", () => {
    const ordered = orderedThreadList([
      task("created-early", { createdAt: 1 }),
      task("created-late", { createdAt: 4 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["created-late", "created-early"]);
  });
});

describe("orderedSidebarThreads", () => {
  const task = (threadId: string, over: Record<string, unknown> = {}) => ({
    threadId,
    title: threadId,
    busy: false,
    ...over,
  });

  it("floats attention tiers above idle threads and keeps idle stored order", () => {
    const ordered = orderedSidebarThreads([
      task("idle-a"),
      task("unread", { unread: true }),
      task("idle-b"),
      task("working", { busy: true }),
      task("idle-c"),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["working", "unread", "idle-a", "idle-b", "idle-c"]);
  });

  it("ranks waiting-on-you above working, and queued above unread", () => {
    const ordered = orderedSidebarThreads([
      task("unread", { unread: true }),
      task("queued", { queued: true }),
      task("working", { activity: "working" }),
      task("waiting", { activity: "waiting-on-you" }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["waiting", "working", "queued", "unread"]);
  });

  it("keeps a teammate wait between working and queued even over the busy paint", () => {
    const ordered = orderedSidebarThreads([
      task("queued", { queued: true }),
      task("wait", { busy: true, activity: "working", waitingForTeammates: true }),
      task("work", { busy: true, activity: "working" }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["work", "wait", "queued"]);
  });

  it("keeps the thread being looked at above idle threads but below attention tiers", () => {
    const ordered = orderedSidebarThreads([
      task("idle"),
      task("active"),
      task("waiting", { activity: "waiting-on-you" }),
    ], "active");
    expect(ordered.map((t) => t.threadId)).toEqual(["waiting", "active", "idle"]);
  });

  it("is stable within a tier", () => {
    const ordered = orderedSidebarThreads([
      task("unread-b", { unread: true }),
      task("unread-a", { unread: true }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["unread-b", "unread-a"]);
  });
});

describe("archived threads", () => {
  const render = (task: Parameters<typeof SidebarThreadRow>[0]["task"]) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task, ownerId: "scout", current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
  }));
  it("keeps the six newest open threads, and does not spend those slots on a pin", () => {
    const rows = [
      { threadId: "old-open", title: "Old", createdAt: 1, updatedAt: 1 },
      { threadId: "newer", title: "Newer", createdAt: 2, updatedAt: 50 },
      { threadId: "mid", title: "Mid", createdAt: 3, updatedAt: 40 },
      { threadId: "also", title: "Also", createdAt: 4, updatedAt: 30 },
      { threadId: "fourth", title: "Fourth", createdAt: 5, updatedAt: 20 },
      { threadId: "fifth", title: "Fifth", createdAt: 6, updatedAt: 15 },
      { threadId: "sixth", title: "Sixth", createdAt: 7, updatedAt: 12 },
      { threadId: "pinned-closed", title: "Pinned", createdAt: 8, updatedAt: 2, pinned: true, closedBy: { botId: "b", name: "Scout", at: 2 } },
    ];
    expect(visibleSidebarThreads(rows, "none").map((task) => task.threadId)).toEqual([
      "pinned-closed", "newer", "mid", "also", "fourth", "fifth", "sixth",
    ]);
  });
  it("folds archived threads out of the default list, but never when they need the person", () => {
    const rows = [
      { threadId: "0", title: "Current work" },
      { threadId: "1", title: "Put away", archivedAt: 5 },
      { threadId: "2", title: "Needs you", archivedAt: 5, activity: "waiting-on-you" as const, busy: false },
    ];
    expect(visibleSidebarThreads(rows, "0").map((task) => task.threadId)).toEqual(["0", "2"]);
    expect(visibleSidebarThreads(rows, "0", "", [], true).map((task) => task.threadId)).toEqual(["0", "1", "2"]);
    expect(visibleSidebarThreads(rows, "0", "put away").map((task) => task.threadId)).toEqual(["1"]);
  });
  it("says Archived under the title and dims the row, behind any live status", () => {
    expect(threadByline({ archivedAt: 5 })).toBe("Archived");
    expect(threadByline({ openedBy: { botId: "scout", name: "Scout", at: 1 }, archivedAt: 5 })).toBe("Archived");
    expect(threadByline({ openedBy: { botId: "scout", name: "Scout", at: 1 } })).toBe("opened by Scout");
    expect(threadByline({ openedBy: { botId: "scout", name: "Scout", at: 1 }, archivedAt: 5, closedBy: { botId: "pm", name: "Parker", at: 2 } })).toBe("closed by Parker");
    const markup = render({ threadId: "1", title: "Put away", archivedAt: 5 });
    expect(markup).toContain("Archived");
    expect(markup).toContain("text-ink-secondary/70");
    expect(render({ threadId: "1", title: "Put away", archivedAt: 5, busy: true })).toContain('title="Put away · Working · Archived"');
  });
  it("treats archivedAt: 0 as archived, because zero is a valid timestamp at the API boundary", () => {
    const rows = [
      { threadId: "0", title: "Current work" },
      { threadId: "1", title: "Put away", archivedAt: 0 },
    ];
    expect(visibleSidebarThreads(rows, "0").map((task) => task.threadId)).toEqual(["0"]);
    expect(threadByline({ archivedAt: 0 })).toBe("Archived");
    expect(render({ threadId: "1", title: "Put away", archivedAt: 0 })).toContain("Archived");
  });
});

describe("Copy link", () => {
  type RowTask = Parameters<typeof SidebarThreadRow>[0]["task"];
  type RowProps = { children?: unknown; [key: string]: unknown };
  type RowNode = { $$typeof?: unknown; type?: unknown; props?: RowProps; children?: unknown };

  const renderRow = (task: RowTask, ownerId: string, fresh = true): RowNode => {
    rowHooks.begin(fresh);
    return SidebarThreadRow({ task, ownerId, current: false, onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() }) as RowNode;
  };

  const walk = (node: unknown, visit: (element: RowNode) => void): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, visit));
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as RowNode;
    if (element.$$typeof !== undefined || element.type !== undefined) visit(element);
    walk(element.props?.children ?? element.children, visit);
  };

  const textOf = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (!node || typeof node !== "object") return "";
    const element = node as RowNode;
    return textOf(element.props?.children ?? element.children);
  };

  const buttonWithLabel = (tree: RowNode, label: string) => {
    let found: RowNode | undefined;
    walk(tree, (element) => {
      if (!found && element.type === "button" && textOf(element).includes(label)) found = element;
    });
    return found;
  };

  const moreMenuButton = (tree: RowNode) => {
    let found: RowNode | undefined;
    walk(tree, (element) => {
      if (!found && element.props && "aria-expanded" in element.props) found = element;
    });
    return found;
  };

  it("writes the exact canonical link for the row's owner to the clipboard", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
    vi.stubGlobal("document", { body: { nodeType: 1 } });
    // a bot-owned row and a room-owned row: the owner id, not anything else,
    // is what the copied link must carry as ?bot=
    const rows = [
      { task: { threadId: "qa-245", title: "QA PR 245" }, ownerId: "scout", link: "openmausbot://thread/qa-245?bot=scout" },
      { task: { threadId: "monday-1", title: "Monday plan" }, ownerId: "standup", link: "openmausbot://thread/monday-1?bot=standup" },
    ];
    for (const { task, ownerId, link } of rows) {
      const closed = renderRow(task, ownerId);
      expect(buttonWithLabel(closed, "Copy link")).toBeUndefined();
      const more = moreMenuButton(closed);
      expect(more?.props).toBeDefined();
      const openMenu = more!.props!.onClick as (event: unknown) => void;
      openMenu({ currentTarget: { getBoundingClientRect: () => ({ left: 100, bottom: 200 }) } });
      const menu = renderRow(task, ownerId, false);
      const copy = buttonWithLabel(menu, "Copy link");
      expect(copy).toBeDefined();
      expect(textOf(copy)).toContain("Copy link");
      (copy!.props!.onClick as () => void)();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(link);
      writeText.mockClear();
    }
    vi.unstubAllGlobals();
  });
});
