import { describe, expect, it } from "vitest";

import { arrivalDecision, createRunOwners, mayJoinRun, mayRemoveQueued, mayStop, type RunOwnersDeps } from "./run-owner.ts";

const PRIYA = "p_priyapriyapriyapriyapr";
const TOM = "p_tomtomtomtomtomtomtomt";
const priya = { person: PRIYA, name: "Priya" };

describe("the rule", () => {
  it("lets only the asker's own line reach the run where several people write", () => {
    expect(arrivalDecision({ shared: true, asker: priya, from: PRIYA })).toBe("as-today");
    expect(arrivalDecision({ shared: true, asker: priya, from: TOM })).toBe("queue");
    expect(arrivalDecision({ shared: true, asker: priya })).toBe("queue");
    expect(arrivalDecision({ shared: true, asker: null, from: TOM })).toBe("queue");
  });

  it("changes nothing in a private chat or with one person", () => {
    expect(arrivalDecision({ shared: false, asker: priya, from: TOM })).toBe("as-today");
    expect(arrivalDecision({ shared: false, asker: null })).toBe("as-today");
    expect(mayStop({ shared: false, asker: priya, by: { person: TOM, admin: false } })).toBe(true);
    expect(mayRemoveQueued({ shared: false, sender: { name: "Priya", id: PRIYA }, by: { person: TOM, admin: false } })).toBe(true);
    expect(mayJoinRun({ shared: false, asker: priya, senders: [{ name: "Tom", id: TOM }], by: { person: TOM, admin: false } })).toBe(true);
  });

  it("lets the asker or an admin stop a person's run, and anyone who may chat stop a run no person asked for", () => {
    expect(mayStop({ shared: true, asker: priya, by: { person: PRIYA, admin: false } })).toBe(true);
    expect(mayStop({ shared: true, asker: priya, by: { person: TOM, admin: false } })).toBe(false);
    expect(mayStop({ shared: true, asker: priya, by: { admin: false } })).toBe(false);
    expect(mayStop({ shared: true, asker: priya, by: { person: TOM, admin: true } })).toBe(true);
    expect(mayStop({ shared: true, asker: null, by: { person: TOM, admin: false } })).toBe(true);
  });

  it("leaves a waiting line to its writer, and one no person wrote to an admin", () => {
    expect(mayRemoveQueued({ shared: true, sender: { name: "Tom", id: TOM }, by: { person: TOM, admin: false } })).toBe(true);
    expect(mayRemoveQueued({ shared: true, sender: { name: "Tom", id: TOM }, by: { person: PRIYA, admin: true } })).toBe(false);
    expect(mayRemoveQueued({ shared: true, sender: { name: "Slack" }, by: { person: TOM, admin: false } })).toBe(false);
    expect(mayRemoveQueued({ shared: true, by: { person: TOM, admin: true } })).toBe(true);
  });

  it("joins waiting lines to the run only when the asker adds their own", () => {
    expect(mayJoinRun({ shared: true, asker: priya, senders: [{ name: "Priya", id: PRIYA }], by: { person: PRIYA, admin: false } })).toBe(true);
    expect(mayJoinRun({ shared: true, asker: priya, senders: [{ name: "Priya", id: PRIYA }, { name: "Tom", id: TOM }], by: { person: PRIYA, admin: false } })).toBe(false);
    expect(mayJoinRun({ shared: true, asker: priya, senders: [{ name: "Tom", id: TOM }], by: { person: TOM, admin: false } })).toBe(false);
    expect(mayJoinRun({ shared: true, asker: null, senders: [{ name: "Tom", id: TOM }], by: { person: TOM, admin: true } })).toBe(false);
  });
});

describe("who asked", () => {
  const lines = [
    { id: "m1", role: "user", kind: "text", sender: { name: "Priya", id: PRIYA } },
    { id: "m2", role: "user", kind: "text", sender: { name: "Slack" }, relayed: true },
    { id: "m3", role: "user", kind: "text", sender: { name: "Scout" }, peerAsk: { botId: "b" } },
    { id: "m4", role: "user", kind: "text", sender: { name: "Tom", id: TOM }, via: "api" },
  ];
  const owners = (request: ReturnType<RunOwnersDeps["directRequest"]>, room?: string) => createRunOwners({
    shared: () => true, directRequest: () => request, roomRequestMessageId: () => room, isRoom: () => room !== undefined,
    messages: () => lines, personName: (person) => (person === TOM ? "Tom" : undefined), language: () => undefined,
  });

  it("is the person whose own line the run answers", () => {
    expect(owners({ messageId: "m1" }).asker("t")).toEqual(priya);
    expect(owners(undefined, "m1").asker("t")).toEqual(priya);
  });

  it("is nobody for a relayed line, a bot's ask, an API line, a routine or webhook run, and a stopped run", () => {
    for (const messageId of ["m2", "m3", "m4"]) expect(owners({ messageId }).asker("t")).toBeNull();
    expect(owners({ messageId: "m1", automation: { kind: "schedule" } }).asker("t")).toBeNull();
    expect(owners({ messageId: "m1", stopped: true }).asker("t")).toBeNull();
    expect(owners({ origin: { kind: "outside" } }).asker("t")).toBeNull();
  });

  it("is the person work handed on runs for", () => {
    expect(owners({ origin: { kind: "user", request: "check the stock", person: TOM } }).asker("t")).toEqual({ person: TOM, name: "Tom" });
  });

  it("names the asker in the refusal", () => {
    expect(owners({ messageId: "m1" }).stopRefusal("t", { person: TOM, admin: false })).toBe("Only Priya or an admin can stop this.");
    expect(owners({ messageId: "m1" }).stopRefusal("t", { person: PRIYA, admin: false })).toBeNull();
  });
});
