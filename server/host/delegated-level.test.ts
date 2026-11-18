import { describe, expect, it, vi } from "vitest";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord } from "../store.ts";
import { createDelegatedLevel, type DelegatedLevelDeps, type Hop } from "./delegated-level.ts";

// Clive (a Chief) handed work to Ada, and Ada's turn hands work on: the chain is the hand-off nodes' parents.
function world(levels: Record<string, ApprovalMode>, nodes: Record<string, Hop>, guest = new Set<string>(), outside = new Set<string>()) {
  const bots: Record<string, Partial<BotRecord>> = {
    clive: { id: "clive", name: "Clive", chiefOfStaff: true }, ada: { id: "ada", name: "Ada" }, bea: { id: "bea", name: "Bea" }, ola: { id: "ola", name: "Ola" },
  };
  const patched: Array<{ botId: string; threadId: string; approvalMode?: ApprovalMode }> = [];
  const lines: string[] = [];
  const store = {
    bot: (id: string) => bots[id],
    projectBotForTask: () => undefined,
    taskByThread: () => undefined,
    patchTask: (botId: string, threadId: string, patch: { approvalMode?: ApprovalMode }) => { patched.push({ botId, threadId, ...patch }); },
    appendMessage: (_threadId: string, message: { tool?: { name: string } }) => { lines.push(message.tool!.name); },
  } as unknown as DelegatedLevelDeps["store"];
  const level = (botId: string, threadId: string) => levels[`${botId}:${threadId}`] ?? levels[botId] ?? "ask";
  const sourceLevel = vi.fn(level);
  const delegated = createDelegatedLevel({
    store, node: id => nodes[id], sourceLevel, turnLevel: (bot, _peer, threadId) => level(bot.id, threadId),
    driverKind: () => "claudeAgent", guestDriven: threadId => guest.has(threadId), handsNoLevel: threadId => outside.has(threadId),
  });
  return { ...delegated, patched, lines, sourceLevel, bot: (id: string) => bots[id] as BotRecord };
}

const chain: Record<string, Hop> = {
  root: { botId: "clive", threadId: "clive-chat" },
  "to-ada": { botId: "ada", threadId: "ada-work", parentId: "root" },
  "room-root": { botId: "clive", threadId: "room" },
  "room-ada": { botId: "ada", threadId: "room", parentId: "room-root" },
  loop: { botId: "ola", threadId: "ola-chat", parentId: "loop" },
};

describe("a Chief's level, every hop down", () => {
  it("allows a live source reader to resolve a notice returning to the Chief's conversation", () => {
    const w = world({ "clive:clive-chat": "ask" }, chain);
    const own = () => w.roomTurn(w.bot("clive"), "clive-chat", chain["to-ada"]);
    w.sourceLevel.mockImplementation(own);
    expect(own()).toBe("ask");
    expect(w.sourceLevel).not.toHaveBeenCalled();
  });

  it.each(["root", "to-ada"])("keeps the Chief's own level without reading a self-inherited grant from %s", sourceId => {
    const w = world({ "clive:clive-chat": "auto", "clive:room": "edits" }, chain);
    const source = chain[sourceId]!;
    w.apply(w.bot(source.botId), source.threadId, sourceId, w.bot("clive"), "clive-chat");
    expect(w.roomTurn(w.bot("clive"), "room", source)).toBe("edits");
    expect(w.levelOf({ botId: "clive", threadId: "clive-chat" }, source)).toEqual({ level: "auto", driverKind: "claudeAgent" });
    expect(w.sourceLevel).not.toHaveBeenCalled();
    expect(w.patched).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it("does not read a grant when the immediate sender is the recipient below a Chief", () => {
    const w = world({ "clive:clive-chat": "full", "ada:ada-work": "ask" }, chain);
    w.apply(w.bot("ada"), "ada-work", "to-ada", w.bot("ada"), "ada-other");
    expect(w.sourceLevel).not.toHaveBeenCalled();
    expect(w.patched).toEqual([]);
  });

  it("switches the thread of a teammate's teammate to the Chief conversation's level, and an ordinary bot passes nothing", () => {
    const w = world({ "clive:clive-chat": "auto", ola: "full" }, chain);
    w.apply(w.bot("clive"), "clive-chat", "root", w.bot("ada"), "ada-work");
    w.apply(w.bot("ada"), "ada-work", "to-ada", w.bot("bea"), "bea-work");
    w.apply(w.bot("ola"), "ola-chat", "loop", w.bot("bea"), "bea-other");
    expect(w.patched).toEqual([
      { botId: "ada", threadId: "ada-work", approvalMode: "auto", autoApprove: false, alwaysAllow: [] },
      { botId: "bea", threadId: "bea-work", approvalMode: "auto", autoApprove: false, alwaysAllow: [] },
    ]);
    expect(w.lines).toEqual([
      "Approve for me — handed on by Clive, a Chief of Staff on Approve for me",
      "Approve for me — handed on by Ada, from Clive, a Chief of Staff on Approve for me",
    ]);
  });

  it("brings nothing down from work that came in from outside: the teammate keeps its own level", () => {
    const w = world({ "clive:clive-chat": "full" }, chain, new Set(), new Set(["clive-chat"]));
    w.apply(w.bot("clive"), "clive-chat", "root", w.bot("ada"), "ada-work");
    expect(w.patched).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(w.levelOf({ botId: "ada", threadId: "ada-work" }, chain["to-ada"]).chief).toBeUndefined();
    const below = world({ "clive:clive-chat": "full", "ada:ada-work": "ask" }, chain, new Set(), new Set(["ada-work"]));
    below.apply(below.bot("ada"), "ada-work", "to-ada", below.bot("bea"), "bea-work");
    expect(below.patched).toEqual([]);
  });

  it("runs a room turn at the level its hand-off's chain brings down, and a guest's room at Ask", () => {
    const w = world({ "clive:room": "full" }, chain);
    expect(w.roomTurn(w.bot("bea"), "room", chain["room-ada"])).toBe("full");
    expect(w.roomTurn(w.bot("bea"), "room", undefined)).toBe("ask");
    expect(world({ "clive:room": "full" }, chain, new Set(["room"])).roomTurn(w.bot("bea"), "room", chain["room-ada"])).toBe("ask");
  });

  it("gives the runtime the Chief conversation's level only when the target runs at what the chain brought down", () => {
    const lifted = world({ "clive:room": "auto" }, chain);
    expect(lifted.levelOf({ botId: "bea", threadId: "room", groupId: "g" }, chain["room-ada"])).toEqual({ level: "auto", chief: "auto", driverKind: "claudeAgent" });
    // Already higher than the chain, or confined to Ask: the record says what runs, and no Chief level.
    expect(world({ "clive:room": "auto", bea: "full" }, chain).levelOf({ botId: "bea", threadId: "room", groupId: "g" }, chain["room-ada"]))
      .toEqual({ level: "full", driverKind: "claudeAgent" });
    expect(world({ "clive:room": "auto" }, chain, new Set(["room"])).levelOf({ botId: "bea", threadId: "room", groupId: "g" }, chain["room-ada"]))
      .toEqual({ level: "ask", driverKind: "claudeAgent" });
  });
});
