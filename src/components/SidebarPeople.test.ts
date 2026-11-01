import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import { needsYouVersion, setTeamPeople, type TeamPeople } from "@/state/team-people";

import { InboxAnswers, InboxCaption, RelayLabel } from "./InboxLine";
import { inboxBotOf, SidebarPeople } from "./SidebarPeople";
import { pendingApprovals, PendingApprovalPanel } from "./PendingApproval";

const CLEO = { email: "cleo@acme.test", name: "Cleo", role: "owner" };
const BEN = { email: "ben@acme.test", name: "Ben", role: "member", you: true as const };
const asBen: TeamPeople = { people: [CLEO, BEN], me: BEN, admin: false, needsYou: [] };

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [], ...overrides,
});
const render = (child: ReturnType<typeof createElement>, state: Partial<AppState> = {}) => renderToStaticMarkup(createElement(StoreContext.Provider,
  { value: { state: { ...initialState, ...state } as AppState, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
const line = (inbox: Message["inbox"], extra: Partial<Message> = {}): Message => ({ id: "m1", role: "bot", kind: "text", text: "The launch moved.", at: 1, inbox, ...extra } as Message);

afterEach(() => setTeamPeople(null));

describe("the team's people in the sidebar", () => {
  it("lists everyone with their face, you first, and says what a click does", () => {
    setTeamPeople(asBen);
    const markup = render(createElement(SidebarPeople, { compact: false }));
    expect(markup).toContain(">People<");
    expect(markup.indexOf("ben@acme.test")).toBeLessThan(markup.indexOf("cleo@acme.test"));
    expect(markup).toMatch(/aria-label="Your inbox: everything sent to you"[^>]*data-person="ben@acme.test"/);
    expect(markup).toContain("Ben (you)");
    expect(markup).toMatch(/aria-label="Write to Cleo"[^>]*data-person="cleo@acme.test"/);
  });

  it("shows nothing off a team, or for a team of one", () => {
    expect(render(createElement(SidebarPeople, { compact: false }))).toBe("");
    setTeamPeople({ ...asBen, people: [BEN] });
    expect(render(createElement(SidebarPeople, { compact: false }))).toBe("");
  });

  it("counts the asks waiting on you on your inbox row, and shows no count when none wait", () => {
    setTeamPeople(asBen);
    const inbox = (openAsks?: number) => bot({ id: "mc", name: "Ben's Chief", chiefOfStaff: true, reportsTo: BEN.email,
      tasks: [{ threadId: "inbox", title: "Inbox", createdAt: 1, inbox: true, ...(openAsks ? { openAsks } : {}) }] });
    const waiting = render(createElement(SidebarPeople, { compact: false }), { bots: [inbox(2)] });
    expect(waiting).toMatch(/aria-label="Your inbox: waiting on you, 2"[^>]*data-person="ben@acme.test"/);
    expect(waiting).toMatch(/data-inbox-waiting="2"[^>]*>2<\/span>/);
    expect(render(createElement(SidebarPeople, { compact: true }), { bots: [inbox(2)] }), "on the rail too").toContain('data-inbox-waiting="2"');
    const none = render(createElement(SidebarPeople, { compact: false }), { bots: [inbox()] });
    expect(none).toContain('aria-label="Your inbox: everything sent to you"');
    expect(none).not.toContain("data-inbox-waiting");
  });

  it("refreshes Needs you as soon as an ask in the inbox is answered or closed", () => {
    const tasks = (openAsks?: number) => [bot({ id: "mc", tasks: [{ threadId: "inbox", title: "Inbox", createdAt: 1, inbox: true, ...(openAsks ? { openAsks } : {}) }] })];
    expect(needsYouVersion(tasks(1), [], [])).not.toBe(needsYouVersion(tasks(), [], []));
    expect(needsYouVersion(tasks(2), [], [])).toBe(needsYouVersion(tasks(2), [], []));
  });

  it("finds the person's inbox with their own Chief, else their own MausBot", () => {
    const mausbot = bot({ id: "mm", name: "MausBot", defaultBot: { person: BEN.email } });
    const chief = bot({ id: "mc", name: "Ben's Chief", chiefOfStaff: true, reportsTo: BEN.email });
    const cleos = bot({ id: "pc", chiefOfStaff: true, reportsTo: CLEO.email });
    expect(inboxBotOf([mausbot, cleos, chief], BEN.email)?.id).toBe("mc");
    expect(inboxBotOf([mausbot, cleos], BEN.email)?.id).toBe("mm");
    expect(inboxBotOf([cleos], BEN.email)).toBeUndefined();
  });
});

describe("a line in the inbox", () => {
  it("says who it is from, through which bot, and offers the conversation it came from", () => {
    setTeamPeople(asBen);
    const markup = render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Cleo", email: CLEO.email }, via: { botId: "scout", name: "Scout" },
      origin: { botId: "scout", threadId: "scout-main", title: "Scout" }, replies: true }) }));
    expect(markup).toContain('data-inbox-line="message"');
    expect(markup).toContain("From Cleo");
    expect(markup).toContain("· via Scout");
    expect(markup).toMatch(/<button[^>]*aria-label="Open Scout"[^>]*>· in Scout<\/button>/);
    const hidden = render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Cleo", email: CLEO.email }, replies: true }) }));
    expect(hidden).not.toContain("<button");
  });

  it("leaves a question's copy, and an approval's while it waits, to the card's own header, which links back", () => {
    setTeamPeople(asBen);
    const ask = { kind: "ask" as const, from: { name: "Ledger", botId: "ledger" }, origin: { botId: "ledger", threadId: "work", title: "Fix" } };
    const message = (card: Partial<NonNullable<Message["card"]>>) => line(ask, { kind: "options",
      card: { title: "", subtitle: "git push", options: [], requestId: "r1", ...card } as Message["card"] });
    const caption = (card: Partial<NonNullable<Message["card"]>>) => render(createElement(InboxCaption, { message: message(card) }));
    expect(caption({ requestType: "question", options: ["Yes", "No"] })).toBe("");
    expect(caption({ tool: "Bash" })).toBe("");
    expect(caption({ tool: "Bash", answered: "allow" })).toContain("From Ledger");
    expect(caption({ tool: "Bash", expired: true })).toContain("From Ledger");
    const pending = pendingApprovals([message({ tool: "Bash" })])[0]!;
    const dock = render(createElement(PendingApprovalPanel, { pending, count: 1, index: 0, asker: { name: "Ledger", color: "teal" } }));
    expect(dock).toMatch(/<button[^>]*aria-label="Open Fix"[^>]*>· in Fix<\/button>/);
  });

  it("names the sender's assistant on its answer, and shows what yours answered with the way to correct it", () => {
    setTeamPeople(asBen);
    expect(render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Cleo", email: CLEO.email }, assistant: true }) }))).toContain("Cleo&#x27;s assistant");
    const answered = render(createElement(InboxAnswers, { message: line({ kind: "message", from: { name: "Cleo" }, answers: [
      { by: "person", text: "Fine.", at: 1 }, { by: "assistant", text: "Ben is free after 16:00.", at: 2 },
    ] }) }));
    expect(answered).toContain("Your assistant answered");
    expect(answered).toContain("Ben is free after 16:00.");
    expect(answered).not.toContain("Fine.");
    expect(answered).toContain("Reply to correct it.");
    expect(render(createElement(InboxAnswers, { message: line({ kind: "message", from: { name: "Cleo" }, answers: [{ by: "person", text: "Fine.", at: 1 }] }) }))).toBe("");
  });

  it("labels an answer that came back from someone's inbox with who answered", () => {
    setTeamPeople(asBen);
    expect(render(createElement(RelayLabel, { message: line(undefined, { role: "user", relay: { kind: "reply", email: BEN.email, name: "Ben" } }) }))).toContain("Ben replied");
    expect(render(createElement(RelayLabel, { message: line(undefined, { role: "user", relay: { kind: "assistant", email: BEN.email, name: "Ben" } }) }))).toContain("Ben&#x27;s assistant answered");
    expect(render(createElement(RelayLabel, { message: line(undefined, { relay: { kind: "told", email: BEN.email, name: "Ben" } }) }))).toBe("");
  });
});
