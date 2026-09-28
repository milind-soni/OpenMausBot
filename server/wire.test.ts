// Wire projection contract: the server records extend the shared wire
// shapes, and toWireTask emits exactly the wire key set — a server-only
// field (resumeCursors, lastInstanceId) must never reach a client, and a
// new TaskRecord field must fail typecheck until it is declared on
// WireTask or listed in TaskWirePrivateKeys.
import { describe, expect, it } from "vitest";

import {
  botWireProjectionIsExact,
  groupWireProjectionIsExact,
  toWireTask,
  type BotRecord,
  type GroupRecord,
  type Message,
  type TaskRecord,
} from "./store.ts";
import type { WireBot, WireGroup, WireMessage, WireTask } from "../shared/wire.ts";

const fullTask: TaskRecord = {
  threadId: "thread-1",
  title: "Wire projection",
  createdAt: 1234,
  projectId: "proj",
  routineRunId: "run-1",
  openedBy: { botId: "b1", name: "Opener", delegationId: "d1", kind: "pair", at: 1 },
  closedBy: { botId: "b1", name: "Opener", at: 2 },
  archivedAt: 3,
  modelSelection: { instanceId: "claude", model: "m", effort: "high" },
  approvalMode: "ask",
  autoApprove: true,
  alwaysAllow: ["tool"],
  unread: true,
  rewound: true,
  pinnedMessageId: "msg-1",
  activity: "working",
  busy: true,
  surface: "cloud",
  usage: { input: 1, output: 2, cachedInput: 1, costUsd: null, turns: 1, lastTurn: { input: 1, output: 2, costUsd: null }, context: { tokens: 10, window: 100 } },
  cwd: "/tmp",
  resumeCursors: { claude: "cursor" },
  lastInstanceId: "claude",
};

describe("shared wire model", () => {
  it("toWireTask emits exactly the WireTask key set and never the server-private fields", () => {
    const wire = toWireTask(fullTask);
    expect(Object.keys(wire).sort()).toEqual([
      "activity", "alwaysAllow", "approvalMode", "archivedAt", "autoApprove",
      "busy", "closedBy", "createdAt", "cwd", "modelSelection", "openedBy",
      "pinnedMessageId", "projectId", "rewound", "routineRunId", "surface",
      "threadId", "title", "unread", "usage",
    ]);
    expect(wire).not.toHaveProperty("resumeCursors");
    expect(wire).not.toHaveProperty("lastInstanceId");
    expect(wire).toEqual({ ...fullTask, resumeCursors: undefined, lastInstanceId: undefined });
    expect(fullTask.resumeCursors).toEqual({ claude: "cursor" });
    expect(fullTask.lastInstanceId).toBe("claude");
  });

  it("bot and group wire projections stay exact (compile-enforced)", () => {
    // Referencing the guard constants keeps the exactness assertions live:
    // a new BotRecord field fails typecheck until it is declared on WireBot
    // or listed in BotWirePrivateKeys; a group field likewise on WireGroup.
    expect(botWireProjectionIsExact).toBe(true);
    expect(groupWireProjectionIsExact).toBe(true);
  });

  it("server records stay assignable to the shared wire shapes (compile-enforced)", () => {
    const task: WireTask = fullTask;
    const message: Message = { id: "m", role: "bot", kind: "text", text: "hi", at: 1 };
    const wireMessage: WireMessage = message;
    const group: GroupRecord = {
      id: "g", threadId: "t", name: "room", memberIds: [], defaultResponder: { kind: "everyone" },
      bulletin: "", unread: false, createdAt: 1,
    };
    const wireGroup: WireGroup = { ...group, working: true };
    const bot: BotRecord = {
      id: "b", threadId: "t", name: "Bot", title: "", description: "", notifications: true,
      color: "green", unread: false, modelSelection: { instanceId: "claude", model: "m" },
      resumeCursors: {}, createdAt: 1,
    };
    const wireBot: WireBot = { ...bot, avatarUrl: bot.avatarUrl ?? null, tasks: [] };
    expect([task.threadId, wireMessage.role, wireGroup.working, wireBot.avatarUrl]).toEqual(["thread-1", "bot", true, null]);
  });
});
