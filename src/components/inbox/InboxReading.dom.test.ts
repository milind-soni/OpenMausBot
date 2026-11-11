// @vitest-environment happy-dom
// The inbox panel as a tab: a searchable list of three-line rows, and a line read in full with the bot's words in context,
// answered there (a question's choices as cards, a note, send), which then gives way to the next line.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: unknown }>, context: [] as unknown[] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (/^\/api\/threads\/[\w-]+\/messages\?/.test(path)) return { messages: server.context };
    return null;
  }),
}));

import { initialState, StoreContext, type AppState } from "@/state/store";
import { closeInbox, currentInboxPanel, currentInbox, openInbox, readInboxLine, setInboxView } from "@/state/inbox";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { InboxPanel } from "./InboxPanel";
import { answerKindOf, choicesLine, headlineOf, nextAfter, recommendedOf } from "./inbox-answer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = Date.now() - 60_000;
const hoster: InboxRow = {
  id: "q1", kind: "ask", tab: "needs-you", unread: true, at: AT, from: { name: "Planner", botId: "planner" },
  origin: { botId: "planner", threadId: "plan-thread", title: "Self-hosting setup", messageId: "q1" }, text: "Who is the self-hoster?",
  card: {
    title: "A question", subtitle: "Who is the self-hoster?", options: [], requestId: "req-q1", requestType: "question",
    questionRequest: { version: 1, questions: [{ question: "Who is the self-hoster?", header: "Q1: who is the self-hoster", options: [
      { label: "Small team (Recommended)", description: "One workspace on their own cloud or VPS" },
      { label: "Enterprise", description: "On-prem or private VPC" },
      { label: "Solo developer", description: "One box or a laptop" },
    ] }] },
  },
};
const why: InboxRow = {
  id: "q2", kind: "ask", tab: "needs-you", unread: true, at: AT - 1, from: { name: "Planner", botId: "planner" },
  origin: { botId: "planner", threadId: "plan-other", title: "Self-hosting setup", messageId: "q2" }, text: "Why are we doing it?",
  card: { title: "A question", subtitle: "Why are we doing it?", options: ["Trust and data control", "Open-source adoption"], requestId: "req-q2", requestType: "question" },
};
const news: InboxRow = {
  id: "n1", kind: "result", tab: "info", unread: false, at: AT - 2, from: { name: "Reporter", botId: "reporter" },
  origin: { botId: "reporter", threadId: "rep-daily", title: "Daily digest", messageId: "n1" }, text: "Daily digest: 3 new leads.",
};
const placeView = (rows: InboxRow[]): InboxView => ({ botId: null, threadId: null, rows, anchor: null });

let root: Root;
const dispatch = vi.fn();
const mount = () => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots: [] } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, createElement(InboxPanel)));
});
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
});
const listed = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow);

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  server.context = [];
  dispatch.mockClear();
  setInboxView(placeView([hoster, why, news]));
  openInbox();
});
afterEach(() => {
  act(() => root.unmount());
  closeInbox();
  setInboxView(null);
  document.body.innerHTML = "";
});

describe("the inbox's words", () => {
  it("marks the recommended choice, joins the choices and says what a line is about", () => {
    expect(recommendedOf("Small team (Recommended)")).toEqual({ label: "Small team", recommended: true });
    expect(recommendedOf("Enterprise")).toEqual({ label: "Enterprise", recommended: false });
    expect(choicesLine(hoster)).toBe("Small team (recommended) / Enterprise / Solo developer");
    expect(choicesLine(news)).toBeNull();
    expect(headlineOf(hoster)).toBe("Q1: who is the self-hoster");
    expect(headlineOf(why)).toBe("Why are we doing it?");
    expect(answerKindOf(hoster)).toBe("question");
    expect(answerKindOf({ ...news, replies: true, kind: "message" })).toBe("reply");
    expect(answerKindOf({ ...news, tab: "done" })).toBe("none");
    expect(nextAfter(["a", "b", "c"], "b")).toBe("c");
    expect(nextAfter(["a", "b", "c"], "c")).toBe("b");
    expect(nextAfter(["a"], "a")).toBeNull();
  });

  it("keys a password, a sign-in and an app to connect by what the line waits on the person for", () => {
    const secret: InboxRow = { ...news, kind: "ask", tab: "needs-you", secret: { target: "custom", label: "Stripe key", description: "", placeholder: "", helpUrl: "", requestKey: "k" } as unknown as InboxRow["secret"] };
    const signIn: InboxRow = { ...news, kind: "ask", tab: "needs-you", signIn: { url: "https://shop.test", site: "shop.test", place: "browser" } as InboxRow["signIn"] };
    const connect: InboxRow = { ...news, kind: "ask", tab: "needs-you", connector: { label: "Gmail", description: "Read mail", resumeKey: "r1" } as InboxRow["connector"] };
    expect(answerKindOf(secret)).toBe("password");
    expect(answerKindOf(signIn)).toBe("sign-in");
    expect(answerKindOf(connect)).toBe("connect");
    expect(answerKindOf({ ...signIn, signIn: { ...signIn.signIn!, done: true } })).toBe("none");
    expect(answerKindOf({ ...secret, secret: { ...secret.secret!, provided: true } })).toBe("none");
    expect(headlineOf(signIn)).toBe("Sign in to shop.test");
    expect(headlineOf(connect)).toBe("Connect Gmail");
  });
});

describe("the inbox tab", () => {
  it("is a tab with its count that closes, and lists three-line rows a search filters", async () => {
    await mount();
    const chip = document.querySelector("[data-inbox-tab-chip]")!;
    expect(chip.textContent).toContain("Inbox");
    expect(chip.querySelector("[data-inbox-tab-count]")!.textContent).toBe("2");
    expect(listed()).toEqual(["q1", "q2", "n1"]);
    const first = document.querySelector('[data-inbox-row="q1"]')!;
    expect(first.querySelector("[data-inbox-from]")!.textContent).toBe("Planner");
    expect(first.querySelector("[data-inbox-subject]")!.textContent).toBe("Q1: who is the self-hoster");
    expect(first.querySelector("[data-inbox-choices]")!.textContent).toBe("Small team (recommended) / Enterprise / Solo developer");
    expect(document.querySelector('[data-inbox-row="n1"] [data-inbox-choices]')).toBeNull();
    await type(document.querySelector<HTMLInputElement>('input[type="search"]')!, "digest");
    expect(listed()).toEqual(["n1"]);
    await type(document.querySelector<HTMLInputElement>('input[type="search"]')!, "nothing like it");
    expect(listed()).toEqual([]);
    expect(document.body.textContent).toContain("Nothing in the inbox matches.");
    await click('[aria-label="Close inbox"]');
    expect(currentInboxPanel().open).toBe(false);
  });
});

describe("a line read in full", () => {
  it("shows where it is with steps up and down, the way it came, and the bot's words before it in context", async () => {
    server.context = [
      { id: "m0", role: "user", kind: "text", text: "Set up self-hosting", at: AT - 10 },
      { id: "m1", role: "bot", kind: "text", text: "Grilling round 1. **A small team** first.", at: AT - 5 },
    ];
    await mount();
    await click('[data-inbox-row="q1"] > button');
    expect(document.querySelector("[data-inbox-position]")!.textContent).toBe("1 of 3");
    expect(document.querySelector("nav")!.textContent).toContain("Self-hosting setup");
    expect(document.querySelector("nav")!.textContent).toContain("Q1: who is the self-hoster");
    expect(server.calls).toContainEqual({ path: "/api/threads/plan-thread/messages?limit=8&before=q1", method: "GET" });
    const words = document.querySelector("[data-inbox-words]")!;
    expect(words.textContent).toContain("Grilling round 1.");
    expect(words.querySelector("strong")?.textContent, "drawn as the chat's Markdown").toBe("A small team");
    expect(words.textContent, "what the person said is not the bot's").not.toContain("Set up self-hosting");
    await click('[aria-label="Next"]');
    expect(currentInboxPanel().reading).toBe("q2");
    expect(document.querySelector("[data-inbox-position]")!.textContent).toBe("2 of 3");
    await click('[aria-label="Previous"]');
    expect(currentInboxPanel().reading).toBe("q1");
    await click('[aria-label="Back to the list"]');
    expect(currentInboxPanel().reading).toBeNull();
  });

  it("answers a question with its choices as cards, a number key and a note, where it was asked, then moves to the next line", async () => {
    await mount();
    await click('[data-inbox-row="q1"] > button');
    const options = [...document.querySelectorAll<HTMLElement>("[data-inbox-option]")];
    expect(options.map((option) => option.dataset.inboxOption)).toEqual(["Small team", "Enterprise", "Solo developer"]);
    expect(options[0]!.querySelector("[data-inbox-recommended]")?.textContent).toBe("Recommended");
    expect(options[1]!.textContent).toContain("On-prem or private VPC");
    expect(document.querySelector<HTMLButtonElement>("[data-inbox-send]")!.disabled, "nothing to send yet").toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })); });
    expect(options[1]!.getAttribute("aria-checked")).toBe("true");
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a note"]')!, "Mostly agencies");
    await click("[data-inbox-send]");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "plan-thread", requestId: "req-q1", behavior: "answer" }));
    const sent = dispatch.mock.calls.find(([action]) => action.type === "decideRequest")![0].message as string;
    expect(sent).toContain("Q: Who is the self-hoster?\nA: Enterprise, Mostly agencies");
    expect(currentInbox()!.rows.find((row) => row.id === "q1")!.tab, "it leaves the list at once").toBe("done");
    expect(currentInboxPanel().reading, "the next line opens").toBe("q2");
    expect(document.querySelector('[data-inbox-reading="q2"]')).not.toBeNull();
  });

  it("goes back to the list once the last line waiting is answered, and × closes a question unanswered", async () => {
    setInboxView(placeView([why]));
    await act(async () => { readInboxLine("q2"); });
    await mount();
    await click('[data-inbox-option="Trust and data control"]');
    await click("[data-inbox-send]");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "plan-other", requestId: "req-q2", behavior: "answer", message: "Trust and data control" }));
    expect(currentInboxPanel().reading).toBeNull();
    expect(document.querySelector("[data-inbox-list]")).not.toBeNull();

    dispatch.mockClear();
    setInboxView(placeView([hoster]));
    await act(async () => { readInboxLine("q1"); });
    await click('[data-inbox-answer="question"] [data-inbox-action="close"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "plan-thread", requestId: "req-q1", behavior: "answer" }));
    expect(currentInboxPanel().reading).toBeNull();
  });

  it("answers a password, a sign-in and an app to connect with the chat's own card for each", async () => {
    const base = { ...news, kind: "ask" as const, tab: "needs-you" as const };
    const rows: InboxRow[] = [
      { ...base, id: "pw", secret: { target: "custom", label: "Stripe key", description: "For the billing report", placeholder: "sk_live_…", helpUrl: "", requestKey: "k", reason: "To read invoices" } as unknown as InboxRow["secret"] },
      { ...base, id: "si", signIn: { url: "https://shop.test", site: "shop.test", place: "browser", reason: "To see the order" } as InboxRow["signIn"] },
      { ...base, id: "co", connector: { label: "Gmail", description: "Read mail", resumeKey: "r1", status: "required" } as InboxRow["connector"] },
    ];
    setInboxView(placeView(rows));
    await mount();
    for (const [id, kind, words] of [["pw", "password", "Stripe key"], ["si", "sign-in", "shop.test"], ["co", "connect", "Gmail"]] as const) {
      await act(async () => { readInboxLine(id); });
      const answer = document.querySelector<HTMLElement>(`[data-inbox-reading="${id}"] [data-inbox-answer-kind]`)!;
      expect(answer.dataset.inboxAnswerKind).toBe(kind);
      expect(answer.textContent, kind).toContain(words);
    }
  });

  it("reads news with Done, which moves on to what is left", async () => {
    await act(async () => { readInboxLine("n1"); });
    await mount();
    expect(document.querySelector("[data-inbox-answer-kind]")!.getAttribute("data-inbox-answer-kind")).toBe("none");
    expect(document.querySelector("[data-inbox-words]")!.textContent).toContain("Daily digest: 3 new leads.");
    await click('[data-inbox-reading] [data-inbox-action="done"]');
    expect(server.calls).toContainEqual({ path: "/api/inbox/n1/done", method: "POST" });
    expect(currentInboxPanel().reading, "news was last in the list: the line above it opens").toBe("q2");
  });
});
