// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: any }>, answer: null as unknown, refusal: null as null | { status: number } }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (server.refusal) throw Object.assign(new Error("There is no inbox here."), server.refusal);
    return server.answer;
  }),
}));

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { closeInbox, currentInboxPanel, openInbox, readInboxLine, refreshInbox, setInboxView } from "@/state/inbox";
import { setTeamPeople } from "@/state/team-people";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { SidebarActiveThreads } from "../SidebarActiveThreads";
import { NeedsYouButton } from "../TeamOwner";
import { SidebarInboxRow } from "../SidebarInboxRow";
import { setAttentionPinned } from "./attention-pinned";
import { InboxPanel } from "./InboxPanel";
import { senderLabel, waitingCount } from "./inbox-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = Date.now() - 60_000;
const approval: InboxRow = {
  id: "card-a", kind: "ask", tab: "needs-you", unread: true, at: AT, from: { name: "Eli", botId: "eli" }, workingFor: { botId: "mira", name: "Mira" },
  origin: { botId: "eli", threadId: "eli-pricing", title: "Pricing work", messageId: "card-a" }, text: "Run: rm -rf ./build",
  card: { title: "Approval needed", subtitle: "Run: rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-a", tool: "Bash", requestType: "permission" },
};
const question: InboxRow = {
  id: "card-q", kind: "ask", tab: "needs-you", unread: false, at: AT - 1, from: { name: "Eli", botId: "eli" },
  origin: { botId: "eli", threadId: "eli-launch", title: "Launch work", messageId: "card-q" }, text: "Which page?",
  card: { title: "A question", subtitle: "Which page?", options: ["Home", "Pricing"], requestId: "req-q", requestType: "question" },
};
const news: InboxRow = {
  id: "line-n", kind: "message", tab: "info", unread: true, replies: true, at: AT - 2, from: { name: "Noa", botId: "noa" },
  origin: { botId: "noa", threadId: "noa-main", title: "Noa", messageId: "line-n" }, text: "The report is ready.",
};
const roomNews: InboxRow = { ...news, id: "line-r", origin: { botId: "noa", threadId: "room-thread", groupId: "room", title: "Launch room", messageId: "line-r" } };
const read: InboxRow = { ...news, id: "line-read", unread: false };
const settled: InboxRow = { ...news, id: "line-done", tab: "done", unread: false };
const placeView = (rows: InboxRow[]): InboxView => ({ botId: null, threadId: null, rows, anchor: null });

let root: Root;
const dispatch = vi.fn();
const bot = (over: Partial<Bot>): Bot => ({ id: "eli", name: "Eli", threadId: "eli-main", tasks: [], ...over } as Bot);
const mount = (child: ReactElement, bots: Bot[] = []) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const row = (props: Partial<Parameters<typeof SidebarInboxRow>[0]> = {}) => createElement(SidebarInboxRow, { icons: false, large: false, running: false, ...props });
const inboxButton = () => document.querySelector<HTMLElement>("[data-sidebar-inbox]");

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  server.refusal = null;
  server.answer = placeView([]);
  dispatch.mockClear();
  setTeamPeople(null);
  setAttentionPinned(false);
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  setTeamPeople(null);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the Inbox row", () => {
  it("counts what waits on the person, not news they read or anything settled", async () => {
    setInboxView(placeView([approval, question, news, read, settled]));
    await mount(row());
    expect(document.querySelector("[data-inbox-count]")?.textContent).toBe("3");
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Inbox, 3 waiting");
    expect(waitingCount(placeView([approval, question, news, read, settled]))).toBe(3);
  });

  it("stays with no count when nothing waits, and before the list arrives", async () => {
    await mount(row());
    expect(inboxButton()!.textContent).toContain("Inbox");
    expect(document.querySelector("[data-inbox-count]")).toBeNull();
    setInboxView(placeView([read, settled]));
    await mount(row());
    expect(inboxButton()!.getAttribute("aria-label")).toBe("Inbox");
    expect(document.querySelector("[data-inbox-count]")).toBeNull();
  });

  it("opens and closes the inbox, and shows a dot while a bot is at work", async () => {
    setInboxView(placeView([]));
    await mount(row({ running: true }));
    expect(document.querySelector("[data-inbox-running]")).not.toBeNull();
    await click("[data-sidebar-inbox]");
    expect(currentInboxPanel().open).toBe(true);
    await click("[data-sidebar-inbox]");
    expect(currentInboxPanel().open).toBe(false);
    await mount(row({ running: false }));
    expect(document.querySelector("[data-inbox-running]")).toBeNull();
  });

  it("is a tile with the same count among the avatars", async () => {
    setInboxView(placeView([approval]));
    await mount(row({ icons: true }));
    expect(document.querySelector("[data-inbox-count]")?.textContent).toBe("1");
    setInboxView(placeView(Array.from({ length: 12 }, (_, index) => ({ ...approval, id: `a${index}` }))));
    await mount(row({ icons: true }));
    expect(document.querySelector("[data-inbox-count]")?.textContent).toBe("9+");
  });

  it("counts what a team's person has to fix, except what the inbox lists already", async () => {
    setInboxView(placeView([question]));
    setTeamPeople({ people: [], me: null, admin: true, needsYou: [
      { kind: "signed-out", id: "s", at: AT, instanceId: "claude", botIds: ["eli"] },
      { kind: "question", id: "same", at: AT, botId: "eli", threadId: "eli-launch", text: "Which page?" },
      { kind: "question", id: "own", at: AT, botId: "eli", threadId: "eli-main", text: "In their own chat" },
      { kind: "message", id: "m", at: AT, botId: "eli", threadId: "t", from: "Ada", text: "An inbox line" },
    ] });
    await mount(row());
    expect(document.querySelector("[data-inbox-count]")?.textContent).toBe("3");
    server.answer = placeView([question]);
    openInbox();
    await mount(createElement(InboxPanel), [bot({})]);
    expect(document.querySelector("[data-inbox-fixes]")?.textContent).toContain("Eli needs a fix");
    expect(document.querySelector("[data-inbox-fixes]")?.textContent).toContain("In their own chat");
    expect(document.querySelector("[data-inbox-fixes]")?.textContent).not.toContain("Which page?");
  });
});

describe("an older server, with no inbox off a team", () => {
  beforeEach(() => { server.refusal = { status: 404 }; });

  it("falls back to the tray and Needs you it showed before, and is not asked again", async () => {
    await refreshInbox();
    await mount(createElement("div", null, row(), createElement(SidebarActiveThreads, { entries: [], icons: false, phone: false, dispatch: vi.fn() })));
    expect(inboxButton(), "no row where there is no inbox").toBeNull();
    await click('[aria-label="Active Threads"]');
    expect(document.body.textContent).toContain("No active threads");
    setTeamPeople({ people: [], me: null, admin: true, needsYou: [{ kind: "question", id: "q", at: AT, botId: "eli", threadId: "t", text: "Which?" }] });
    await mount(createElement(NeedsYouButton));
    expect(document.querySelector("[data-needs-you]"), "Needs you stays on an older team's Cloud").not.toBeNull();
  });

  it("keeps the row when the server merely can't be reached", async () => {
    server.refusal = { status: 503 };
    await refreshInbox();
    await mount(row());
    expect(inboxButton()).not.toBeNull();
  });
});

describe("a place's inbox in the panel", () => {
  const panel = async (rows: InboxRow[], bots: Bot[] = []) => {
    server.answer = placeView(rows);
    setInboxView(placeView(rows));
    openInbox();
    await mount(createElement(InboxPanel), bots);
  };

  it("labels who a line is from, who that bot worked for, and which conversation it came from", async () => {
    await panel([approval, question, news]);
    const line = (id: string) => document.querySelector(`[data-inbox-row="${id}"]`)!;
    expect(line("card-a").querySelector("[data-inbox-from]")!.textContent).toBe("Eli, working for Mira");
    expect(line("card-a").querySelector("[data-inbox-place]")!.textContent).toContain("in Pricing work");
    expect(line("card-q").querySelector("[data-inbox-from]")!.textContent).toBe("Eli");
    expect(line("card-q").querySelector("[data-inbox-place]")!.textContent).toContain("in Launch work");
    expect(senderLabel({ from: { name: "Eli" }, askedBy: { name: "Sam" } })).toBe("Eli, asked by Sam");
    expect(senderLabel({ from: { name: "Eli" }, askedBy: { name: "" } })).toBe("Eli, asked by someone else");
  });

  it("marks what waits on the person with a dot, on asks only", async () => {
    await panel([approval, news]);
    expect([...document.querySelectorAll("[data-inbox-waits]")].map((dot) => dot.closest<HTMLElement>("[data-inbox-row]")!.dataset.inboxRow)).toEqual(["card-a"]);
  });

  it("answers an ask from its row where it was asked, since there is no copy", async () => {
    await panel([approval, question]);
    await click('[data-inbox-row="card-a"] [data-inbox-action="allow"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "eli-pricing", requestId: "req-a", behavior: "allow" }));
    await click('[data-inbox-row="card-q"] [data-inbox-action="close"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "eli-launch", requestId: "req-q", behavior: "answer" }));
  });

  it("answers a question from the line read in full, where it was asked", async () => {
    await panel([question]);
    await act(async () => { readInboxLine("card-q"); });
    await mount(createElement(InboxPanel));
    await click('[data-inbox-reading] [data-inbox-option="Pricing"]');
    expect(dispatch, "a tick alone sends nothing").not.toHaveBeenCalled();
    await click("[data-inbox-reading] [data-inbox-send]");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "eli-launch", requestId: "req-q", behavior: "answer", message: "Pricing" }));
  });

  it("sends a reply to the conversation the message came from, in a bot's chat or a room", async () => {
    await panel([news, roomNews]);
    for (const [id, path, threadId] of [["line-n", "/api/bots/noa/messages", "noa-main"], ["line-r", "/api/groups/room/messages", "room-thread"]] as const) {
      await act(async () => { readInboxLine(id); });
      await mount(createElement(InboxPanel));
      const box = document.querySelector<HTMLTextAreaElement>("[data-inbox-reading] textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Thanks");
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
      const send = [...document.querySelectorAll<HTMLElement>("[data-inbox-reading] form button")].find((button) => /send/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
      if (!server.calls.some((call) => call.path === path)) await act(async () => { send?.click(); });
      expect(server.calls.find((call) => call.path === path), path).toMatchObject({ method: "POST", body: { text: "Thanks", threadId, replyToId: id } });
    }
  });

  it("opens a line where it came from: that bot, that thread and that message, from its row or read in full", async () => {
    const eli = bot({ tasks: [{ threadId: "eli-pricing", title: "Pricing work", createdAt: 1 }, { threadId: "eli-launch", title: "Launch work", createdAt: 2 }] as Bot["tasks"] });
    const noa = bot({ id: "noa", name: "Noa", threadId: "noa-main", tasks: [{ threadId: "noa-main", title: "Noa", createdAt: 1 }] as Bot["tasks"] });
    await panel([question, news], [eli, noa]);
    await click('[data-inbox-row="line-n"] [data-inbox-action="open"]');
    expect(dispatch).toHaveBeenCalledWith({ type: "revealThread", threadId: "noa-main" });
    expect(dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: "noa-main", messageId: "line-n" });
    dispatch.mockClear();
    await act(async () => { readInboxLine("card-q"); });
    await mount(createElement(InboxPanel), [eli, noa]);
    await click('[data-inbox-reading] [data-inbox-action="open"]');
    expect(dispatch).toHaveBeenCalledWith({ type: "revealThread", threadId: "eli-launch" });
    expect(dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: "eli-launch", messageId: "card-q" });
    expect(dispatch.mock.calls.map(([action]) => action.threadId).filter(Boolean).every((threadId) => threadId === "eli-launch"), "nothing opens another of the bot's threads").toBe(true);
  });

  it("lists the conversations at work with a jump to each and the pin, leaving out what the inbox already asks", async () => {
    const working = { threadId: "eli-work", title: "Writing the page", createdAt: 1, busy: true, activity: "working" as const };
    const asking = { threadId: "eli-pricing", title: "Pricing work", createdAt: 2, activity: "waiting-on-you" as const };
    const told = { threadId: "noa-main", title: "Told already", createdAt: 3, unread: true };
    const toldAndWorking = { threadId: "line-thread", title: "Told and still working", createdAt: 4, unread: true, busy: true };
    const lineThere = { ...news, id: "line-t", origin: { botId: "eli", threadId: "line-thread", title: "Told and still working" } };
    await panel([approval, news, lineThere], [bot({ tasks: [working, asking, told, toldAndWorking] as Bot["tasks"] })]);
    const section = document.querySelector<HTMLElement>("[data-inbox-active]")!;
    expect(section.textContent).toContain("Writing the page");
    expect(section.textContent).not.toContain("Pricing work");
    expect(section.textContent, "unread news is already a line above").not.toContain("Told already");
    expect(section.textContent, "work still going stays reachable").toContain("Told and still working");
    await act(async () => { [...section.querySelectorAll<HTMLElement>("button")].find((one) => one.textContent?.includes("Writing the page"))!.click(); });
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "eli", threadId: "eli-work" });
    await click("[data-inbox-pin]");
    expect(document.querySelector("[data-inbox-pin]")!.getAttribute("aria-label")).toBe("Unpin");
  });
});
