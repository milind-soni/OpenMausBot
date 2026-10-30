// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: unknown }>, view: null as null | { rows: Array<{ id: string; tab: string }> } }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const done = /^\/api\/inbox\/([\w-]+)\/done$/.exec(path);
    if (done && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => (row.id === done[1] ? { ...row, tab: "done", unread: false } : row)) };
    return server.view;
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";
import { closeInbox, currentInboxPanel, inboxVersion, openInbox, setInboxView, useInboxLoader } from "@/state/inbox";
import { approvalRow, inboxView, messageRow, questionRow, reportRow, settledRow } from "@/testing/inbox-fixture";
import type { InboxView } from "../../../shared/inbox";
import { InboxCardSlot } from "./InboxCard";
import { InboxPanel } from "./InboxPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const dispatch = vi.fn();
const mount = (child: ReactElement, bots: Bot[] = []) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const shown = (view: InboxView) => { server.view = view; setInboxView(view); };

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  dispatch.mockClear();
  shown(inboxView());
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the inbox panel", () => {
  it("opens on Needs you with its count, lists each tab's own lines, and reads one in full", async () => {
    openInbox({ tab: "needs-you" });
    await mount(createElement(InboxPanel));
    const tab = (name: string) => document.querySelector<HTMLElement>(`[data-inbox-tab="${name}"]`)!;
    expect(tab("needs-you").getAttribute("aria-selected")).toBe("true");
    expect(tab("needs-you").getAttribute("aria-label")).toBe("Needs you, 2");
    const listed = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow);
    expect(listed()).toEqual([approvalRow.id, questionRow.id]);
    expect(document.querySelector(`[data-inbox-row="${approvalRow.id}"]`)!.hasAttribute("data-unread")).toBe(true);
    await click('[data-inbox-tab="info"]');
    expect(listed()).toEqual([messageRow.id, reportRow.id]);
    await click('[data-inbox-tab="done"]');
    expect(listed()).toEqual([settledRow.id]);
    await click('[data-inbox-tab="info"]');
    await click(`[data-inbox-row="${messageRow.id}"] button`);
    expect(document.querySelector(`[data-inbox-reading="${messageRow.id}"]`)?.textContent).toContain("The launch moved to Friday.");
    expect(server.calls).toContainEqual({ path: `/api/inbox/${messageRow.id}/read`, method: "POST" });
    expect(document.querySelector("textarea"), "a message that waits on an answer takes a reply").not.toBeNull();
    await click('[aria-label="Back to the list"]');
    expect(listed()).toEqual([messageRow.id, reportRow.id]);
  });

  it("answers an ask from its row through the copy's own card, as the chat's buttons do, and marks news done", async () => {
    openInbox({ tab: "needs-you" });
    await mount(createElement(InboxPanel));
    await click(`[data-inbox-row="${approvalRow.id}"] [data-inbox-action="allow"]`);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-approval", behavior: "allow" }));
    await click(`[data-inbox-row="${questionRow.id}"] [data-inbox-action="close"]`);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-question", behavior: "answer" }));
    await click('[data-inbox-tab="info"]');
    await click(`[data-inbox-row="${reportRow.id}"] [data-inbox-action="done"]`);
    expect(server.calls).toContainEqual({ path: `/api/inbox/${reportRow.id}/done`, method: "POST" });
    expect(document.querySelector(`[data-inbox-row="${reportRow.id}"]`), "it leaves the tab at once").toBeNull();
  });

  it("is a sheet at phone width", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
    openInbox();
    await mount(createElement(InboxPanel));
    expect(document.querySelector('[data-inbox-panel="sheet"]')).not.toBeNull();
    expect(document.querySelector('[data-inbox-panel="side"]')).toBeNull();
  });
});

describe("the inbox's card in the chat", () => {
  const lines = (ids: string[]) => createElement("div", null, ...ids.map((id) => createElement(InboxCardSlot, { key: id, threadId: "inbox", messageId: id })));

  it("sits once, under the newest line that needed the person, and opens the inbox", async () => {
    await mount(lines([settledRow.id, reportRow.id, messageRow.id, questionRow.id, approvalRow.id]));
    expect(document.querySelectorAll("[data-inbox-card]")).toHaveLength(1);
    expect(document.querySelector('[data-inbox-card="open"]')!.getAttribute("aria-label")).toBe("2 need you · 2 for your info");
    expect([...document.querySelectorAll("[data-inbox-card] [data-inbox-row]")].map((row) => (row as HTMLElement).dataset.inboxRow)).toEqual([approvalRow.id, questionRow.id]);
    expect([...document.querySelectorAll('[data-inbox-card] [data-inbox-action="allow"]')].filter((button) => !button.closest("[data-inbox-row]")),
      "the line the card sits under answers on its own card").toEqual([]);
    await click('[data-inbox-card] [data-inbox-choice="Pricing"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-question", behavior: "answer", message: "Pricing" }));
    await click('[data-inbox-card] header button');
    expect(currentInboxPanel()).toMatchObject({ open: true, tab: "needs-you" });
    await mount(createElement(InboxCardSlot, { threadId: "elsewhere", messageId: approvalRow.id }));
    expect(document.querySelector("[data-inbox-card]"), "never in another conversation").toBeNull();
  });

  it("shrinks to one line when nothing waits, and moves under a new ask once it lands", async () => {
    const caughtUp = inboxView([messageRow, reportRow, { ...settledRow }]);
    shown({ ...caughtUp, anchor: settledRow.id });
    await mount(lines([settledRow.id, reportRow.id, messageRow.id]));
    expect(document.querySelector('[data-inbox-card="caught-up"]')?.textContent).toContain("All caught up · 2 for your info");
    const later = { ...approvalRow, id: "line-later" };
    await act(async () => { shown({ ...inboxView([later, messageRow, reportRow, settledRow]), anchor: later.id }); });
    await mount(lines([settledRow.id, reportRow.id, messageRow.id, later.id]));
    const cards = document.querySelectorAll("[data-inbox-card]");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-inbox-card")).toBe("open");
  });
});

describe("answer buttons in the asking bot's colour", () => {
  const reporter = { id: "reporter", name: "Reporter", color: "orange" } as Bot;
  /** The answer under a line, not the quick action on the row itself. */
  const answer = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((button) => !button.closest("[data-inbox-row]"))!;
  const own = (selector: string) => {
    const button = answer(selector);
    expect(button.className.split(" ")).toContain(BOT_BUTTON);
    expect(button.style.getPropertyValue("--bot-button")).toBe(botButtonTone("orange").fill);
    expect(button.style.getPropertyValue("--bot-button-ink")).toBe(botButtonTone("orange").ink);
  };

  it("paints Allow on the chat's card and in the panel in the colour of the bot the line is from", async () => {
    shown({ ...inboxView(), anchor: questionRow.id });
    await mount(createElement(InboxCardSlot, { threadId: "inbox", messageId: questionRow.id }), [reporter]);
    own('[data-inbox-card] [data-inbox-action="allow"]');
    expect(answer('[data-inbox-card] [data-inbox-action="deny"]').className.split(" ")).not.toContain(BOT_BUTTON);
    openInbox({ reading: approvalRow.id });
    await mount(createElement(InboxPanel), [reporter]);
    own('[data-inbox-reading] [data-inbox-action="allow"]');
  });

  it("keeps the plain primary for a teammate's line and for a bot this app does not know", async () => {
    openInbox({ reading: messageRow.id });
    await mount(createElement(InboxPanel), [reporter]);
    const send = document.querySelector<HTMLElement>('[data-inbox-reading] button[type="submit"]')!;
    expect(send.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(send.className.split(" ")).toContain("bg-accent");
    shown({ ...inboxView(), anchor: questionRow.id });
    await mount(createElement(InboxCardSlot, { threadId: "inbox", messageId: questionRow.id }));
    expect(answer('[data-inbox-card] [data-inbox-action="allow"]').className.split(" ")).not.toContain(BOT_BUTTON);
  });
});

describe("keeping the list live", () => {
  function Loader({ version }: { version: string | null }) {
    useInboxLoader(version);
    return null;
  }

  it("reads the list again whenever the person's inbox task says it changed, and never off a team", async () => {
    const task = (inboxChangedAt?: number, openAsks?: number) => [{ id: "bens-chief", tasks: [{ threadId: "inbox", inbox: true as const, ...(inboxChangedAt ? { inboxChangedAt } : {}), ...(openAsks ? { openAsks } : {}) }] }];
    expect(inboxVersion([{ id: "solo", tasks: [{ threadId: "t1" }] }]), "nothing is anyone's inbox off a team").toBeNull();
    const first = inboxVersion(task(5, 2));
    expect(inboxVersion(task(6, 2))).not.toBe(first);
    expect(inboxVersion(task(5, 1))).not.toBe(first);
    await mount(createElement(Loader, { version: first }));
    await settle();
    const reads = () => server.calls.filter((call) => call.path === "/api/inbox").length;
    expect(reads()).toBe(1);
    await mount(createElement(Loader, { version: first }));
    await settle();
    expect(reads(), "the same version reads nothing").toBe(1);
    await mount(createElement(Loader, { version: inboxVersion(task(6, 1)) }));
    await settle();
    expect(reads()).toBe(2);
    await mount(createElement(Loader, { version: null }));
    await settle();
    expect(reads()).toBe(2);
  });
});
