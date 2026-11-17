import { describe, expect, it } from "vitest";

import { createLateToolResults, LATE_TOOL_RESULT_MS } from "./late-tool-results.ts";

const turn = { threadId: "t1", botId: "b1", turnId: "turn-1", token: "secret", toolUseIds: new Set(["tool-a", "tool-b"]) };

describe("late tool results", () => {
  it("lets an ended turn's bearer save each of its own tool calls once", () => {
    const late = createLateToolResults(() => 0);
    late.turnEnded(turn);
    expect(late.holder("Bearer secret")).toEqual({ botId: "b1", threadId: "t1" });
    expect(late.claim("t1", "b1", "tool-a")).toBe("turn-1");
    expect(late.claim("t1", "b1", "tool-a")).toBeNull();
    expect(late.claim("t1", "b1", "tool-b")).toBe("turn-1");
    expect(late.holder("Bearer secret")).toBeNull();
  });

  it("knows no other bearer, conversation, bot or tool call", () => {
    const late = createLateToolResults(() => 0);
    late.turnEnded(turn);
    for (const header of ["Bearer secreT", "Bearer secret ", "secret", undefined, ["Bearer secret"]]) expect(late.holder(header)).toBeNull();
    expect(late.claim("t2", "b1", "tool-a")).toBeNull();
    expect(late.claim("t1", "b2", "tool-a")).toBeNull();
    expect(late.claim("t1", "b1", "tool-c")).toBeNull();
  });

  it("ends with its window, when the conversation's bearers are revoked, or when nothing was left to save", () => {
    let now = 0;
    const late = createLateToolResults(() => now);
    late.turnEnded(turn);
    now = LATE_TOOL_RESULT_MS;
    expect(late.holder("Bearer secret")).toBeNull();
    expect(late.claim("t1", "b1", "tool-a")).toBeNull();

    late.turnEnded(turn);
    late.forgetThread("t1");
    expect(late.claim("t1", "b1", "tool-a")).toBeNull();

    late.turnEnded({ ...turn, toolUseIds: new Set() });
    expect(late.holder("Bearer secret")).toBeNull();
  });
});
