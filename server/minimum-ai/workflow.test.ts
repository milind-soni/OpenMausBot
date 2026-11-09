import { describe, expect, it, vi } from "vitest";
import { executeWorkflow, parseWorkflow } from "./workflow.ts";

const cleanup = {
  version: 1,
  steps: [
    { kind: "call", id: "search", tool: "NOTION_QUERY", input: { database: "demo-tasks" } },
    { kind: "each", id: "matching", from: "search.rows", where: { path: "item.group", equals: "Trash" }, steps: [
      { kind: "call", id: "move", tool: "NOTION_TRASH", input: { page: { $ref: "item.id" } } },
    ] },
  ],
};
const report = { version: 1, steps: [
  { kind: "call", id: "inbox", tool: "MAIL_LIST", input: {} },
  { kind: "each", id: "unread", from: "inbox.messages", where: { path: "item.unread", equals: true }, steps: [
    { kind: "call", id: "record", tool: "REPORT_ITEM", input: { subject: { $ref: "item.subject" } } },
  ] },
] };

describe("minimum AI workflow runner", () => {
  it("filters fresh browser targets by a literal prefix without acting on other items", async () => {
    const plan = parseWorkflow({ version: 1, steps: [
      { kind: "call", id: "list", tool: "BROWSER_LIST", input: {} },
      { kind: "each", id: "matching", from: "list.items", where: { path: "item.name", startsWith: "Delete trash: " }, steps: [{ kind: "call", id: "delete", tool: "BROWSER_CLICK", input: { name: { $ref: "item.name" } } }] },
    ] });
    const invoke = vi.fn(async (tool: string, _input: Record<string, unknown>) => tool === "BROWSER_LIST" ? { items: [{ name: "Delete trash: Alpha" }, { name: "Keep Beta" }, { name: "Delete trash: Gamma" }] } : { ok: true });
    expect((await executeWorkflow(plan, invoke)).status).toBe("completed");
    expect(invoke.mock.calls.slice(1).map(([, input]) => input)).toEqual([{ name: "Delete trash: Alpha" }, { name: "Delete trash: Gamma" }]);
    const badType = vi.fn(async (tool: string) => tool === "BROWSER_LIST" ? { items: [{ name: 42 }] } : { ok: true });
    expect(await executeWorkflow(plan, badType)).toMatchObject({ status: "failed" });
    expect(badType).toHaveBeenCalledOnce();
    expect(() => parseWorkflow({ version: 1, steps: [{ kind: "each", id: "all", from: "x.items", where: { path: "item.name", startsWith: "" }, steps: [{ kind: "call", id: "delete", tool: "BROWSER_CLICK", input: {} }] }] })).toThrow();
  });
  it("reuses logic with fresh results, filtering and iterating without AI", async () => {
    const calls: Array<[string, unknown]> = [];
    const invoke = vi.fn(async (tool: string, input: unknown) => {
      calls.push([tool, input]);
      if (tool === "NOTION_QUERY") return { rows: [{ id: "alpha", group: "Trash" }, { id: "beta", group: "Inbox" }, { id: "gamma", group: "Trash" }] };
      return { ok: true };
    });
    const result = await executeWorkflow(parseWorkflow(cleanup), invoke);
    expect(result.status).toBe("completed");
    expect(calls).toEqual([["NOTION_QUERY", { database: "demo-tasks" }], ["NOTION_TRASH", { page: "alpha" }], ["NOTION_TRASH", { page: "gamma" }]]);
  });
  it("handles an empty result and a different tool family", async () => {
    const invoke = vi.fn(async (tool: string) => tool === "NOTION_QUERY" ? { rows: [] } : { messages: [{ subject: "A", unread: true }, { subject: "B", unread: false }] });
    expect(await executeWorkflow(parseWorkflow(cleanup), invoke)).toMatchObject({ status: "completed", unexercised: ["move"] });
    expect(invoke).toHaveBeenCalledTimes(1);
    const other = vi.fn(async (tool: string) => tool === "MAIL_LIST" ? { messages: [{ subject: "A", unread: true }, { subject: "B", unread: false }] } : { ok: true });
    expect((await executeWorkflow(parseWorkflow(report), other)).status).toBe("completed");
    expect(other).toHaveBeenCalledWith("REPORT_ITEM", { subject: "A" }, expect.anything());
    expect(other).toHaveBeenCalledTimes(2);
  });
  it("stops at the first failure and reports partial completion", async () => {
    const invoke = vi.fn(async (tool: string, input: unknown) => {
      if (tool === "NOTION_QUERY") return { rows: [{ id: "alpha", group: "Trash" }, { id: "gamma", group: "Trash" }, { id: "delta", group: "Trash" }] };
      if ((input as {page?: string}).page === "gamma") throw new Error("connection unavailable");
      return { ok: true };
    });
    const result = await executeWorkflow(parseWorkflow(cleanup), invoke);
    expect(result.status).toBe("failed");
    expect(result.completed).toEqual(["search", "move"]);
    expect(result.failedStep).toBe("move");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("fails closed for unapproved, malformed and excessive workflows", async () => {
    expect(() => parseWorkflow({ version: 1, steps: [{ kind: "shell", command: "anything" }] })).toThrow();
    expect(() => parseWorkflow({ ...cleanup, version: 2 })).toThrow();
    const invoke = vi.fn(async () => ({ rows: Array.from({ length: 501 }, () => ({ group: "Trash", id: "x" })) }));
    const result = await executeWorkflow(parseWorkflow(cleanup), invoke);
    expect(result.status).toBe("failed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("pagination and safety", () => {
  it("runs only the matching branch, including an otherwise branch", async () => {
    const plan = parseWorkflow({ version: 1, steps: [
      { kind: "call", id: "check", tool: "MAIL_LIST", input: {} },
      { kind: "if", id: "condition", where: { path: "check.empty", equals: true }, steps: [{ kind: "call", id: "empty", tool: "REPORT_EMPTY", input: {} }], otherwise: [{ kind: "call", id: "found", tool: "REPORT_FOUND", input: {} }] },
    ] });
    const invoke = vi.fn(async (tool: string) => tool === "MAIL_LIST" ? { empty: false } : {});
    expect((await executeWorkflow(plan, invoke)).status).toBe("completed");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["MAIL_LIST", "REPORT_FOUND"]);
  });
  it("stops on a changed condition value type rather than taking the wrong branch", async () => {
    const plan = parseWorkflow({ version: 1, steps: [
      { kind: "call", id: "check", tool: "MAIL_LIST", input: {} },
      { kind: "if", id: "condition", where: { path: "check.empty", equals: true }, steps: [{ kind: "call", id: "empty", tool: "REPORT_EMPTY", input: {} }], otherwise: [{ kind: "call", id: "found", tool: "REPORT_FOUND", input: {} }] },
    ] });
    const invoke = vi.fn(async () => ({ empty: "false" }));
    expect(await executeWorkflow(plan, invoke)).toMatchObject({ status: "failed", failedStep: "condition" });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("returns requested dynamic data as the run output", async () => {
    const plan = parseWorkflow({ version: 1, steps: [{ kind: "call", id: "inbox", tool: "MAIL_LIST", input: {} }], output: { $ref: "inbox.messages" } });
    const result = await executeWorkflow(plan, async () => ({ messages: [{ subject: "Sample" }] }));
    expect(result).toMatchObject({ status: "completed", output: [{ subject: "Sample" }] });
  });
  it("treats an omitted final pagination cursor as the last page", async () => {
    const plan = parseWorkflow({ version: 1, steps: [{ kind: "call", id: "search", tool: "MAIL_LIST", input: {}, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", maxPages: 3 } }] });
    const invoke = vi.fn(async () => ({ rows: [] }));
    expect((await executeWorkflow(plan, invoke)).status).toBe("completed");
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("stops before writes when a page claims more results but omits its cursor", async () => {
    const plan = parseWorkflow({ version: 1, steps: [
      { kind: "call", id: "search", tool: "MAIL_LIST", input: {}, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", hasMorePath: "has_more", maxPages: 3 } },
      { kind: "call", id: "write", tool: "MAIL_DELETE", input: {} },
    ] });
    const invoke = vi.fn(async () => ({ rows: [], has_more: true }));
    expect(await executeWorkflow(plan, invoke)).toMatchObject({ status: "failed", failedStep: "search" });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("reports the final pagination state after merging pages", async () => {
    const plan = parseWorkflow({ version: 1, steps: [{ kind: "call", id: "search", tool: "MAIL_LIST", input: {}, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", hasMorePath: "has_more", maxPages: 3 } }], output: { $ref: "search" } });
    const result = await executeWorkflow(plan, async (_tool, input) => input.cursor ? { rows: ["b"], has_more: false } : { rows: ["a"], has_more: true, next: "second" });
    expect(result.output).toEqual({ rows: ["a", "b"], has_more: false, next: null });
  });
  it("fetches every page and applies iteration to all current records", async () => {
    const paged = { version: 1, steps: [
      { kind: "call", id: "search", tool: "NOTION_QUERY", input: { database: "demo" }, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", maxPages: 3 } },
      { kind: "each", id: "matches", from: "search.rows", where: { path: "item.group", equals: "Trash" }, steps: [{ kind: "call", id: "move", tool: "NOTION_TRASH", input: { page: { $ref: "item.id" } } }] },
    ] };
    const invoke = vi.fn(async (tool: string, input: Record<string, unknown>) => {
      if (tool === "NOTION_QUERY") return input.cursor ? { rows: [{ id: "b", group: "Trash" }], next: null } : { rows: [{ id: "a", group: "Trash" }], next: "page-2" };
      return { ok: true };
    });
    expect((await executeWorkflow(parseWorkflow(paged), invoke)).status).toBe("completed");
    expect(invoke.mock.calls.map(([tool]) => tool)).toEqual(["NOTION_QUERY", "NOTION_QUERY", "NOTION_TRASH", "NOTION_TRASH"]);
  });
  it("stops instead of retrying a repeated cursor or executing any writes", async () => {
    const paged = { version: 1, steps: [
      { kind: "call", id: "search", tool: "NOTION_QUERY", input: {}, pagination: { cursorArg: "cursor", nextPath: "next", itemsPath: "rows", maxPages: 3 } },
      { kind: "call", id: "write", tool: "NOTION_TRASH", input: {} },
    ] };
    const invoke = vi.fn(async () => ({ rows: [], next: "same" }));
    expect((await executeWorkflow(parseWorkflow(paged), invoke)).status).toBe("failed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("honors cancellation before making a tool call", async () => {
    const signal = AbortSignal.abort();
    const invoke = vi.fn(async () => ({}));
    expect((await executeWorkflow(parseWorkflow(cleanup), invoke, signal)).status).toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
  });
});

it("only runs a conditional action when the current result matches", async () => {
  const plan = { version: 1, steps: [
    { kind: "call", id: "read", tool: "MAIL_LIST", input: {} },
    { kind: "if", id: "condition", where: { path: "read.hasUrgent", equals: true }, steps: [{ kind: "call", id: "alert", tool: "REPORT_ITEM", input: { note: "Urgent" } }] },
  ] };
  const invoke = vi.fn(async () => ({ hasUrgent: false }));
  expect((await executeWorkflow(parseWorkflow(plan), invoke)).status).toBe("completed");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects duplicate step names across nested and top-level steps", () => {
  const bad = { version: 1, steps: [
    { kind: "call", id: "x", tool: "MAIL_LIST", input: {} },
    { kind: "if", id: "check", where: { path: "x.ok", equals: true }, steps: [{ kind: "call", id: "x", tool: "MAIL_LIST", input: {} }] },
  ] };
  expect(() => parseWorkflow(bad)).toThrow(/unique/i);
});

it("does not lose the completed action if cancellation happens after a tool responds", async () => {
  const controller = new AbortController();
  const plan = { version: 1, steps: [{ kind: "call", id: "action", tool: "REPORT_ITEM", input: {} }] };
  const result = await executeWorkflow(parseWorkflow(plan), async () => { controller.abort(); return { ok: true }; }, controller.signal);
  expect(result.status).toBe("failed");
  expect(result.completed).toContain("action");
});
it("rejects malformed references rather than passing them as literal arguments", () => {
  const plan = { version: 1, steps: [{ kind: "call", id: "x", tool: "MAIL_LIST", input: { target: { $ref: "old.id", extra: "ignored" } } }] };
  expect(() => parseWorkflow(plan)).toThrow();
});
