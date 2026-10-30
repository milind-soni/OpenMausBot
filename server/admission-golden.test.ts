// Golden freeze of every admission surface's policy: the recorded behaviour, not the wished-for one. A failing row means a
// surface's policy changed; pair an intentional change with an update here so the diff says so.
import { describe, expect, it } from "vitest";

import { admit, roomTurnHolds } from "./admission.ts";

describe("admission golden tables", () => {
  it("direct-busy: steers plain text into a capable engine, parks everything else", () => {
    const plain = { carriesImages: false, pendingComputerSelection: false, engineCanSteer: true };
    expect(admit("direct-busy", plain)).toEqual({ action: "steer" });
    expect(admit("direct-busy", { ...plain, carriesImages: true })).toEqual({ action: "queue", blockedBy: "images" });
    expect(admit("direct-busy", { ...plain, pendingComputerSelection: true })).toEqual({ action: "queue" });
    expect(admit("direct-busy", { ...plain, engineCanSteer: false })).toEqual({ action: "queue" });
    expect(admit("direct-busy", {})).toEqual({ action: "queue" });
  });

  it("direct-busy: attachments steer into an engine that takes images mid-turn", () => {
    const images = { carriesImages: true, engineCanSteerImages: true, pendingComputerSelection: false, engineCanSteer: true };
    expect(admit("direct-busy", images)).toEqual({ action: "steer" });
    expect(admit("direct-busy", { ...images, engineCanSteer: false })).toEqual({ action: "queue" });
    expect(admit("direct-busy", { ...images, pendingComputerSelection: true })).toEqual({ action: "queue" });
    expect(admit("direct-busy", { ...images, carriesImages: false, engineCanSteerImages: false })).toEqual({ action: "steer" });
  });

  it("direct: starts on a free bot, parks behind slots, room turns, and coordination", () => {
    expect(admit("direct", {}, {})).toEqual({ action: "start" });
    expect(admit("direct", {}, { atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("direct", {}, { threadBusy: true })).toEqual({ action: "queue" });
    expect(admit("direct", {}, { groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("direct", {}, { parksBehindCoordination: true })).toEqual({ action: "queue" });
    expect(admit("direct", {}, { atCapacity: true, groupTurn: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("direct", {}, { threadBusy: true, groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("direct", {}, { parksBehindCoordination: true, groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("direct", {}, { botBusy: true })).toEqual({ action: "start" });
  });

  it("a room turn holds a person's own send only on the room's own thread", () => {
    const room = { threadId: "room-thread" };
    expect(roomTurnHolds(room, "person-thread", true)).toBe(false);
    expect(roomTurnHolds(room, "room-thread", true)).toBe(true);
    expect(roomTurnHolds(null, "person-thread", true)).toBe(false);
    expect(roomTurnHolds(undefined, "room-thread", false)).toBe(false);
    // Delegations, opened threads, incidents and routines still wait for any room turn of the bot.
    expect(roomTurnHolds(room, "person-thread", false)).toBe(true);
  });

  it("direct: capacity, the landing thread and coordination still queue a person's send beside a room turn", () => {
    const elsewhere = { groupTurn: roomTurnHolds({ threadId: "room-thread" }, "person-thread", true) };
    expect(admit("direct", {}, elsewhere)).toEqual({ action: "start" });
    expect(admit("direct", {}, { ...elsewhere, atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("direct", {}, { ...elsewhere, threadBusy: true })).toEqual({ action: "queue" });
    expect(admit("direct", {}, { ...elsewhere, parksBehindCoordination: true })).toEqual({ action: "queue" });
    expect(admit("direct", {}, { groupTurn: roomTurnHolds({ threadId: "room-thread" }, "room-thread", true) }))
      .toEqual({ action: "queue", reason: "group-turn" });
  });

  it("room: a working channel always queues; it never auto-steers", () => {
    expect(admit("room", {}, { roomWorking: true })).toEqual({ action: "queue" });
    expect(admit("room", {}, { roomWorking: false })).toEqual({ action: "start" });
    expect(admit("room", {}, { roomWorking: true, threadWorking: false })).toEqual({ action: "start" });
    expect(admit("room", {}, { roomWorking: true, threadWorking: true })).toEqual({ action: "queue" });
  });

  it("room-steer: only the head of a capable room's queue steers", () => {
    const head = { speakerPresent: true, engineCanSteer: true, isQueueHead: true };
    expect(admit("room-steer", head)).toEqual({ action: "steer" });
    expect(admit("room-steer", { ...head, speakerPresent: false })).toEqual({ action: "queue" });
    expect(admit("room-steer", { ...head, engineCanSteer: false })).toEqual({ action: "queue" });
    expect(admit("room-steer", { ...head, isQueueHead: false })).toEqual({ action: "refuse", code: "queue-head-only" });
    expect(admit("room-steer", { speakerPresent: false, engineCanSteer: false, isQueueHead: false })).toEqual({ action: "queue" });
  });

  it("room-steer: an attachment head steers only into a speaker that takes images mid-turn", () => {
    const head = { speakerPresent: true, engineCanSteer: true, isQueueHead: true, carriesImages: true };
    expect(admit("room-steer", { ...head, engineCanSteerImages: true })).toEqual({ action: "steer" });
    expect(admit("room-steer", head)).toEqual({ action: "queue", blockedBy: "images" });
    expect(admit("room-steer", { ...head, isQueueHead: false })).toEqual({ action: "queue", blockedBy: "images" });
    expect(admit("room-steer", { ...head, engineCanSteerImages: true, isQueueHead: false })).toEqual({ action: "refuse", code: "queue-head-only" });
    expect(admit("room-steer", { ...head, engineCanSteer: false })).toEqual({ action: "queue" });
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
    expect(admit("guarded", {}, { botBusy: true })).toEqual({ action: "refuse", code: "guarded_busy" });
  });

  it("unattended: shares startTurn admission; busy means a missed run, never a queue", () => {
    expect(admit("unattended", {}, { botPresent: true })).toEqual({ action: "start" });
    expect(admit("unattended", {}, { botPresent: true, atCapacity: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("unattended", {}, { botPresent: true, groupTurn: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("unattended", {}, { botPresent: false })).toEqual({ action: "refuse", code: "missing" });
    expect(admit("unattended", {}, { botPresent: false, atCapacity: true })).toEqual({ action: "refuse", code: "missing" });
    expect(admit("unattended", {}, { botPresent: true, threadBusy: true, botBusy: true })).toEqual({ action: "start" });
  });

  it("peer: admits on the landing thread, a slot, and no room turn — never whole-bot idleness", () => {
    expect(admit("peer", {}, {})).toEqual({ action: "start" });
    expect(admit("peer", {}, { threadBusy: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("peer", {}, { atCapacity: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("peer", {}, { groupTurn: true })).toEqual({ action: "refuse", code: "busy" });
    expect(admit("peer", {}, { botBusy: true })).toEqual({ action: "start" });
    expect(admit("peer", {}, { parksBehindCoordination: true })).toEqual({ action: "start" });
  });

  it("opened-thread: a bot's self-opened thread queues only behind a slot or room turn", () => {
    expect(admit("opened-thread", {}, {})).toEqual({ action: "start" });
    expect(admit("opened-thread", {}, { atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("opened-thread", {}, { groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("opened-thread", {}, { atCapacity: true, groupTurn: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("opened-thread", {}, { threadBusy: true })).toEqual({ action: "start" });
  });

  it("incident: a report to the Chief's reused incidents thread queues behind anything and is never refused", () => {
    expect(admit("incident", {}, {})).toEqual({ action: "start" });
    expect(admit("incident", {}, { threadBusy: true })).toEqual({ action: "queue" });
    expect(admit("incident", {}, { atCapacity: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("incident", {}, { groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("incident", {}, { parksBehindCoordination: true })).toEqual({ action: "start" });
    expect(admit("incident", {}, { threadBusy: true, atCapacity: true, groupTurn: true })).toEqual({ action: "queue", reason: "capacity" });
    expect(admit("incident", {}, { threadBusy: true, groupTurn: true })).toEqual({ action: "queue", reason: "group-turn" });
    expect(admit("incident", {}, { botBusy: true })).toEqual({ action: "start" });
  });
});
