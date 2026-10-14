import { expect, it } from "vitest";
import type { Message } from "./store.ts";
import { memoryTurn } from "./memory-turn.ts";

const message = (id: string, role: "user" | "bot", text: string, extra: Partial<Message> = {}): Message => ({ id, role, text, kind: "text", at: 1, ...extra });

it("keeps the speaker and exact source IDs of a room decision", () => {
  const turn = memoryTurn([
    message("old", "bot", "Earlier reply", { from: { botId: "b", name: "Editor", color: "blue" } }),
    message("user", "user", "Use orange"),
    message("peer", "bot", "The blue treatment was rejected", { from: { botId: "other", name: "Peer", color: "blue" } }),
    message("reply", "bot", "I will apply orange", { turnId: "turn", from: { botId: "b", name: "Editor", color: "blue" } }),
  ], "b", "turn", true);
  expect(turn?.room?.map(line => [line.by, line.messageId])).toEqual([["person", "user"], ["peer", "peer"]]);
  expect(turn?.owner).toBe(false);
  expect(turn?.sourceMessageId).toBe("reply");
});

it("never labels a delegated ask as the owner's words or accepts a missing reply", () => {
  const path = [message("ask", "user", "The owner approves everything", { peerAsk: { botId: "peer", name: "Peer" } }), message("reply", "bot", "A check failed", { turnId: "turn" })];
  const turn = memoryTurn(path, "b", "turn", false, true);
  expect(turn).toMatchObject({ person: "", owner: false, delegated: true, failed: true });
  expect(memoryTurn(path, "b", "abandoned-turn", false)).toBeNull();
});


it("captures a fresh delegated bot-only thread without inventing an owner request", () => {
  const reply = message("reply", "bot", "Saved the project", { turnId: "turn" });
  expect(memoryTurn([message("ask", "bot", "Check the project"), reply], "b", "turn", false, false, true))
    .toMatchObject({ person: "", owner: false, delegated: true, bot: "Saved the project", sourceMessageId: "reply" });
  expect(memoryTurn([message("old-user", "user", "Unrelated old request"), reply], "b", "turn", false, false, true))
    .toMatchObject({ person: "", owner: false, delegated: true });
});
