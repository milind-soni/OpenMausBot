import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import { memberAudience, roomAudience, type Audience } from "../audience.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message, StoreChange } from "../store.ts";
import { createTeamMessages, MESSAGE_PERSON_HOURLY, TEAM_MESSAGES_FILE } from "./team-messages.ts";

const key = (email: string) => personKey({ id: "", email });
const ADA = { email: "ada@acme.test", role: "admin" as const, name: "Ada" };
const BOB = { email: "bob@acme.test", role: "member" as const, name: "Bob Stone" };
const OLIVE = { email: "olive@acme.test", role: "owner" as const, name: "Olive" };
const CARL = { email: "carl@acme.test", role: "member" as const, name: "Carl", leftAt: 5 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const session = (email: string) => ({ kind: "session", scopes: ["client"], session: { id: email, email } }) as unknown as RequestAuth;

function fixture(options: { team?: boolean; hiddenFrom?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-messages-"));
  dirs.push(dataDir);
  const listeners = new Set<(change: StoreChange) => void>();
  const emit = (change: StoreChange) => { for (const listener of listeners) listener(change); };
  const threads = new Map<string, Message[]>();
  const audiences = new Map<string, Audience>([["ada-private", memberAudience(key(ADA.email))], ["room-thread", roomAudience("room")]]);
  const bots = [{ id: "scout", name: "Scout", color: "blue", threadId: "scout-main", tasks: [
    { threadId: "scout-main", title: "Scout" }, { threadId: "ada-private", title: "Ada and Scout" },
  ] as Array<{ threadId: string; title: string; archivedAt?: number }> }];
  const groups = [{ id: "room", name: "Launch", threadId: "room-thread", memberIds: ["scout"] }];
  const roomPeople = new Set([key(ADA.email), key(BOB.email)]);
  let made = 0, ids = 0;
  const unread: string[] = [];
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    botByThread: (threadId: string) => bots.find((bot) => bot.tasks.some((task) => task.threadId === threadId)) ?? null,
    groupByThread: (threadId: string) => groups.find((group) => group.threadId === threadId),
    taskByThread: (botId: string, threadId: string) => bots.find((bot) => bot.id === botId)?.tasks.find((task) => task.threadId === threadId),
    createTask: (botId: string, title: string) => {
      const task = { threadId: `made-${++made}`, title };
      bots.find((bot) => bot.id === botId)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      emit({ type: "message", threadId, message: full });
      return full;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      const rows = threads.get(threadId)!;
      const index = rows.findIndex((row) => row.id === id);
      rows[index] = { ...rows[index]!, ...patch };
      emit({ type: "message.patch", threadId, message: rows[index]! });
    },
    patchTask: (_botId: string, threadId: string) => { unread.push(threadId); return null; },
    patchGroup: (id: string) => { unread.push(id); return null; },
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const people: Array<{ email: string; role: "owner" | "admin" | "member"; name: string; leftAt?: number }> = [ADA, BOB, OLIVE, CARL];
  const notified: Notification[] = [];
  const team = createTeamMessages({
    team: options.team === false ? null : { id: "team-acme", name: "Acme" },
    dataDir,
    store: store as never,
    people: { everyone: () => people.map(({ email, role, leftAt }) => ({ email, role, firstSeenAt: 1, lastSeenAt: 1, ...(leftAt ? { leftAt } : {}) })) },
    personName: (person) => people.find((one) => key(one.email) === person)?.name,
    audienceOf: (threadId) => audiences.get(threadId) ?? "team",
    starters: { set: (threadId, person) => { audiences.set(threadId, memberAudience(person)); } },
    sees: (person) => ({
      bot: () => !(options.hiddenFrom ?? []).includes(person.email),
      thread: (threadId) => {
        const audience = audiences.get(threadId) ?? "team";
        if (audience === "team") return true;
        if (audience.startsWith("room:")) return person.role !== "member" || roomPeople.has(key(person.email));
        return audience === memberAudience(key(person.email));
      },
    }),
    notify: (notification) => { notified.push(notification); },
  });
  const lines = (threadId: string) => threads.get(threadId) ?? [];
  const said = (threadId: string, text: string, from: string) => store.appendMessage(threadId, { role: "user", kind: "text", text, sender: { name: from, id: key(`${from.toLowerCase()}@acme.test`) } });
  return { team, store, lines, notified, unread, said, bots, audiences, dataDir };
}

describe("message_person", () => {
  it("passes a private chat's message to a teammate in a new private conversation with the same bot, and nothing else", () => {
    const f = fixture();
    f.said("ada-private", "My salary review is Friday. Also tell Bob the launch moved to Friday.", "Ada");
    const passed = f.team.pass("scout", "ada-private", "Bob", "The launch moved to Friday.");
    expect(passed.status).toBe(200);
    expect(passed.text).toContain("private conversation");
    const made = f.bots[0]!.tasks.at(-1)!;
    expect(made).toMatchObject({ threadId: "made-1", title: "From Ada" });
    expect(f.audiences.get("made-1")).toBe(memberAudience(key(BOB.email)));
    expect(f.lines("made-1").map((row) => row.text)).toEqual(["Ada asked me to pass this on: The launch moved to Friday."]);
    expect(f.lines("made-1")[0]!.relay).toEqual({ kind: "from", email: ADA.email, name: "Ada" });
    expect(JSON.stringify(f.lines("made-1"))).not.toContain("salary");
    expect(f.lines("ada-private").at(-1)).toMatchObject({ kind: "activity", tool: { name: "Told Bob Stone", ok: true, output: "The launch moved to Friday." }, relay: { kind: "told", email: BOB.email } });
    expect(f.notified).toEqual([expect.objectContaining({ kind: "mention", threadId: "made-1", forPerson: key(BOB.email), title: "Message from Ada via Scout" })]);
    expect(f.team.needsYou(session(BOB.email))).toEqual([expect.objectContaining({ kind: "message", threadId: "made-1", from: "Ada", fromEmail: ADA.email, text: "The launch moved to Friday." })]);
    expect(f.team.needsYou(session(ADA.email))).toEqual([]);
    expect(f.team.needsYou(session(OLIVE.email))).toEqual([]);
    expect(f.unread).toContain("made-1");
  });

  it("keeps one conversation per asking conversation and person, and remembers it across a restart", () => {
    const f = fixture();
    f.team.pass("scout", "ada-private", "bob@acme.test", "First.");
    f.team.pass("scout", "ada-private", "bob stone", "Second.");
    expect(f.bots[0]!.tasks.filter((task) => task.title === "From Ada")).toHaveLength(1);
    expect(f.lines("made-1").map((row) => row.text)).toEqual(["Ada asked me to pass this on: First.", "Ada asked me to pass this on: Second."]);
    expect(JSON.parse(readFileSync(join(f.dataDir, TEAM_MESSAGES_FILE), "utf8")).relays).toHaveLength(1);
  });

  it("brings the answer back into the conversation that asked, and only there", () => {
    const f = fixture();
    f.team.pass("scout", "ada-private", "Bob", "Can you review the deck?");
    f.notified.length = 0;
    f.said("made-1", "Yes, tell Ada I'll do it tonight", "Bob");
    const back = f.team.pass("scout", "made-1", "Ada", "Bob will review the deck tonight.");
    expect(back).toMatchObject({ status: 200, text: expect.stringContaining("Passed back to Ada") });
    expect(f.lines("ada-private").at(-1)).toMatchObject({ role: "bot", kind: "text", text: "Bob Stone replied: Bob will review the deck tonight.", relay: { kind: "reply", email: BOB.email } });
    expect(f.notified).toEqual([expect.objectContaining({ threadId: "ada-private", forPerson: key(ADA.email), title: "Bob Stone replied via Scout" })]);
    expect(f.lines("made-1").at(-1)).toMatchObject({ kind: "activity", relay: { kind: "told", email: ADA.email } });
    expect(f.bots[0]!.tasks.filter((task) => task.threadId.startsWith("made-"))).toHaveLength(1);
  });

  it("tags a teammate who can see the conversation right there", () => {
    const f = fixture();
    f.said("scout-main", "Let Bob know the numbers are in", "Ada");
    const passed = f.team.pass("scout", "scout-main", "Bob", "the numbers are in.");
    expect(passed.text).toContain("can see this conversation");
    expect(f.lines("scout-main").at(-1)).toMatchObject({ role: "bot", kind: "text", text: "@Bob Stone the numbers are in." });
    expect(f.bots[0]!.tasks.some((task) => task.threadId.startsWith("made-"))).toBe(false);
    expect(f.notified).toEqual([expect.objectContaining({ threadId: "scout-main", forPerson: key(BOB.email), title: "Message from Ada via Scout" })]);
  });

  it("refuses plainly: someone who left, nobody by that name, two of that name, the person themselves, a bot they can't use", () => {
    const f = fixture({ hiddenFrom: [OLIVE.email] });
    expect(f.team.pass("scout", "ada-private", "Carl", "Hi")).toEqual({ status: 410, text: "Carl has left Acme, so nothing can be passed to them any more. Tell the person." });
    expect(f.team.pass("scout", "ada-private", "Zed", "Hi")).toMatchObject({ status: 404, text: expect.stringContaining("The people here: Ada, Bob Stone, Olive.") });
    expect(f.team.pass("scout", "ada-private", "Ada", "Hi")).toMatchObject({ status: 400 });
    expect(f.team.pass("scout", "ada-private", "Olive", "Hi")).toMatchObject({ status: 403, text: expect.stringContaining("can't use Scout") });
    expect(f.team.pass("scout", "elsewhere", "Bob", "Hi")).toMatchObject({ status: 403 });
    expect(f.notified).toEqual([]);
    expect(f.lines("ada-private")).toEqual([]);
  });

  it(`passes at most ${MESSAGE_PERSON_HOURLY} messages an hour from one conversation, and refusals spend none`, () => {
    const f = fixture();
    f.team.pass("scout", "ada-private", "Carl", "Refused, so free.");
    for (let i = 0; i < MESSAGE_PERSON_HOURLY; i += 1) expect(f.team.pass("scout", "ada-private", "Bob", `Note ${i}`).status).toBe(200);
    expect(f.team.pass("scout", "ada-private", "Bob", "One more")).toMatchObject({ status: 429 });
    expect(f.team.pass("scout", "scout-main", "Bob", "Another conversation has its own").status).toBe(200);
  });

  it("does not exist off a team", async () => {
    const f = fixture({ team: false });
    let answered: { status: number; body: unknown } | null = null;
    await f.team.internal({ method: "POST", path: "/api/internal/people/message", res: {} as never, botId: "scout", threadId: "scout-main",
      json: ((_res: unknown, status: number, body: unknown) => { answered = { status, body }; }) as never, readBody: async () => ({ to: "Bob", message: "Hi" }) });
    expect(answered).toMatchObject({ status: 404 });
    expect(f.team.prompt("scout", "scout-main", true)).toBe("");
    f.said("scout-main", "@Bob look", "Ada");
    expect(f.notified).toEqual([]);
  });
});

describe("a teammate's @mention", () => {
  it("notifies only the tagged person, where they can see it, with a Needs you line that goes once they open it", () => {
    const f = fixture();
    const line = f.said("scout-main", "@Bob Stone can you check the numbers? @Olive too", "Ada");
    expect(f.notified.map((one) => [one.forPerson, one.title])).toEqual([
      [key(BOB.email), "Ada mentioned you in Scout"], [key(OLIVE.email), "Ada mentioned you in Scout"],
    ]);
    expect(f.team.needsYou(session(BOB.email))).toEqual([expect.objectContaining({ kind: "message", messageId: line.id, from: "Ada", fromEmail: ADA.email })]);
    expect(f.team.needsYou(session(ADA.email))).toEqual([]);
    f.team.seen(session(BOB.email), "scout-main");
    expect(f.team.needsYou(session(BOB.email))).toEqual([]);
    f.said("scout-main", "On it", "Olive");
    expect(f.team.needsYou(session(OLIVE.email))).toEqual([]);
  });

  it("tags nobody who cannot see the conversation, and not the writer", () => {
    const f = fixture();
    f.said("ada-private", "@Bob should get this through you", "Ada");
    f.said("scout-main", "Note to self @Ada", "Ada");
    f.said("room-thread", "@Olive and @Bob, the room", "Ada");
    expect(f.notified.map((one) => one.forPerson)).toEqual([key(OLIVE.email), key(BOB.email)]);
  });

  it("reads a bot's settled reply once, by first name too, and never tells twice in the same turn", () => {
    const f = fixture();
    const reply = f.store.appendMessage("scout-main", { role: "bot", kind: "text", text: "Done. @Bob please review, and @Olive FYI.", turnId: "t1" });
    expect(f.notified).toEqual([]);
    f.store.patchMessage("scout-main", reply.id, { turnTerminal: true, turnSucceeded: true });
    f.store.patchMessage("scout-main", reply.id, { reactions: [] });
    expect(f.notified.map((one) => [one.forPerson, one.title])).toEqual([[key(BOB.email), "Scout mentioned you"], [key(OLIVE.email), "Scout mentioned you"]]);
    const fromScout = f.team.needsYou(session(BOB.email));
    expect(fromScout).toEqual([expect.objectContaining({ kind: "message", from: "Scout" })]);
    expect(fromScout[0], "a bot has no teammate's face").not.toHaveProperty("fromEmail");

    f.notified.length = 0;
    f.team.pass("scout", "scout-main", "Bob", "here is the link");
    const second = f.store.appendMessage("scout-main", { role: "bot", kind: "text", text: "Told @Bob.", turnId: "t2" });
    f.store.patchMessage("scout-main", second.id, { turnSucceeded: true });
    expect(f.notified.map((one) => one.forPerson)).toEqual([key(BOB.email)]);
  });
});

describe("what a bot is told", () => {
  it("names the team's people but the one it talks with, and in a passed-on conversation who to answer", () => {
    const f = fixture();
    const own = f.team.prompt("scout", "ada-private", true);
    expect(own).toContain('"Bob Stone", "Olive" (owner)');
    expect(own).not.toContain('"Ada"');
    expect(own).not.toContain("Carl");
    expect(own).toContain("message_person");
    expect(f.team.prompt("scout", "ada-private", false)).toBe("");
    f.team.pass("scout", "ada-private", "Bob", "Ping");
    const delivered = f.team.prompt("scout", "made-1", true);
    expect(delivered).toContain('began when "Ada" asked you to pass a message on');
    expect(delivered).toContain('message_person to "Ada"');
  });
});
