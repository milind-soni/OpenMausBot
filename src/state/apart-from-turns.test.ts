import { describe, expect, it } from "vitest";
import { sameBotApartFromTurns, sameBotsApartFromTurns, sameGroupsApartFromTurns } from "./apart-from-turns";
import { initialState, reducer, type Bot, type Group, type Message } from "./store";

const bot = (id: string, patch: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "test", model: "m" }, messages: [], tasks: [{ threadId: `${id}-thread`, title: "Chat", createdAt: 1 }], ...patch,
} as Bot);
const room = (patch: Partial<Group> = {}): Group => ({
  id: "room", threadId: "room-thread", name: "Planning", memberIds: ["a"], defaultResponder: { kind: "member", botId: "a" },
  bulletin: "", unread: false, createdAt: 1, messages: [], ...patch,
} as Group);

describe("a bot list kept across turns", () => {
  it("is the same through a turn: a message, busy, unread and the thread stamps", () => {
    const before = { ...initialState, bots: [bot("a"), bot("b")] };
    const message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 5 } as Message;
    const added = reducer(before, { type: "messageAdded", threadId: "b-thread", message });
    const busy = reducer(added, { type: "botPatched", bot: { ...bot("b"), busy: true, activity: "working", unread: true, tasks: [{ threadId: "b-thread", title: "Chat", createdAt: 1, updatedAt: 5 }] } });
    expect(busy.bots).not.toBe(before.bots);
    expect(sameBotsApartFromTurns(before.bots, added.bots)).toBe(true);
    expect(sameBotsApartFromTurns(before.bots, busy.bots)).toBe(true);
  });

  it("differs when anything a reader draws changes, even in a new object of the same shape", () => {
    const bots = [bot("a"), bot("b")];
    expect(sameBotsApartFromTurns(bots, [bot("a"), bot("b")])).toBe(true);
    expect(sameBotsApartFromTurns(bots, [bot("a"), bot("b", { name: "Bea" })])).toBe(false);
    expect(sameBotsApartFromTurns(bots, [bot("a"), bot("b", { modelSelection: { instanceId: "test", model: "n" } })])).toBe(false);
    expect(sameBotsApartFromTurns(bots, [bot("a"), bot("b", { section: "Sales" })])).toBe(false);
    expect(sameBotsApartFromTurns(bots, [bot("b"), bot("a")]), "order").toBe(false);
    expect(sameBotsApartFromTurns(bots, [bot("a")]), "a bot gone").toBe(false);
  });

  it("compares one bot the same way, and an absent one only with an absent one", () => {
    expect(sameBotApartFromTurns(bot("a"), bot("a", { busy: true, messages: [{ id: "x" } as Message] }))).toBe(true);
    expect(sameBotApartFromTurns(bot("a"), bot("a", { color: "blue" }))).toBe(false);
    expect(sameBotApartFromTurns(undefined, undefined)).toBe(true);
    expect(sameBotApartFromTurns(bot("a"), undefined)).toBe(false);
  });

  it("keeps a room list through a room's turn, not through a rename", () => {
    expect(sameGroupsApartFromTurns([room()], [room({ messages: [{ id: "x" } as Message], unread: true, busyBotId: "a", working: true })])).toBe(true);
    expect(sameGroupsApartFromTurns([room()], [room({ name: "Review" })])).toBe(false);
  });
});
