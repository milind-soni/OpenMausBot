// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string }>, view: null as null | { rows: Array<{ id: string; tab: string; kind?: string; unread?: boolean }> } }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET" });
    const marked = /^\/api\/inbox\/([\w-]+)\/(read|unread)$/.exec(path);
    // As the server does: a finished report the person has read is settled.
    if (marked && server.view) {
      const read = marked[2] === "read";
      server.view = { ...server.view, rows: server.view.rows.map((row) => (row.id !== marked[1] ? row
        : { ...row, unread: !read, ...(row.kind === "result" ? { tab: read ? "done" : "info" } : {}) })) };
    }
    return server.view ?? {};
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { closeInbox, currentInbox, openInbox, replyToInboxRow, setInboxView } from "@/state/inbox";
import { approvalRow, inboxView, messageRow, questionRow, reportRow } from "@/testing/inbox-fixture";
import type { InboxView } from "../../../shared/inbox";
import { SidebarInboxRow } from "../SidebarInboxRow";
import { InboxPanel } from "./InboxPanel";
import { READ_AFTER_MS } from "./use-inbox-hold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let focused = true;
const reporter = { id: "reporter", name: "Reporter", color: "orange", threadId: "rep-main", tasks: [{ threadId: "rep-daily", title: "Daily digest", createdAt: 0 }] } as unknown as Bot;
const mount = (child: ReactElement) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots: [reporter] } as AppState, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const shown = (view: InboxView) => { server.view = view; setInboxView(view); };
const reads = (id: string) => server.calls.filter((call) => call.path === `/api/inbox/${id}/read`).length;
const listed = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-inbox-row="${id}"]`);
const windowIs = (now: boolean) => act(async () => { focused = now; window.dispatchEvent(new Event(now ? "focus" : "blur")); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  focused = true;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  shown(inboxView());
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reading a line in the inbox", () => {
  it("reads it after a moment on screen with the window focused, and Undo makes it new again for good", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    await click(`[data-inbox-row="${messageRow.id}"] button`);
    await wait(READ_AFTER_MS - 100);
    expect(reads(messageRow.id), "not at once").toBe(0);
    await windowIs(false);
    await wait(READ_AFTER_MS * 3);
    expect(reads(messageRow.id), "not while the person is in another window").toBe(0);
    await windowIs(true);
    await wait(READ_AFTER_MS);
    expect(reads(messageRow.id)).toBe(1);
    expect(currentInbox()!.rows.find((row) => row.id === messageRow.id)!.unread).toBe(false);
    expect(document.querySelector("[data-inbox-marked]")?.textContent).toBe("Marked as read·Undo");

    await click("[data-inbox-undo]");
    expect(server.calls).toContainEqual({ path: `/api/inbox/${messageRow.id}/unread`, method: "POST" });
    expect(currentInbox()!.rows.find((row) => row.id === messageRow.id)!.unread).toBe(true);
    expect(document.querySelector("[data-inbox-marked]")).toBeNull();
    await wait(READ_AFTER_MS * 3);
    expect(reads(messageRow.id), "it stays new while the person still has it open").toBe(1);
    await click('[aria-label="Back to the list"]');
    expect(rowOf(messageRow.id)!.hasAttribute("data-unread")).toBe(true);
  });

  it("keeps a finished line in its place, muted, once read, until the person picks another", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    const before = listed();
    await click(`[data-inbox-row="${reportRow.id}"] button`);
    await wait(READ_AFTER_MS);
    expect(reads(reportRow.id)).toBe(1);
    expect(currentInbox()!.rows.find((row) => row.id === reportRow.id)!.tab, "the server settled it").toBe("done");
    expect(listed(), "no row moved").toEqual(before);
    expect(rowOf(reportRow.id)!.hasAttribute("data-unread")).toBe(false);
    expect(rowOf(reportRow.id)!.hasAttribute("data-inbox-current")).toBe(true);
    expect(document.querySelector("[data-inbox-done-toggle] .tabular-nums")?.textContent, "it is not listed twice: Done holds only the older settled ask").toBe("1");

    await click(`[data-inbox-row="${questionRow.id}"] button`);
    expect(document.querySelector("[data-inbox-marked]"), "the note goes with the pick").toBeNull();
    await click('[aria-label="Back to the list"]');
    expect(listed()).toEqual(before.filter((id) => id !== reportRow.id));
  });

  it("reads a line at once when the person replies to it", async () => {
    await replyToInboxRow(inboxView(), messageRow, "Friday works.");
    expect(server.calls.map((call) => call.path)).toEqual(["/api/bots/bens-chief/messages", `/api/inbox/${messageRow.id}/read`, "/api/inbox"]);
  });

  it("shows For you first and Activity after, calm when nothing is for the person", async () => {
    openInbox();
    await mount(createElement(InboxPanel));
    const group = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-inbox-group="${name}"] [data-inbox-row]`)].map((row) => row.dataset.inboxRow);
    expect(group("for-you")).toEqual([approvalRow.id, questionRow.id, messageRow.id]);
    expect(group("activity")).toEqual([reportRow.id]);
    expect(document.querySelector(`[data-inbox-row="${messageRow.id}"] [data-inbox-reason]`)?.textContent).toBe("Messaged you");
    expect(document.querySelector("[data-inbox-tab-count]")?.textContent).toBe("3");

    await act(async () => { shown(inboxView([reportRow])); });
    expect(document.querySelector('[data-inbox-group="for-you"] [data-inbox-caught-up]')?.textContent).toBe("You're all caught up.");
    expect(group("activity")).toEqual([reportRow.id]);
    expect(document.querySelector("[data-inbox-tab-count]")).toBeNull();
  });
});

describe("the sidebar's Inbox row", () => {
  it("counts For you only, and is bold with no number while only Activity is new", async () => {
    await mount(createElement(SidebarInboxRow, { icons: false, large: true, running: false }));
    const row = () => document.querySelector<HTMLElement>("[data-sidebar-inbox]")!;
    expect(row().dataset.sidebarInbox).toBe("3");
    expect(row().hasAttribute("data-inbox-activity")).toBe(false);

    await act(async () => { shown(inboxView([reportRow, { ...messageRow, unread: false }])); });
    expect(row().dataset.sidebarInbox).toBe("0");
    expect(document.querySelector("[data-inbox-count]")).toBeNull();
    expect(row().hasAttribute("data-inbox-activity")).toBe(true);
    expect(row().getAttribute("aria-label")).toBe("Inbox, new activity");
    expect(row().querySelector(".font-semibold")?.textContent).toBe("Inbox");
  });
});
