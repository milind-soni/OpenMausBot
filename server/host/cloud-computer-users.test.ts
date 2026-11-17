import { describe, expect, it } from "vitest";

import { usedByAnotherBot } from "./cloud-computer-users.ts";

const deps = (holders: Record<string, string>, bots: Record<string, string>) => ({
  holder: (resource: string) => (holders[resource] ? { threadId: holders[resource]!, generation: "g1" } : undefined),
  botOfThread: (threadId: string) => bots[threadId] ?? null,
});

describe("a bot's cloud computer held by a running turn", () => {
  it("is free when no turn holds it", () => {
    expect(usedByAnotherBot("bot-a", "bx_1", deps({}, {}))).toBe(false);
  });

  it("is not counted as someone else's when the holder is the bot's own turn, in its chat or a task", () => {
    expect(usedByAnotherBot("bot-a", "bx_1", deps({ "computer:box-bot:bot-a": "chat-a" }, { "chat-a": "bot-a" }))).toBe(false);
    expect(usedByAnotherBot("bot-a", "bx_1", deps({ "computer:box:bx_1": "task-a" }, { "task-a": "bot-a" }))).toBe(false);
  });

  it("counts a room's turn as someone else's, since with room jobs side by side it may be any member, unless it is the turn that asks", () => {
    const room = deps({ "computer:box-bot:bot-a": "room-1" }, {});
    expect(usedByAnotherBot("bot-a", "bx_1", room)).toBe(true);
    expect(usedByAnotherBot("bot-a", "bx_1", room, { threadId: "room-1", generation: "g1" })).toBe(false);
    expect(usedByAnotherBot("bot-a", "bx_1", room, { threadId: "room-1", generation: "g0" })).toBe(true);
  });

  it("is someone else's when another bot's turn holds the computer or the machine", () => {
    expect(usedByAnotherBot("bot-a", "bx_1", deps({ "computer:box:bx_1": "chat-b" }, { "chat-b": "bot-b" }))).toBe(true);
    expect(usedByAnotherBot("bot-a", "bx_1", deps({ "computer:box-bot:bot-a": "chat-b" }, { "chat-b": "bot-b" }))).toBe(true);
  });
});
