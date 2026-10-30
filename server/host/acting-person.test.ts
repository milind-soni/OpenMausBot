import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OUTSIDE, workOriginSchema, type WorkOrigin } from "../peer-provenance.ts";
import { personKey } from "../person-key.ts";
import { createActingPeople, HandedPeople, onlyTheirs, privateHandBack, withPerson, type ActingLine, type DirectRequest, type RoomRun } from "./acting-person.ts";

const ADA = personKey({ id: "", email: "ada@acme.test" });
const BEN = personKey({ id: "", email: "ben@acme.test" });
const said = (id: string, at: number, person: string | undefined, more: Partial<ActingLine> = {}): ActingLine =>
  ({ id, at, role: "user", ...(person ? { sender: { id: person } } : {}), ...more });
const botLine = (id: string, at: number): ActingLine => ({ id, at, role: "bot" });
const ask = (id: string, at: number): ActingLine => ({ id, at, role: "user", peerAsk: { botId: "chief" } });
const userOrigin = (person?: string): WorkOrigin => ({ kind: "user", request: "File the notes in Notion", ...(person ? { person } : {}) });

function world(options: { threads?: Record<string, ActingLine[]>; rooms?: string[]; direct?: Record<string, DirectRequest>; runs?: Record<string, RoomRun> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-acting-person-"));
  const handed = new HandedPeople(join(dir, "handed-people.json"));
  const people = createActingPeople({
    store: { groupByThread: (threadId) => (options.rooms ?? []).includes(threadId) || undefined, messagesFor: (threadId) => options.threads?.[threadId] ?? [] },
    direct: (threadId) => options.direct?.[threadId],
    roomRun: (generation) => options.runs?.[generation],
    handed,
  });
  return { people, handed, dir };
}
const request = (generation: string, more: Partial<DirectRequest> = {}): DirectRequest => ({ generation, generations: new Set([generation]), ...more });

describe("a turn started by a person's own line acts for them", () => {
  it("in any one-on-one conversation, for that turn generation only, until it is stopped", () => {
    const thread = [said("m1", 10, ADA), botLine("b1", 11)];
    const { people } = world({ threads: { t: thread }, direct: { t: request("g1", { messageId: "m1" }) } });
    expect(people.requester("t", "g1")).toBe(ADA);
    expect(people.requester("t"), "the latest generation when none is named").toBe(ADA);
    expect(people.requester("t", "g0"), "another generation proves nothing").toBeNull();
    expect(world({ threads: { t: thread }, direct: { t: request("g1", { messageId: "m1", stopped: true }) } }).people.requester("t", "g1")).toBeNull();
  });

  it("never for a routine, a bot's message or a line nobody can be named for", () => {
    expect(world({ threads: { t: [said("m1", 10, ADA)] }, direct: { t: request("g1", { messageId: "m1", automation: "schedule" }) } }).people.requester("t", "g1"), "a routine's run").toBeNull();
    expect(world({ threads: { t: [ask("m1", 10)] }, direct: { t: request("g1", { messageId: "m1" }) } }).people.requester("t", "g1"), "a bot's line").toBeNull();
    expect(world({ threads: { t: [said("m1", 10, undefined)] }, direct: { t: request("g1", { messageId: "m1" }) } }).people.requester("t", "g1")).toBeNull();
    expect(world({ threads: { t: [said("m1", 10, "not-a-person-key")] }, direct: { t: request("g1", { messageId: "m1" }) } }).people.requester("t", "g1")).toBeNull();
  });

  it("stops acting for them once someone else's words join it: a line sent in, or an answer to one of its cards", () => {
    const base = [said("m0", 5, BEN), said("m1", 10, ADA), botLine("b1", 11)];
    const direct = { t: request("g1", { messageId: "m1" }) };
    expect(world({ threads: { t: base }, direct }).people.requester("t", "g1"), "what was said before her request is context, not a join").toBe(ADA);
    expect(world({ threads: { t: [...base, said("s1", 12, ADA, { steered: true })] }, direct }).people.requester("t", "g1"), "her own follow-up").toBe(ADA);
    expect(world({ threads: { t: [...base, said("s1", 12, BEN, { steered: true })] }, direct }).people.requester("t", "g1"), "Ben's line sent into her turn").toBeNull();
    expect(world({ threads: { t: [...base, said("s1", 12, undefined, { steered: true })] }, direct }).people.requester("t", "g1"), "a line from someone the server can't name").toBeNull();
    const card = (person: string) => ({ id: "c1", at: 12, role: "bot", card: { answered: "yes", answeredBy: { kind: "session", person } } });
    expect(world({ threads: { t: [...base, card(ADA)] }, direct }).people.requester("t", "g1")).toBe(ADA);
    expect(world({ threads: { t: [...base, card(BEN)] }, direct }).people.requester("t", "g1"), "Ben answered her turn's card").toBeNull();
    const dismissed = { id: "c2", at: 12, role: "bot", card: { dismissed: true, answeredBy: { kind: "session", person: BEN } } };
    expect(world({ threads: { t: [...base, dismissed] }, direct }).people.requester("t", "g1"), "a card the harness settled carries nobody's words").toBe(ADA);
  });
});

describe("a room run acts for the person whose room line began it", () => {
  const room = { rooms: ["room"] };
  it("for the run's own turn generations, and never once the run is stopped", () => {
    const thread = [said("m0", 5, BEN), said("m1", 10, ADA)];
    expect(world({ ...room, threads: { room: thread }, runs: { g1: { requestMessageId: "m1", cancelled: false } } }).people.requester("room", "g1")).toBe(ADA);
    expect(world({ ...room, threads: { room: thread }, runs: { g1: { requestMessageId: "m1", cancelled: false } } }).people.requester("room", "g2")).toBeNull();
    expect(world({ ...room, threads: { room: thread }, runs: { g1: { requestMessageId: "m1", cancelled: false } } }).people.requester("room"), "a room needs its turn generation").toBeNull();
    expect(world({ ...room, threads: { room: thread }, runs: { g1: { requestMessageId: "m1", cancelled: true } } }).people.requester("room", "g1")).toBeNull();
    expect(world({ ...room, threads: { room: [...thread, said("m2", 20, BEN)] }, runs: { g1: { requestMessageId: "m2", cancelled: false } } }).people.requester("room", "g1"), "Ben's own room line is Ben's").toBe(BEN);
    expect(world({ ...room, threads: { room: thread }, runs: { g1: { requestMessageId: "m0", cancelled: false } } }).people.requester("room", "g1"), "Ada wrote in the room after Ben's line began his run").toBeNull();
  });

  it("joins queued lines only when every one is theirs", () => {
    const own = [said("q1", 10, ADA, { queueId: "a" }), said("q2", 11, ADA, { queueId: "b" })];
    const mixed = [said("q1", 10, BEN, { queueId: "a" }), said("q2", 11, ADA, { queueId: "b" })];
    const run: RoomRun = { requestMessageId: "q2", cancelled: false, queuedQueueIds: ["a", "b"] };
    expect(world({ ...room, threads: { room: own }, runs: { g1: run } }).people.requester("room", "g1")).toBe(ADA);
    expect(world({ ...room, threads: { room: mixed }, runs: { g1: run } }).people.requester("room", "g1"), "Ben's queued line ran in the same turn").toBeNull();
  });

  it("acts for the person handed-on work was handed on for, until someone else writes in the room", () => {
    const run: RoomRun = { cancelled: false, handedFor: { person: ADA, since: 20 } };
    expect(world({ ...room, threads: { room: [said("m0", 5, BEN), ask("a1", 20)] }, runs: { g1: run } }).people.requester("room", "g1")).toBe(ADA);
    expect(world({ ...room, threads: { room: [ask("a1", 20), said("m2", 21, BEN)] }, runs: { g1: run } }).people.requester("room", "g1")).toBeNull();
    expect(world({ ...room, threads: { room: [] }, runs: { g1: { cancelled: false } } }).people.requester("room", "g1"), "a room run nobody started").toBeNull();
  });
});

describe("work handed on acts for whoever the turn that handed it on acted for", () => {
  it("records it once as the work is handed on, and the receiving turn acts for them", () => {
    const { people } = world({ threads: { ada: [said("m1", 10, ADA)] }, direct: { ada: request("root-1", { messageId: "m1" }) } });
    people.handOn({ threadId: "ada", generation: "root-1" }, { id: "node-1", rootId: "root-1" });
    expect(people.handedOrigin(userOrigin(), "node-1")).toEqual(userOrigin(ADA));
    expect(people.handedOrigin(userOrigin(BEN), "root-1"), "the turn that handed it on is kept too, for a restart").toEqual(userOrigin(ADA));
    expect(people.handedOrigin(OUTSIDE, "node-1"), "outside work never carries a person").toEqual(OUTSIDE);
    expect(people.handedOrigin(userOrigin(BEN), "node-unknown"), "work nobody recorded acts for nobody").toEqual(userOrigin());
    expect(people.handedRun("node-1")).toEqual({ person: ADA, since: expect.any(Number) });
  });

  it("a delegated turn acts for its person only while nobody else has written in its conversation", () => {
    const direct = { work: request("g2", { messageId: "a1", origin: userOrigin(ADA) }) };
    expect(world({ threads: { work: [ask("a1", 20), botLine("b1", 21)] }, direct }).people.requester("work", "g2")).toBe(ADA);
    expect(world({ threads: { work: [said("x", 1, BEN), ask("a1", 20)] }, direct }).people.requester("work", "g2"), "Ben wrote in this work thread").toBeNull();
    expect(world({ threads: { work: [ask("a1", 20)] }, direct: { work: request("g2", { messageId: "a1", origin: userOrigin() }) } }).people.requester("work", "g2"), "handed on for nobody").toBeNull();
    expect(world({ threads: { work: [ask("a1", 20)] }, direct: { work: request("g2", { messageId: "a1", origin: OUTSIDE }) } }).people.requester("work", "g2")).toBeNull();
  });

  it("never lets Ben's chain hand on Ada: each piece of work keeps the person of the turn that handed it on", () => {
    const { people } = world({
      threads: { ada: [said("m1", 10, ADA)], ben: [said("m2", 11, BEN)], routine: [said("r1", 12, undefined)] },
      direct: { ada: request("ga", { messageId: "m1" }), ben: request("gb", { messageId: "m2" }), routine: request("gr", { messageId: "r1", automation: "schedule" }) },
    });
    people.handOn({ threadId: "ada", generation: "ga" }, { id: "from-ada", rootId: "ga" });
    people.handOn({ threadId: "ben", generation: "gb" }, { id: "from-ben", rootId: "gb" });
    people.handOn({ threadId: "routine", generation: "gr" }, { id: "from-routine", rootId: "gr" });
    people.handOn({ threadId: "ben", generation: "gb" }, { id: "from-ada", rootId: "ga" });
    expect(people.handedRun("from-ada")?.person, "recorded once: a later hand-on of the same work changes nothing").toBe(ADA);
    expect(people.handedRun("from-ben")?.person).toBe(BEN);
    expect(people.handedRun("from-routine"), "a routine's work acts for nobody").toBeUndefined();
  });
});

describe("the record of handed-on work", () => {
  it("survives a restart, in a file only the server reads", () => {
    const { handed, dir } = world();
    handed.record("node-1", ADA);
    const file = join(dir, "handed-people.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new HandedPeople(file).get("node-1")?.person).toBe(ADA);
    expect(readFileSync(file, "utf8")).not.toContain("ada@acme.test");
  });

  it("holds nobody when its file is damaged, and refuses ids and people it can't read", () => {
    const { dir } = world();
    const file = join(dir, "handed-people.json");
    writeFileSync(file, JSON.stringify({ v: 1, work: { "node-1": { person: "someone", at: 1 } } }));
    expect(new HandedPeople(file).get("node-1")).toBeUndefined();
    writeFileSync(file, "{not json");
    const handed = new HandedPeople(file);
    handed.record("../escape", ADA);
    handed.record("node-2", "p_short");
    handed.record("node-3", null);
    expect([handed.get("../escape"), handed.get("node-2"), handed.get("node-3")]).toEqual([undefined, undefined, undefined]);
  });

  it("forgets work handed on more than thirty days ago", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-acting-person-"));
    let now = 1_000;
    const handed = new HandedPeople(join(dir, "handed-people.json"), () => now);
    handed.record("old", ADA);
    now += 31 * 24 * 60 * 60_000;
    handed.record("new", BEN);
    expect(handed.get("old")).toBeUndefined();
    expect(handed.get("new")?.person).toBe(BEN);
  });
});

describe("the person on a handed-on origin", () => {
  it("is set only on a person's own request, and only to a person's key", () => {
    expect(withPerson(userOrigin(), ADA)).toEqual(userOrigin(ADA));
    expect(withPerson(userOrigin(ADA), null)).toEqual(userOrigin());
    expect(withPerson(userOrigin(), "someone")).toEqual(userOrigin());
    expect(withPerson(OUTSIDE, ADA)).toEqual(OUTSIDE);
  });

  it("is kept when a queued handed-on message is read back, and dropped when it is not a person's key", () => {
    expect(workOriginSchema.parse(userOrigin(ADA))).toEqual(userOrigin(ADA));
    expect(workOriginSchema.safeParse({ ...userOrigin(), person: "../ada" }).success).toBe(false);
  });

  it("counts only words that came after the request", () => {
    const thread = [said("m0", 5, BEN), said("m1", 10, ADA), said("m2", 15, BEN)];
    expect(onlyTheirs(thread, ADA, 10)).toBe(false);
    expect(onlyTheirs(thread.slice(0, 2), ADA, 10)).toBe(true);
  });
});

describe("what work in one person's private chat hands back", () => {
  const place = (parent: string | null) => ({ child: ADA, parent, bot: "Helper", person: "Ada" });
  const done = { ok: true, text: "Ada's latest email: the Q3 salary review.", evidence: { summary: "read 1 email from the board" } };

  it("to a chat others read: only where the result is, never the result or what was observed", () => {
    expect(privateHandBack(done, place(null))).toEqual({ ok: true, text: "Done. The result is in Helper's chat with Ada." });
    expect(privateHandBack({ ok: false, text: "Gmail said the board's thread is gone." }, place(null)).text).toBe("It stopped before it finished. The result is in Helper's chat with Ada.");
    expect(privateHandBack(done, place(BEN)).text, "another person's private chat reads none of hers").toBe("Done. The result is in Helper's chat with Ada.");
  });

  it("keeps a question a question, with its words left in her chat", () => {
    const asked = privateHandBack({ ok: true, text: "Found two.\nNEEDS INPUT: Forward the salary review to Ben?", cards: { question: "Forward the salary review to Ben?", ids: ["c1"] } }, place(null));
    expect(asked).toEqual({ ok: true, text: "NEEDS INPUT: Helper has a question for Ada, in Helper's chat with Ada.", cards: { question: "Helper has a question for Ada, in Helper's chat with Ada.", ids: ["c1"] }, privateQuestion: true });
    expect(privateHandBack({ ok: true, text: "Found two.\nNEEDS INPUT: Forward it to Ben?" }, place(null)), "only she can answer it").toMatchObject({ privateQuestion: true });
  });

  it("hands everything back into her own private chat, and anything from a chat others read already", () => {
    expect(privateHandBack(done, place(ADA))).toBe(done);
    expect(privateHandBack(done, { child: null, parent: null, bot: "Helper", person: "them" })).toBe(done);
  });
});
