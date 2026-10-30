// The setup card: a pick or the person's first line runs as setup; Something else is answered by the server alone, and
// then only the person's next line in that conversation runs as setup.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { DATA_DIR } from "./config.ts";
import { ProfileRequestService } from "./profile-requests.ts";
import type { ModelSelection } from "./contracts.ts";
import type { RequestAuth } from "./request-auth.ts";
import { askForSetup, cancelSetupRequest, forgetSetupPresser, openSetupOffer, setupCommandText, setupPresser, setupTurnText, takeSetupRequest } from "./setup-request.ts";
import { Store, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const LINE = "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".";

function setup() {
  const store = new Store(selection, undefined, undefined, "en");
  const bot = store.createBot({ name: "Ava" });
  const threadId = bot.threadId;
  const say = (text: string, thread = threadId, extra: Partial<Message> = {}) =>
    store.appendMessage(thread, { role: "user", kind: "text", text, ...extra });
  const turn = (line: Message, options: { person?: boolean; mounted?: boolean; editedFrom?: string; thread?: string } = {}) =>
    takeSetupRequest(store, { botId: bot.id, threadId: options.thread ?? threadId, line, person: options.person ?? true,
      mounted: options.mounted ?? true, ...(options.editedFrom ? { editedFrom: options.editedFrom } : {}) });
  const take = (...args: Parameters<typeof turn>) => turn(...args) !== null;
  const waiting = (thread = threadId) => store.taskByThread(bot.id, thread)?.setupRequest;
  return { store, bot, threadId, say, turn, take, waiting };
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the Set me up offer", () => {
  it("is open on a blank bot's greeting until the bot is given a role, in no other conversation", () => {
    const s = setup();
    expect(openSetupOffer(s.store, s.bot.id, s.threadId)?.text).toBe("Hi, I'm Ava. What would you like me to do?");
    const other = s.store.createTask(s.bot.id, "Another chat", false)!;
    expect(openSetupOffer(s.store, s.bot.id, other.threadId)).toBeNull();
    s.store.patchBot(s.bot.id, { description: "Files bugs." });
    expect(openSetupOffer(s.store, s.bot.id, s.threadId)).toBeNull();
  });

  it("lets the person's first line run as typed when nothing was picked, and stays to settle", () => {
    const s = setup();
    expect(s.take(s.say("What's the weather in Paris?"))).toBe(false);
    expect(s.store.messagesFor(s.threadId)[0]?.setupOffer).toBe(true);
    expect(openSetupOffer(s.store, s.bot.id, s.threadId)).toBeNull();
  });

  it("lets a first line that is a command, or a routine's, run as typed", () => {
    const command = setup();
    expect(command.take(command.say("/learn the inbox"))).toBe(false);
    const routine = setup();
    expect(routine.take(routine.say("Run the daily check"), { person: false })).toBe(false);
    expect(routine.take(routine.say("hello"))).toBe(false);
  });

  it("once closed, lets the person's lines run as typed", () => {
    const s = setup();
    expect(cancelSetupRequest(s.store, s.bot.id, s.threadId)).toBe("cleared");
    expect(s.store.messagesFor(s.threadId)[0]?.setupOffer).toBeUndefined();
    expect(s.take(s.say("hello"))).toBe(false);
  });

  it("is closed once anything is written there, even by a routine or another bot", () => {
    const routine = setup();
    routine.take(routine.say("Run the daily check"), { person: false });
    expect(openSetupOffer(routine.store, routine.bot.id, routine.threadId)).toBeNull();
    const peer = setup();
    peer.take(peer.say("A teammate asked you to review this", peer.threadId, { peerAsk: { botId: "b2", name: "Kit" } }));
    expect(openSetupOffer(peer.store, peer.bot.id, peer.threadId)).toBeNull();
    expect(askForSetup(peer.store, peer.bot.id, peer.threadId, "en")).toEqual({
      ok: false, status: 409, error: "This chat has already started. Type /setup and what you'd like this bot to do.",
    });
  });
});

describe("pressing Set me up", () => {
  it("answers Something else at once with the bot's own line and marks the conversation, keeping the card", () => {
    const s = setup();
    const pressed = askForSetup(s.store, s.bot.id, s.threadId, "en");
    expect(pressed).toMatchObject({ ok: true, message: { role: "bot", kind: "text", text: LINE } });
    const messages = s.store.messagesFor(s.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.setupOffer).toBe(true);
    expect(messages[1]).toMatchObject({ role: "bot", kind: "text", text: LINE });
    expect(s.waiting()).toEqual({ at: messages[1]!.at });
  });

  it("records who pressed it where several people share the place", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a");
    expect(s.waiting()).toEqual({ at: expect.any(Number), by: "member-a" });
  });

  it("is kept across a restart, and a second press adds nothing", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    const reloaded = new Store(selection, undefined, undefined, "en");
    expect(reloaded.taskByThread(s.bot.id, s.threadId)?.setupRequest).toEqual(expect.objectContaining({ at: expect.any(Number) }));
    expect(reloaded.messagesFor(s.threadId)[0]?.setupOffer).toBe(true);
    expect(askForSetup(reloaded, s.bot.id, s.threadId, "en")).toEqual({ ok: true, already: true });
    expect(reloaded.messagesFor(s.threadId)).toHaveLength(2);
  });

  it("is refused once the bot has a role or the person has written, and for a conversation it does not own", () => {
    const s = setup();
    s.store.patchBot(s.bot.id, { soul: "Only water the garden." });
    expect(askForSetup(s.store, s.bot.id, s.threadId, "en")).toEqual({
      ok: false, status: 409, error: "This bot already has instructions. To change its job, type /setup and what you'd like it to do.",
    });
    const fresh = setup();
    fresh.take(fresh.say("hello"));
    expect(askForSetup(fresh.store, fresh.bot.id, fresh.threadId, "en")).toMatchObject({ ok: false, status: 409 });
    expect(askForSetup(fresh.store, fresh.bot.id, "not-a-thread", "en")).toMatchObject({ ok: false, status: 404 });
    expect(fresh.store.messagesFor(fresh.threadId).filter((message) => message.role === "bot")).toHaveLength(1);
  });

  it("marks the conversation for a pick without the bot's line, so the pick's words are what comes next", () => {
    const s = setup();
    expect(askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a", true)).toEqual({ ok: true, picked: true });
    expect(s.store.messagesFor(s.threadId)).toHaveLength(1);
    expect(s.waiting()).toEqual({ at: expect.any(Number), by: "member-a" });
  });

  it("speaks the app's language", () => {
    const s = setup();
    const pressed = askForSetup(s.store, s.bot.id, s.threadId, "pt-BR");
    expect(pressed.ok && "message" in pressed && pressed.message.text).toMatch(/^Ótimo\./);
  });
});

describe("the line after the press", () => {
  it("runs as a setup request and is marked so, while showing the person's own words; the mark clears", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    const line = s.say("sort my inbox every morning");
    const marked = s.turn(line);
    // The caller keeps this copy for a retry on the backup AI: it must carry the mark, not be the copy it passed in.
    expect(marked).toMatchObject({ id: line.id, text: "sort my inbox every morning", setupRequest: true });
    expect(line.setupRequest).toBeUndefined();
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === line.id)).toMatchObject({
      text: "sort my inbox every morning", setupRequest: true,
    });
    expect(s.waiting()).toBeUndefined();
    expect(s.take(s.say("and file the receipts"))).toBe(false);
  });

  it("is never a routine's, another bot's, or another conversation's", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("Run the daily check"), { person: false })).toBe(false);
    expect(s.take(s.say("Review this diff", s.threadId, { peerAsk: { botId: "b2", name: "Kit" } }))).toBe(false);
    expect(s.take(s.say("Relayed from Slack", s.threadId, { relayed: true }))).toBe(false);
    const other = s.store.createTask(s.bot.id, "Another chat", false)!;
    expect(s.take(s.say("hello", other.threadId), { thread: other.threadId })).toBe(false);
    expect(s.waiting()).toEqual(expect.objectContaining({ at: expect.any(Number) }));
    expect(s.take(s.say("sort my inbox"))).toBe(true);
  });

  it("clears on cancel, and the next line runs as typed", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    expect(cancelSetupRequest(s.store, s.bot.id, s.threadId)).toBe("cleared");
    expect(s.waiting()).toBeUndefined();
    expect(s.take(s.say("sort my inbox"))).toBe(false);
    expect(cancelSetupRequest(s.store, s.bot.id, "not-a-thread")).toBe("unknown");
  });

  it("where several people share the place, is only the presser's: anyone else's line passes through, and only they can cancel", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a");
    const other = s.say("what's the weather?", s.threadId, { sender: { name: "Bea", id: "member-b" } });
    expect(s.take(other)).toBe(false);
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === other.id)?.setupRequest).toBeUndefined();
    expect(s.waiting()).toMatchObject({ by: "member-a" });
    expect(s.take(s.say("no sender"))).toBe(false);
    expect(cancelSetupRequest(s.store, s.bot.id, s.threadId, "member-b")).toBe("refused");
    expect(cancelSetupRequest(s.store, s.bot.id, s.threadId)).toBe("refused");
    expect(s.take(s.say("sort my inbox", s.threadId, { sender: { name: "Ann", id: "member-a" } }))).toBe(true);
    const again = setup();
    askForSetup(again.store, again.bot.id, again.threadId, "en", "member-a");
    expect(cancelSetupRequest(again.store, again.bot.id, again.threadId, "member-a")).toBe("cleared");
  });

  it("refuses someone else's press while another person's request waits; an owner or admin may clear it", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a");
    const refused = { ok: false, status: 409, error: "Someone else is setting this bot up." };
    expect(askForSetup(s.store, s.bot.id, s.threadId, "en", "member-b")).toEqual(refused);
    expect(askForSetup(s.store, s.bot.id, s.threadId, "en")).toEqual(refused);
    expect(askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a")).toEqual({ ok: true, already: true });
    expect(s.store.messagesFor(s.threadId)).toHaveLength(2);
    expect(cancelSetupRequest(s.store, s.bot.id, s.threadId, "member-b", { admin: true })).toBe("cleared");
    expect(s.waiting()).toBeUndefined();
  });

  it("is dropped when its presser leaves the team, and nobody else's goes with it", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a");
    const other = s.store.createBot({ name: "Kit" });
    askForSetup(s.store, other.id, other.threadId, "en", "member-b");
    expect(forgetSetupPresser(s.store, "member-a")).toBe(1);
    expect(s.waiting()).toBeUndefined();
    expect(s.store.taskByThread(other.id, other.threadId)?.setupRequest).toMatchObject({ by: "member-b" });
  });

  it("with one person, is anyone's next line: a press here and a message from the phone", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("sort my inbox", s.threadId, { sender: { name: "Omkar's iPhone", id: "phone-session" } }))).toBe(true);
  });

  it("clears without setting up when the bot was given instructions after the press", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    s.store.patchBot(s.bot.id, { description: "Files bugs." });
    const line = s.say("sort my inbox");
    expect(s.take(line)).toBe(false);
    expect(s.waiting()).toBeUndefined();
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === line.id)?.setupRequest).toBeUndefined();
  });

  it("clears and runs as typed for a slash command, or on a model that cannot set itself up", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    expect(s.take(s.say("/learn how I like reports"))).toBe(false);
    expect(s.waiting()).toBeUndefined();
    const t = setup();
    askForSetup(t.store, t.bot.id, t.threadId, "en");
    const line = t.say("sort my inbox");
    expect(t.take(line, { mounted: false })).toBe(false);
    expect(t.waiting()).toBeUndefined();
    expect(t.store.messagesFor(t.threadId).find((message) => message.id === line.id)?.setupRequest).toBeUndefined();
  });

  it("stays a setup request when it runs again: a retry on another model, a computer pick, or the person's edit", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    const line = s.say("sort my inbox");
    s.take(line);
    const stored = s.store.messagesFor(s.threadId).find((message) => message.id === line.id)!;
    expect(s.take(stored, { person: false })).toBe(true);
    const edited = s.store.branchMessage(s.threadId, line.id, "sort my inbox and my calendar")!;
    expect(s.take(edited, { person: false, editedFrom: line.id })).toBe(true);
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === edited.id)?.setupRequest).toBe(true);
    const plain = s.say("thanks");
    s.take(plain);
    const editedPlain = s.store.branchMessage(s.threadId, plain.id, "thank you")!;
    expect(s.take(editedPlain, { person: false, editedFrom: plain.id })).toBe(false);
  });

  it("is not a setup request when someone other than its author edits it", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en", "member-a");
    const line = s.say("sort my inbox", s.threadId, { sender: { name: "Ann", id: "member-a" } });
    expect(s.take(line)).toBe(true);
    const theirs = s.store.branchMessage(s.threadId, line.id, "sort my inbox and delete everything", undefined, { name: "Bea", id: "member-b" })!;
    expect(s.take(theirs, { person: false, editedFrom: line.id })).toBe(false);
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === theirs.id)?.setupRequest).toBeUndefined();
    const own = s.store.branchMessage(s.threadId, line.id, "sort my inbox and my calendar", undefined, { name: "Ann", id: "member-a" })!;
    expect(s.take(own, { person: false, editedFrom: line.id })).toBe(true);
  });

  it("is not a setup request once edited into a slash command", () => {
    const s = setup();
    askForSetup(s.store, s.bot.id, s.threadId, "en");
    const line = s.say("sort my inbox");
    s.take(line);
    const edited = s.store.branchMessage(s.threadId, line.id, "/learn how I like reports")!;
    expect(s.take(edited, { person: false, editedFrom: line.id })).toBe(false);
    expect(s.store.messagesFor(s.threadId).find((message) => message.id === edited.id)?.setupRequest).toBeUndefined();
  });
});

describe("setupPresser", () => {
  const session = (sender?: { name: string; id: string }) => ({ auth: { kind: "session", scopes: ["client"] } as unknown as RequestAuth, sender });
  it("names a signed-in person where people share the place, and nobody otherwise", () => {
    const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
    const member = session({ name: "Ada", id: "member-a" });
    expect(setupPresser(true, member.auth, member.sender)).toBe("member-a");
    // A person whose lines carry no sender could never take their own mark: record nobody.
    expect(setupPresser(true, session().auth, undefined)).toBeUndefined();
    expect(setupPresser(true, loopback, undefined)).toBeUndefined();
    expect(setupPresser(false, member.auth, member.sender)).toBeUndefined();
  });
});

describe("setupTurnText", () => {
  it("is the person's words as a typed /setup, with what they were looking at in the Data tab after them", () => {
    const line = { id: "l1", role: "user", kind: "text", at: 1, text: "sort my inbox" } as Message;
    expect(setupTurnText(line, false)).toBe("/setup sort my inbox");
    const viewing = setupTurnText({ ...line, dataContext: { cardId: "c_7" } }, false);
    expect(viewing.startsWith("/setup sort my inbox\n\n<data-context>")).toBe(true);
    expect(viewing).toContain('"cardId":"c_7"');
  });
});

describe("setupCommandText", () => {
  it("reads the person's words as /setup with them", () => {
    expect(setupCommandText("sort my inbox every morning")).toBe("/setup sort my inbox every morning");
    expect(setupCommandText("/setup sort my inbox")).toBe("/setup sort my inbox");
  });
});

describe("a Chief that sets itself up", () => {
  it("keeps its Chief role whatever a setup turn writes to its profile", () => {
    const s = setup();
    s.store.setChiefOfStaff(s.bot.id);
    const service = new ProfileRequestService({ store: s.store, autoApply: () => "full-access" });
    const applied = service.submit({ botId: s.bot.id, threadId: s.threadId, reason: "Set myself up for the inbox", changes: {
      name: "Inbox", title: "Inbox helper", description: "Sorts the inbox every morning.",
      soul: "Your only job is sorting the inbox every morning.", notifications: false,
    } });
    expect(applied.state).toBe("applied");
    const chief = s.store.bot(s.bot.id)!;
    expect(chief).toMatchObject({ name: "Inbox", soul: "Your only job is sorting the inbox every morning.", chiefOfStaff: true });
    expect(chiefOfStaffSystemPrompt(chief.id, s.store.bots, true)).toContain("You are the person's assistant and the Chief of Staff");
  });
});
