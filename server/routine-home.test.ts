import { describe, expect, it } from "vitest";

import { routineHome } from "./routine-home.ts";

const PRIVATE: Record<string, string> = { "bob-chat": "p_bob", "bob-results": "p_bob", "ben-chat": "p_ben" };
const TASKS: Record<string, { title: string; askedAt?: number }> = {
  "bob-chat": { title: "Bob's plans" },
  "bob-results": { title: "Standup · Results" },
  "main": { title: "Shared chat" },
};
const deps = { privateTo: (threadId: string) => PRIVATE[threadId] ?? null, task: (_botId: string, threadId: string) => TASKS[threadId] };

describe("routineHome", () => {
  it("is the person whose private chat it was made in, whatever it reports to", () => {
    expect(routineHome({ botId: "scout", sourceThreadId: "bob-chat", resultsThreadId: "main" }, deps)).toBe("p_bob");
  });

  it("is the person whose private chat it reports into", () => {
    expect(routineHome({ botId: "scout", name: "Kumquat", resultsThreadId: "bob-chat" }, deps)).toBe("p_bob");
  });

  it("is nobody's for one made in a shared chat, or reporting into the chat it opened for itself", () => {
    expect(routineHome({ botId: "scout", sourceThreadId: "main" }, deps)).toBeNull();
    expect(routineHome({ botId: "scout", name: "Standup", resultsThreadId: "bob-results" }, deps)).toBeNull();
    expect(routineHome({ botId: "scout", name: "Standup" }, deps)).toBeNull();
  });

  it("is the person's once they have written in the chat it opened for itself", () => {
    TASKS["bob-results"]!.askedAt = 1;
    try {
      expect(routineHome({ botId: "scout", name: "Standup", resultsThreadId: "bob-results" }, deps)).toBe("p_bob");
    } finally {
      delete TASKS["bob-results"]!.askedAt;
    }
  });
});
