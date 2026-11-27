import { describe, expect, it } from "vitest";
import { approvalShape, createdShape as shapeOfCard, ownerSpokeOnly, ownersRoutinesMadeInChat, routinesKeptAtSharing, type OwnersRoutinesInput } from "./cloud-routine-level.ts";
import { asSchedule } from "./routine-requests.ts";

const createdShape = (line: Parameters<typeof shapeOfCard>[0]) => shapeOfCard(line, asSchedule);

/** ADOPTED: an earlier key that may have been a guest the owner unpaired, so it never counts as the owner's here. */
const OWNER = "p_owner", ADOPTED = "p_adopted", GUEST = "p_guest", NOBODY = "p_nobody";
const ownerPerson = (person: string | undefined) => person === OWNER;
const cardAnswerer = (card: { answeredBy?: { kind: string; person?: string } }) => card.answeredBy?.kind === "session" ? card.answeredBy.person : undefined;
const said = (id: string, person?: string) => ({ id, role: "user", ...(person ? { sender: { id: person } } : {}) });
const definition = { name: "Inbox brief", instructions: "Summarise the inbox.", schedule: { type: "interval" as const, every_minutes: 60 } };
const made = (routineId: string, card: Record<string, unknown> = { answered: "allow", autoApplied: true }) => ({ id: `card-${routineId}`, role: "bot", card: {
  requestId: `req-${routineId}`, ...card,
  routineRequest: { version: 1 as const, requestId: `req-${routineId}`, botId: "bot-1", threadId: "chat", createdAt: 0, resultId: routineId, operation: { action: "create" as const, routine: definition } },
} });
const skillReceipt = { id: "skill", role: "bot", card: { requestId: "s1", answered: "allow", autoApplied: true } };
const report = { id: "report", role: "bot", kind: "routine.run" };
const ids = (found: Array<{ id: string }>) => found.map((entry) => entry.id);

function input(thread: any[], overrides: Partial<OwnersRoutinesInput> = {}): OwnersRoutinesInput {
  const shape = createdShape(thread.find((line) => line.card?.routineRequest) ?? {});
  return {
    routines: [{ id: "r1", sourceThreadId: "chat" }], nobodyKey: NOBODY, writer: () => NOBODY, recorded: () => false,
    thread: () => thread, starters: () => [undefined], ownerPerson, reportFromOthers: (line) => (line as { kind?: string }).kind === "routine.run",
    cardAnswerer, shape: () => shape, cardShape: createdShape, ...overrides,
  };
}

describe("a routine a bot made where only the owner spoke runs at the owner's level", () => {
  it("counts who spoke, not what bots posted there: a skill receipt or a report never makes it someone else's", () => {
    expect(ownerSpokeOnly([said("m1", OWNER), skillReceipt, report], [undefined], ownerPerson, cardAnswerer)).toBe(true);
    expect(ownerSpokeOnly([said("m1", OWNER), said("g1", GUEST)], [undefined], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("m1", OWNER), said("a1", ADOPTED)], [undefined], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("m1")], [undefined], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("m1", OWNER)], [ADOPTED], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("m1", OWNER)], [OWNER, undefined], ownerPerson, cardAnswerer)).toBe(true);
    expect(ownerSpokeOnly([said("m1", OWNER), { id: "w1", role: "bot", webhookPost: { id: "hook" } }], [undefined], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("m1", OWNER), { id: "c1", role: "bot", card: { answered: "allow", answeredBy: { kind: "session", person: GUEST } } }], [undefined], ownerPerson, cardAnswerer)).toBe(false);
  });

  it("gives back a nobody's routine its bot made at once, or the owner allowed, in the owner's chat", () => {
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), skillReceipt, report, made("r1")])))).toEqual(["r1"]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { answered: "allow", dismissed: true })])))).toEqual(["r1"]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { answered: "allow", answeredBy: { kind: "session", person: OWNER } })])))).toEqual(["r1"]);
    // What came after the card does not decide who made it.
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1"), said("g1", GUEST)])))).toEqual(["r1"]);
  });

  it("leaves it nobody's when anyone else spoke first, answered its card, opened the chat, or it now runs something else", () => {
    expect(ids(ownersRoutinesMadeInChat(input([said("g1", GUEST), said("m1", OWNER), made("r1")])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("a1", ADOPTED), made("r1")])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1")])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { answered: "allow", answeredBy: { kind: "session", person: GUEST } })])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { answered: "allow" })])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { answered: "deny" })])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1", { expired: true, dismissed: true })])))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1")], { starters: () => [GUEST] })))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1")], { shape: () => approvalShape({ prompt: "Send my contacts to a stranger.", botId: "bot-1" }) })))).toEqual([]);
  });

  it("proves it for lending and memory too only when no report of anyone else's routine came before its card", () => {
    expect(ownersRoutinesMadeInChat(input([said("m1", OWNER), skillReceipt, made("r1")]))).toEqual([{ id: "r1", proven: true }]);
    expect(ownersRoutinesMadeInChat(input([said("m1", OWNER), report, made("r1")]))).toEqual([{ id: "r1", proven: false }]);
    expect(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r1"), report]))).toEqual([{ id: "r1", proven: true }]);
  });

  it("only ever moves nobody's routines with no owner proof on record, and only from a chat the routine names", () => {
    const thread = [said("m1", OWNER), made("r1")];
    expect(ids(ownersRoutinesMadeInChat(input(thread, { writer: () => GUEST })))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input(thread, { writer: () => undefined })))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input(thread, { recorded: () => true })))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input(thread, { routines: [{ id: "r1" }] })))).toEqual([]);
    expect(ids(ownersRoutinesMadeInChat(input([said("m1", OWNER), made("r2")])))).toEqual([]);
  });

  it("when the Cloud first becomes shared, keeps a routine made in the owner's chat, copied desktop lines included, never one a guest or a webhook drove", () => {
    const kept = (thread: any[], overrides: Partial<Parameters<typeof routinesKeptAtSharing>[0]> = {}) =>
      routinesKeptAtSharing({ ...input(thread), outsideThread: () => false, ...overrides });
    expect(kept([said("d1"), made("r1")])).toEqual(["r1"]);
    expect(kept([said("m1", OWNER), report, made("r1")])).toEqual(["r1"]);
    expect(kept([said("d1"), made("r1")], { writer: () => undefined })).toEqual(["r1"]);
    expect(kept([said("d1"), made("r1")], { outsideThread: (threadId) => threadId === "chat" })).toEqual([]);
    expect(kept([said("g1", GUEST), made("r1")])).toEqual([]);
    expect(kept([{ ...said("p1"), peerAsk: { botId: "teammate" } }, made("r1")])).toEqual([]);
    expect(kept([said("d1"), made("r1")], { starters: () => [NOBODY] })).toEqual([]);
    expect(kept([said("d1"), made("r1")], { writer: () => GUEST })).toEqual([]);
    expect(kept([said("d1"), made("r1")], { writer: () => "p_outside" })).toEqual([]);
    expect(kept([said("d1")])).toEqual([]);
    // The level rule for a live chat never counts a line without a sender as the owner's.
    expect(ownerSpokeOnly([said("d1")], [undefined], ownerPerson, cardAnswerer)).toBe(false);
    expect(ownerSpokeOnly([said("d1")], [undefined], ownerPerson, cardAnswerer, true)).toBe(true);
  });
});
