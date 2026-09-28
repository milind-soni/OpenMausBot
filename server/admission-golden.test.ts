// Golden freeze of every admission surface's policy (M1). These tables are
// the recorded behavior of the six seams on the day the shared module was
// extracted — not the behavior anyone wishes they had. A failing row means
// a surface's policy changed; pair any intentional change with an update
// here so the diff says so out loud.
//
// The seams' end-to-end shapes (drain batching, head-lift atomicity, 409
// contracts, steer clamps through real engines) are frozen by the existing
// suites: steer-queue.test.ts, channel-queue.test.ts, steer-e2e.test.ts,
// guarded-messages-api.test.ts, and the steered cases in index.test.ts.
import { describe, expect, it } from "vitest";

import { admit } from "./admission.ts";

describe("admission golden tables", () => {
  it("direct-busy: steers plain text into a capable engine, parks everything else", () => {
    const plain = { carriesImages: false, pendingComputerSelection: false, engineCanSteer: true };
    expect(admit("direct-busy", plain)).toEqual({ action: "steer" });
    // Each mechanical clamp alone forces the reasonless busy-thread park.
    expect(admit("direct-busy", { ...plain, carriesImages: true })).toEqual({ action: "queue" });
    expect(admit("direct-busy", { ...plain, pendingComputerSelection: true })).toEqual({ action: "queue" });
    expect(admit("direct-busy", { ...plain, engineCanSteer: false })).toEqual({ action: "queue" });
    expect(admit("direct-busy", {})).toEqual({ action: "queue" });
  });

  it("direct: starts on a free bot, parks behind slots, room turns, and coordination", () => {
    expect(admit("direct", {}, {})).toEqual({ action: "start" });
    expect(admit("direct", {}, { atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("direct", {}, { threadBusy: true })).toEqual({ action: "queue" }); // busy-thread park is reasonless
    expect(admit("direct", {}, { groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("direct", {}, { parksBehindCoordination: true })).toEqual({ action: "queue" }); // #1194 parking is reasonless
    // Capacity outranks a room turn in the receipt; a busy thread and
    // coordination parking never mint a reason.
    expect(admit("direct", {}, { atCapacity: true, groupTurn: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("direct", {}, { threadBusy: true, groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("direct", {}, { parksBehindCoordination: true, groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    // The whole-bot busy flag alone does not park an ordinary direct send.
    expect(admit("direct", {}, { botBusy: true })).toEqual({ action: "start" });
  });

  it("room: a working channel always queues; it never auto-steers", () => {
    expect(admit("room", {}, { roomWorking: true })).toEqual({ action: "queue" });
    expect(admit("room", {}, { roomWorking: false })).toEqual({ action: "start" });
  });

  it("room-steer: only the head of a capable room's queue steers", () => {
    const head = { speakerPresent: true, engineCanSteer: true, isQueueHead: true };
    expect(admit("room-steer", head)).toEqual({ action: "steer" });
    // An incapable room keeps its queue and the request still succeeds.
    expect(admit("room-steer", { ...head, speakerPresent: false })).toEqual({ action: "queue" });
    expect(admit("room-steer", { ...head, engineCanSteer: false })).toEqual({ action: "queue" });
    // A later item refuses with the head-only 409 — but only once a live
    // speaker could actually take the steer (capability is checked first).
    expect(admit("room-steer", { ...head, isQueueHead: false })).toEqual({ action: "refuse", code: "queue-head-only" });
    expect(admit("room-steer", { speakerPresent: false, engineCanSteer: false, isQueueHead: false })).toEqual({ action: "queue" });
  });

  it("guarded: any busy shape refuses guarded_busy; it never queues or steers", () => {
    expect(admit("guarded", {}, {})).toEqual({ action: "start" });
    for (const state of [
      { botBusy: true },
      { threadBusy: true },
      { atCapacity: true },
      { parksBehindCoordination: true },
      { groupTurn: true },
    ]) {
      expect(admit("guarded", {}, state)).toEqual({ action: "refuse", code: "guarded_busy" });
    }
    // Guarded is the strictest surface: the whole-bot busy flag refuses it
    // even though an ordinary direct send would start.
    expect(admit("guarded", {}, { botBusy: true })).toEqual({ action: "refuse", code: "guarded_busy" });
  });

  it("unattended: shares startTurn admission; busy means a missed run, never a queue", () => {
    expect(admit("unattended", {}, { botPresent: true })).toEqual({ action: "start" });
    expect(admit("unattended", {}, { botPresent: true, atCapacity: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("unattended", {}, { botPresent: true, groupTurn: true })).toEqual({ action: "refuse", code: "busy" });
    // A deleted bot is missing even if its schedules say otherwise.
    expect(admit("unattended", {}, { botPresent: false })).toEqual({ action: "refuse", code: "missing" });
    expect(admit("unattended", {}, { botPresent: false, atCapacity: true })).toEqual({ action: "refuse", code: "missing" });
    // One working thread below the limit does not miss a scheduled run.
    expect(admit("unattended", {}, { botPresent: true, threadBusy: true, botBusy: true })).toEqual({ action: "start" });
  });

  it("peer: admits on the landing thread, a slot, and no room turn — never whole-bot idleness", () => {
    expect(admit("peer", {}, {})).toEqual({ action: "start" });
    expect(admit("peer", {}, { threadBusy: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("peer", {}, { atCapacity: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("peer", {}, { groupTurn: true })).toEqual({ action: "refuse", code: "busy" });
    // Another thread working (the whole-bot busy flag) does not block a
    // delegation that lands on a free thread with a free slot.
    expect(admit("peer", {}, { botBusy: true })).toEqual({ action: "start" });
    expect(admit("peer", {}, { parksBehindCoordination: true })).toEqual({ action: "start" });
  });

  it("opened-thread: a bot's self-opened thread queues only behind a slot or room turn", () => {
    expect(admit("opened-thread", {}, {})).toEqual({ action: "start" });
    expect(admit("opened-thread", {}, { atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("opened-thread", {}, { groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("opened-thread", {}, { atCapacity: true, groupTurn: true })).toEqual({ action: "queue", reason: "capacity" });
    // A brand-new thread cannot be busy, so the policy never consults it.
    expect(admit("opened-thread", {}, { threadBusy: true })).toEqual({ action: "start" });
  });
});
