import { describe, expect, it } from "vitest";
import type { Bot, Message } from "./store";
import { keepBotNavigation } from "./snapshot-navigation";

const line = (id: string): Message => ({ id, at: 1, role: "user", kind: "text", text: id, parentId: null });

function fixture(threadId: string, handoff = false): Bot {
  return {
    id: "bot", threadId, name: "Fixture", title: "", description: "", notifications: false,
    unread: false, color: "green", modelSelection: { instanceId: "fake", model: "fixture" },
    messages: [line(threadId)],
    tasks: [
      { threadId: "main", title: "Main", createdAt: 1 },
      { threadId: "work", title: "Work", createdAt: 2, ...(handoff ? { openedBy: { botId: "lead", name: "Lead", at: 2 } } : {}) },
    ],
  };
}

describe("a snapshot must not restore an older transcript over a hand-off the person is reading", () => {
  it("keeps that hand-off when the server still names the bot's previous thread", () => {
    const incoming = fixture("main", true);
    incoming.messages = [line("old-tail")];
    const kept = keepBotNavigation(fixture("work", true), incoming, false);
    expect(kept.threadId).toBe("work");
    expect(kept.messages.map((message) => message.id)).toEqual(["work"]);
  });

  it("follows the server thread when the open chat was not opened by another bot", () => {
    const kept = keepBotNavigation(fixture("work"), fixture("main"), false);
    expect(kept.threadId).toBe("main");
    expect(kept.messages.map((message) => message.id)).toEqual(["main"]);
  });

  it("follows the server when that hand-off no longer exists", () => {
    const incoming = fixture("main");
    incoming.tasks = [{ threadId: "main", title: "Main", createdAt: 1 }];
    expect(keepBotNavigation(fixture("work", true), incoming, false).threadId).toBe("main");
  });
});
