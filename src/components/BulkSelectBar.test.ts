import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/state/store";
import { BulkSelectBar, BulkSelectFilters, ThreadListFooter, deleteThreadsInBulk, useBulkSelect } from "./BulkSelectBar";
import { SidebarThreadRow } from "./SidebarThreadRow";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));

const rows = [
  { threadId: "a", title: "Old chat", pinned: true },
  { threadId: "b", title: "Other chat" },
];
const noop = vi.fn();

describe("select mode rows", () => {
  const row = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task: { threadId: "a", title: "Old chat", ...extra }, ownerId: "bot", current: false, locale: "en",
    onSelect: noop, onRename: noop, onDelete: noop, selectMode: true, checked: true, onToggleSelect: noop,
  }));
  it("renders a checkbox row without the actions menu", () => {
    const markup = row({});
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Select Old chat"');
    expect(markup).not.toContain("Actions for");
  });
  it("marks a running thread as disabled", () => {
    expect(row({ busy: true, activity: "working" })).toContain('aria-disabled="true"');
    expect(row({})).toContain('aria-disabled="false"');
  });
  it("keeps the normal row outside select mode", () => {
    const markup = renderToStaticMarkup(createElement(SidebarThreadRow, {
      task: { threadId: "a", title: "Old chat" }, ownerId: "bot", current: false, locale: "en",
      onSelect: noop, onRename: noop, onDelete: noop,
    }));
    expect(markup).not.toContain('role="checkbox"');
    expect(markup).toContain("Actions for");
  });
});

describe("select mode controls", () => {
  it("shows the quick filters and Done", () => {
    const markup = renderToStaticMarkup(createElement(BulkSelectFilters, { rows, selected: new Set<string>(), now: 0, onChange: noop, onDone: noop }));
    for (const label of ["Select all", "Older than 30 days", "Archived", "Clear", "Done"]) expect(markup).toContain(label);
  });
  it("disables Delete with nothing selected and shows the count", () => {
    const markup = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set<string>(), freshConversation: true, onChange: noop, onDelete: noop }));
    expect(markup).toContain("0 selected");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Delete 0</);
  });
  it("enables Delete for a selection and warns when a channel would lose every thread", () => {
    const ok = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set(["b"]), maxDeletable: 1, freshConversation: false, onChange: noop, onDelete: noop }));
    expect(ok).toContain("1 selected");
    expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete 1</);
    const over = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set(["a", "b"]), maxDeletable: 1, freshConversation: false, onChange: noop, onDelete: noop }));
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>Delete 2</);
    expect(over).toContain("A channel keeps at least one thread");
  });
});

describe("thread list footer", () => {
  const footer = (active: boolean, extra: Record<string, unknown>) => renderToStaticMarkup(createElement(ThreadListFooter, {
    bulk: { active, start: noop, finish: noop, forRows: () => new Set<string>(), setSelected: noop, toggle: noop } as ReturnType<typeof useBulkSelect>,
    rows, selected: new Set<string>(), total: 5, canShowAll: false, canSelect: false, onShowAll: noop, freshConversation: true, onDelete: noop, ...extra,
  }));
  it("offers Show all and Select threads outside select mode", () => {
    const markup = footer(false, { canShowAll: true, canSelect: true });
    expect(markup).toContain("Show all 5 threads");
    expect(markup).toContain("Select threads");
    expect(footer(false, {})).toBe("");
  });
  it("shows the delete bar in select mode", () => {
    expect(footer(true, {})).toContain("0 selected");
  });
});

describe("deleting in chunks", () => {
  it("posts each chunk to the owner's route and patches the owner after each", async () => {
    const post = vi.mocked(api);
    post.mockReset();
    post.mockResolvedValueOnce({ deleted: ["a"], refused: [], bot: { id: "bot" } });
    post.mockResolvedValueOnce({ deleted: ["b"], refused: [{ threadId: "c", reason: "busy" }], bot: { id: "bot" } });
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const dispatch = vi.fn();
    const result = await deleteThreadsInBulk({ botId: "bot" }, ids, dispatch);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toBe("/api/bots/bot/tasks/delete");
    expect(JSON.parse(String(post.mock.calls[1]![1]!.body)).threadIds).toHaveLength(50);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["botPatched", "botPatched"]);
    expect(result).toEqual({ responses: [{ deleted: ["a"], refused: [], bot: { id: "bot" } }, { deleted: ["b"], refused: [{ threadId: "c", reason: "busy" }], bot: { id: "bot" } }] });
  });
  it("stops at a failed chunk and reports what already went", async () => {
    const post = vi.mocked(api);
    post.mockReset();
    post.mockResolvedValueOnce({ deleted: ["a"], refused: [], group: { id: "room" } });
    post.mockRejectedValueOnce(new Error("offline"));
    const dispatch = vi.fn();
    const result = await deleteThreadsInBulk({ groupId: "room" }, Array.from({ length: 450 }, (_, i) => `t${i}`), dispatch);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toBe("/api/groups/room/tasks/delete");
    expect(result.error).toBe("offline");
    expect(result.responses).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "error", message: "offline" });
  });
});
