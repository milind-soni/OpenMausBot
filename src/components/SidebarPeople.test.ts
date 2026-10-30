import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import { needsYouVersion, setTeamPeople, type TeamPeople } from "@/state/team-people";

import { InboxAnswers, InboxCaption, RelayLabel } from "./InboxLine";
import { inboxBotOf, SidebarPeople } from "./SidebarPeople";
import { pendingApprovals, PendingApprovalPanel } from "./PendingApproval";

const PHILIPP = { email: "philipp@acme.test", name: "Philipp", role: "owner" };
const MARCO = { email: "marco@acme.test", name: "Marco", role: "member", you: true as const };
const asMarco: TeamPeople = { people: [PHILIPP, MARCO], me: MARCO, admin: false, needsYou: [] };

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
    setTeamPeople(asMarco);
    const markup = render(createElement(SidebarPeople, { compact: false }));
    expect(markup).toContain(">People<");
    expect(markup.indexOf("marco@acme.test")).toBeLessThan(markup.indexOf("philipp@acme.test"));
    expect(markup).toMatch(/aria-label="Your inbox: everything sent to you"[^>]*data-person="marco@acme.test"/);
    expect(markup).toContain("Marco (you)");
    expect(markup).toMatch(/aria-label="Write to Philipp"[^>]*data-person="philipp@acme.test"/);
  });

  it("shows nothing off a team, or for a team of one", () => {
    expect(render(createElement(SidebarPeople, { compact: false }))).toBe("");
    setTeamPeople({ ...asMarco, people: [MARCO] });
    expect(render(createElement(SidebarPeople, { compact: false }))).toBe("");
  });

  it("counts the asks waiting on you on your inbox row, and shows no count when none wait", () => {
    setTeamPeople(asMarco);
    const inbox = (openAsks?: number) => bot({ id: "mc", name: "Marco's Chief", chiefOfStaff: true, reportsTo: MARCO.email,
      tasks: [{ threadId: "inbox", title: "Inbox", createdAt: 1, inbox: true, ...(openAsks ? { openAsks } : {}) }] });
    const waiting = render(createElement(SidebarPeople, { compact: false }), { bots: [inbox(2)] });
    expect(waiting).toMatch(/aria-label="Your inbox: waiting on you, 2"[^>]*data-person="marco@acme.test"/);
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
    const mausbot = bot({ id: "mm", name: "MausBot", defaultBot: { person: MARCO.email } });
    const chief = bot({ id: "mc", name: "Marco's Chief", chiefOfStaff: true, reportsTo: MARCO.email });
    const philipps = bot({ id: "pc", chiefOfStaff: true, reportsTo: PHILIPP.email });
    expect(inboxBotOf([mausbot, philipps, chief], MARCO.email)?.id).toBe("mc");
    expect(inboxBotOf([mausbot, philipps], MARCO.email)?.id).toBe("mm");
    expect(inboxBotOf([philipps], MARCO.email)).toBeUndefined();
  });
});

describe("a line in the inbox", () => {
  it("says who it is from, through which bot, and offers the conversation it came from", () => {
    setTeamPeople(asMarco);
    const markup = render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Philipp", email: PHILIPP.email }, via: { botId: "scout", name: "Scout" },
      origin: { botId: "scout", threadId: "scout-main", title: "Scout" }, replies: true }) }));
    expect(markup).toContain('data-inbox-line="message"');
    expect(markup).toContain("From Philipp");
    expect(markup).toContain("· via Scout");
    expect(markup).toMatch(/<button[^>]*aria-label="Open Scout"[^>]*>· in Scout<\/button>/);
    const hidden = render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Philipp", email: PHILIPP.email }, replies: true }) }));
    expect(hidden).not.toContain("<button");
  });

  it("leaves a question's copy, and an approval's while it waits, to the card's own header, which links back", () => {
    setTeamPeople(asMarco);
    const ask = { kind: "ask" as const, from: { name: "Biber", botId: "biber" }, origin: { botId: "biber", threadId: "work", title: "Fix" } };
    const message = (card: Partial<NonNullable<Message["card"]>>) => line(ask, { kind: "options",
      card: { title: "", subtitle: "git push", options: [], requestId: "r1", ...card } as Message["card"] });
    const caption = (card: Partial<NonNullable<Message["card"]>>) => render(createElement(InboxCaption, { message: message(card) }));
    expect(caption({ requestType: "question", options: ["Ja", "Nein"] })).toBe("");
    expect(caption({ tool: "Bash" })).toBe("");
    expect(caption({ tool: "Bash", answered: "allow" })).toContain("From Biber");
    expect(caption({ tool: "Bash", expired: true })).toContain("From Biber");
    const pending = pendingApprovals([message({ tool: "Bash" })])[0]!;
    const dock = render(createElement(PendingApprovalPanel, { pending, count: 1, index: 0, asker: { name: "Biber", color: "teal" } }));
    expect(dock).toMatch(/<button[^>]*aria-label="Open Fix"[^>]*>· in Fix<\/button>/);
  });

  it("names the sender's assistant on its answer, and shows what yours answered with the way to correct it", () => {
    setTeamPeople(asMarco);
    expect(render(createElement(InboxCaption, { message: line({ kind: "message", from: { name: "Philipp", email: PHILIPP.email }, assistant: true }) }))).toContain("Philipp&#x27;s assistant");
    const answered = render(createElement(InboxAnswers, { message: line({ kind: "message", from: { name: "Philipp" }, answers: [
      { by: "person", text: "Fine.", at: 1 }, { by: "assistant", text: "Marco is free after 16:00.", at: 2 },
    ] }) }));
    expect(answered).toContain("Your assistant answered");
    expect(answered).toContain("Marco is free after 16:00.");
    expect(answered).not.toContain("Fine.");
    expect(answered).toContain("Reply to correct it.");
    expect(render(createElement(InboxAnswers, { message: line({ kind: "message", from: { name: "Philipp" }, answers: [{ by: "person", text: "Fine.", at: 1 }] }) }))).toBe("");
  });

  it("labels an answer that came back from someone's inbox with who answered", () => {
    setTeamPeople(asMarco);
    expect(render(createElement(RelayLabel, { message: line(undefined, { role: "user", relay: { kind: "reply", email: MARCO.email, name: "Marco" } }) }))).toContain("Marco replied");
    expect(render(createElement(RelayLabel, { message: line(undefined, { role: "user", relay: { kind: "assistant", email: MARCO.email, name: "Marco" } }) }))).toContain("Marco&#x27;s assistant answered");
    expect(render(createElement(RelayLabel, { message: line(undefined, { relay: { kind: "told", email: MARCO.email, name: "Marco" } }) }))).toBe("");
  });
});
