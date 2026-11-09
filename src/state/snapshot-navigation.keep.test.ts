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

  it("keeps history already loaded when a later snapshot of the same hand-off is only a tail", () => {
    const previous = fixture("work", true);
    previous.messages = [line("work"), line("loaded")];
    previous.hasMore = true;
    const incoming = fixture("work", true);
    incoming.messages = [line("loaded"), line("tail")];
    incoming.hasMore = false;
    const kept = keepBotNavigation(previous, incoming, false);
    expect(kept.threadId).toBe("work");
    expect(kept.messages.map((message) => message.id)).toEqual(["work", "loaded", "tail"]);
    expect(kept.hasMore).toBe(true);
  });

  it("keeps a hand-off and its pending switch until that switch resolves", () => {
    const previous = fixture("work", true);
    previous.switchingTo = "main";
    const kept = keepBotNavigation(previous, fixture("main", true), true);
    expect(kept.threadId).toBe("work");
    expect(kept.switchingTo).toBe("main");
    expect(kept.messages.map((message) => message.id)).toEqual(["work"]);
  });

  it("follows the server when that hand-off no longer exists", () => {
    const incoming = fixture("main");
    incoming.tasks = [{ threadId: "main", title: "Main", createdAt: 1 }];
    expect(keepBotNavigation(fixture("work", true), incoming, false).threadId).toBe("main");
  });
});
