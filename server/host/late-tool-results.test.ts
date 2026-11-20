import { describe, expect, it } from "vitest";

import { createLateToolResults, LATE_TOOL_RESULT_MS } from "./late-tool-results.ts";

const turn = { threadId: "t1", botId: "b1", turnId: "turn-1", token: "secret", toolUseIds: new Set(["tool-a", "tool-b"]) };
const bearer = "Bearer secret";

describe("late tool results", () => {
  it("lets an ended turn's bearer save each of its own tool calls once, counting only a save that happened", () => {
    const late = createLateToolResults(() => 0);
    late.turnEnded(turn);
    expect(late.holder(bearer)).toEqual({ botId: "b1", threadId: "t1" });
    expect(late.turnFor(bearer, "t1", "b1", "tool-a")).toBe("turn-1");
    expect(late.turnFor(bearer, "t1", "b1", "tool-a")).toBe("turn-1");
    late.saved("t1", "turn-1", "tool-a");
    expect(late.turnFor(bearer, "t1", "b1", "tool-a")).toBeNull();
    late.saved("t1", "turn-1", "tool-b");
    expect(late.holder(bearer)).toBeNull();
  });

  it("knows no other bearer, conversation, bot or tool call", () => {
    const late = createLateToolResults(() => 0);
    late.turnEnded(turn);
    for (const header of ["Bearer secreT", "Bearer secret ", "secret", undefined, [bearer]]) expect(late.holder(header)).toBeNull();
    expect(late.turnFor(bearer, "t2", "b1", "tool-a")).toBeNull();
    expect(late.turnFor(bearer, "t1", "b2", "tool-a")).toBeNull();
    expect(late.turnFor(bearer, "t1", "b1", "tool-c")).toBeNull();
  });

  it("gives one ended turn's bearer nothing of another turn's tool calls in the same conversation", () => {
    const late = createLateToolResults(() => 0);
    late.turnEnded(turn);
    late.turnEnded({ ...turn, turnId: "turn-2", token: "other", toolUseIds: new Set(["tool-z"]) });
    expect(late.turnFor(bearer, "t1", "b1", "tool-z")).toBeNull();
    expect(late.turnFor("Bearer other", "t1", "b1", "tool-a")).toBeNull();
    expect(late.turnFor("Bearer other", "t1", "b1", "tool-z")).toBe("turn-2");
  });

  it("remembers a revoked generation's hooks bearer for a turn bound after its cleanup, a bounded few, until the conversation's bearers go", () => {
    const late = createLateToolResults(() => 0);
    const hooks = { threadId: "t1", botId: "b1", token: "secret" };
    late.generationRevoked("gen-1", hooks);
    expect(late.revokedHooks("gen-1")).toEqual(hooks);
    for (let i = 0; i < 64; i++) late.generationRevoked(`gen-${i + 2}`, { ...hooks, threadId: "t2" });
    expect(late.revokedHooks("gen-1")).toBeUndefined();
    expect(late.revokedHooks("gen-65")).toBeDefined();
    late.forgetThread("t2");
    expect(late.revokedHooks("gen-65")).toBeUndefined();
  });

  it("ends with its window, when the conversation's bearers are revoked, or when nothing was left to save", () => {
    let now = 0;
    const late = createLateToolResults(() => now);
    late.turnEnded(turn);
    now = LATE_TOOL_RESULT_MS;
    expect(late.holder(bearer)).toBeNull();
    expect(late.turnFor(bearer, "t1", "b1", "tool-a")).toBeNull();

    late.turnEnded(turn);
    late.forgetThread("t1");
    expect(late.turnFor(bearer, "t1", "b1", "tool-a")).toBeNull();

    late.turnEnded({ ...turn, toolUseIds: new Set() });
    expect(late.holder(bearer)).toBeNull();
  });

  it("drops closed windows as later turns end, with no late request to sweep them", () => {
    let now = 0;
    const late = createLateToolResults(() => now);
    for (let i = 0; i < 100; i++) {
      late.turnEnded({ ...turn, turnId: `turn-${i}` });
      now += LATE_TOOL_RESULT_MS;
    }
    expect(late.held).toBe(1);
  });
});
