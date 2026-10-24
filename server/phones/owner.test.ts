import { describe, expect, it } from "vitest";

import { cloudHomeLendingRefusal, type CloudLendingTurn } from "../cloud-lending.ts";
import { adoptExistingRoutines, desktopLendingTurn, desktopPhonesOffered, NOT_THE_OWNER, type DesktopTurn } from "./owner.ts";

const ADMIN = "p_admin", MEMBER = "p_member", ROUTINE = "routine-1", WEBHOOK = "webhook-1";
const said = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "user", ...extra });
const reply = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "bot", ...extra });
const card = (answeredBy?: { kind: string; person?: string; name?: string }) =>
  reply("c1", { card: { requestId: "q1", answered: "answer", answeredText: "Yes", ...(answeredBy ? { answeredBy } : {}) } });
/** What server/index.ts hands over off a Cloud home: the Cloud test's own owner, which knows nobody here. */
const base = (overrides: Partial<DesktopTurn> = {}): DesktopTurn => ({
  request: { messageId: "m1", generations: new Set(["g1"]) }, generation: "g1", thread: [said("m1"), reply("r1")],
  ownerPerson: () => false, cardAnswerer: (c) => (c.answeredBy?.kind === "session" ? c.answeredBy.person : undefined),
  routineRun: () => null, reportsFromOthers: true, ...overrides,
});
/** `written`: the routines the owner wrote and nobody has changed since. */
const deps = (overrides: { originIsUser?: boolean; written?: string[] } = {}) => ({
  adminPersons: () => new Set([ADMIN]), originIsUser: () => overrides.originIsUser ?? true,
  ownerWrote: (id: string) => (overrides.written ?? [ROUTINE]).includes(id),
});
const owners = (turn: DesktopTurn, d = deps()) => cloudHomeLendingRefusal(desktopLendingTurn(turn, d)) === null;

describe("whose turn may use the desktop owner's phones", () => {
  it("a line typed at this machine, with no person on it, is the owner's", () => {
    expect(owners(base())).toBe(true);
  });

  it("a live admin session's line is the owner's; a client session's is not", () => {
    expect(owners(base({ thread: [said("m1", { sender: { id: ADMIN } })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1", { sender: { id: MEMBER } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m0", { sender: { id: MEMBER } }), reply("r0"), said("m1")] }))).toBe(false);
    expect(owners(base({ starters: [MEMBER] }))).toBe(false);
    expect(owners(base({ starters: [ADMIN] }))).toBe(true);
  });

  it("a line an external interface relayed is never the owner's, as the request or anywhere in the conversation", () => {
    expect(owners(base({ thread: [said("m1", { relayed: true })] }))).toBe(false);
    expect(owners(base({ thread: [said("m0", { relayed: true }), reply("r0"), said("m1")] }))).toBe(false);
    // Whatever sender it carries: the relay vouches for nobody here.
    expect(owners(base({ thread: [said("m1", { relayed: true, sender: { id: ADMIN } })] }))).toBe(false);
    expect(desktopLendingTurn(base({ thread: [said("m1", { relayed: true })] }), deps()).thread[0]).toMatchObject({ sender: { id: NOT_THE_OWNER } });
  });

  it("a bot's ask is the owner's only as this turn's request, and only while the work it carries came from the user", () => {
    const asked = base({ thread: [said("m1", { peerAsk: { botId: "chief" } })] });
    expect(owners(asked, deps({ originIsUser: true }))).toBe(true);
    expect(owners(asked, deps({ originIsUser: false }))).toBe(false);
    // An earlier ask in the conversation carried work nothing recorded, whatever this turn's origin.
    const earlier = base({ thread: [said("m0", { peerAsk: { botId: "chief" } }), reply("r0"), said("m1")] });
    expect(owners(earlier, deps({ originIsUser: true }))).toBe(false);
    expect(owners(earlier, deps({ originIsUser: false }))).toBe(false);
  });

  it("a card answer is the owner's from this machine or an admin session, never a client session, a worker or an unrecorded session", () => {
    expect(owners(base({ thread: [said("m1"), card({ kind: "loopback" })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Me", person: ADMIN })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Desk", person: MEMBER })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), card({ kind: "worker" })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Old answer" })] }))).toBe(false);
    // Answered, answerer not written yet: whoever is answering right now decides.
    const inFlight = (who: string | undefined) => base({ thread: [said("m1"), card()], cardAnswerer: () => who });
    expect(owners(inFlight(undefined))).toBe(true);
    expect(owners(inFlight(ADMIN))).toBe(true);
    expect(owners(inFlight(MEMBER))).toBe(false);
    expect(owners(inFlight(NOT_THE_OWNER))).toBe(false);
  });

  it("a webhook's posted payload, an outside event's run report and the report of a routine the owner did not write are someone else's words", () => {
    expect(owners(base({ thread: [said("m1"), reply("w1", { webhookPost: true })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { automation: { routineId: WEBHOOK } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { kind: "routine.run", routineRun: { routineId: WEBHOOK } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { automation: { routineId: ROUTINE } })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), reply("a1", { kind: "routine.run", routineRun: { routineId: ROUTINE } })] }))).toBe(true);
    // Written by a client session, or changed by one since the owner wrote it.
    expect(owners(base({ thread: [said("m1"), reply("a1", { automation: { routineId: ROUTINE } })] }), deps({ written: [] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { kind: "routine.run", routineRun: { routineId: ROUTINE } })] }), deps({ written: [] }))).toBe(false);
  });

  it("a routine's run is the owner's only when the owner wrote it, unchanged, and a schedule, a restart or the owner started it", () => {
    type Trigger = "schedule" | "manual" | "startup" | "webhook";
    const runTurn = (triggerSource: Trigger, record: { ownerStarted: boolean; ownerAuthored: boolean }) => desktopLendingTurn(base({
      request: { messageId: "m1", generations: new Set(["g1"]), automation: triggerSource },
      routineRun: () => ({ triggerSource, ...record }),
    }), deps());
    for (const trigger of ["schedule", "startup"] as const) {
      expect(runTurn(trigger, { ownerStarted: false, ownerAuthored: true }).routineRun()).toEqual({ triggerSource: trigger, ownerStarted: true, ownerAuthored: true });
      expect(cloudHomeLendingRefusal(runTurn(trigger, { ownerStarted: false, ownerAuthored: true }))).toBeNull();
      // Someone else wrote it, or changed it since: never the owner's, however it started.
      expect(cloudHomeLendingRefusal(runTurn(trigger, { ownerStarted: true, ownerAuthored: false }))).toBe("not-owner");
    }
    // By hand, only the owner's own start counts.
    expect(cloudHomeLendingRefusal(runTurn("manual", { ownerStarted: true, ownerAuthored: true }))).toBeNull();
    expect(runTurn("manual", { ownerStarted: false, ownerAuthored: true }).routineRun()).toEqual({ triggerSource: "manual", ownerStarted: false, ownerAuthored: true });
    expect(cloudHomeLendingRefusal(runTurn("manual", { ownerStarted: false, ownerAuthored: true }))).toBe("not-owner");
    expect(cloudHomeLendingRefusal(runTurn("manual", { ownerStarted: true, ownerAuthored: false }))).toBe("not-owner");
    expect(runTurn("webhook", { ownerStarted: true, ownerAuthored: true }).routineRun()).toMatchObject({ ownerStarted: false });
    expect(cloudHomeLendingRefusal(runTurn("webhook", { ownerStarted: true, ownerAuthored: true }))).toBe("not-owner");
    const none: CloudLendingTurn = desktopLendingTurn(base(), deps());
    expect(none.routineRun()).toBeNull();
  });
});

describe("where the desktop owner's phones are offered", () => {
  it("only where one person uses the server and a local request is the owner", () => {
    expect(desktopPhonesOffered({ sharedMembership: false, loopbackTrust: "owner" })).toBe(true);
    // Sign-in lets several people in: each admin would reach every admin's phones.
    expect(desktopPhonesOffered({ sharedMembership: true, loopbackTrust: "owner" })).toBe(false);
    // A request from this machine is a service (a hosted workspace's or a headless server's shell), not the owner.
    expect(desktopPhonesOffered({ sharedMembership: false, loopbackTrust: "service" })).toBe(false);
    expect(desktopPhonesOffered({ sharedMembership: true, loopbackTrust: "service" })).toBe(false);
  });
});

describe("routines that were already there when authorship started being recorded", () => {
  const routines = [{ id: "r1", prompt: "Morning brief" }, { id: "r2", prompt: "Stretch reminder" }];
  const run = (overrides: Partial<Parameters<typeof adoptExistingRoutines>[0]> = {}) => {
    const recorded: string[] = []; let persisted = 0;
    const adopted = adoptExistingRoutines({
      recordsExisted: false, offered: true, otherPeople: false, routines,
      record: (routine) => { recorded.push(routine.id); }, persist: () => { persisted += 1; }, ...overrides,
    });
    return { adopted, recorded, persisted };
  };

  it("are the owner's on the first run of a desktop only one person uses, and the record is kept so it never runs again", () => {
    expect(run()).toEqual({ adopted: 2, recorded: ["r1", "r2"], persisted: 1 });
  });

  it("an empty desktop still keeps the record, so a routine someone adds later is never adopted by a later start", () => {
    expect(run({ routines: [] })).toEqual({ adopted: 0, recorded: [], persisted: 1 });
  });

  it("are never adopted once records exist, where phones are not offered, or while any other person has a session here", () => {
    expect(run({ recordsExisted: true })).toEqual({ adopted: 0, recorded: [], persisted: 0 });
    expect(run({ offered: false })).toEqual({ adopted: 0, recorded: [], persisted: 0 });
    expect(run({ otherPeople: true })).toEqual({ adopted: 0, recorded: [], persisted: 0 });
  });
});
