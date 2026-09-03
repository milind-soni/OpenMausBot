import { describe, expect, it, vi } from "vitest";

import { defaultBotRuntimePolicy } from "./bot-runtime-policy.ts";
import { TurnRuntimeLimits } from "./turn-runtime-limits.ts";

describe("TurnRuntimeLimits", () => {
  it("enforces a delegated max-tool override against actual tool starts", () => {
    const limits = new TurnRuntimeLimits();
    const stopped = vi.fn();
    const policy = { ...defaultBotRuntimePolicy(), maxToolAgentSteps: 1 };
    expect(limits.begin("thread", policy, { onHardStop: stopped, onSoftTokenWarning: vi.fn() })).toBe(true);

    limits.recordToolStarted("thread", "tool-1");
    expect(stopped).not.toHaveBeenCalled();
    limits.recordToolStarted("thread", "tool-2");
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool-steps", limit: 1, observed: 2 }));
  });

  it("retains one immutable policy snapshot until settlement", () => {
    const limits = new TurnRuntimeLimits();
    const policy = { ...defaultBotRuntimePolicy(), cumulativeTokenPolicy: { mode: "hard" as const, limit: 2_000 } };
    limits.begin("thread", policy, { onHardStop: vi.fn(), onSoftTokenWarning: vi.fn() });
    policy.maxToolAgentSteps = 99;
    expect(limits.snapshot("thread")?.maxToolAgentSteps).toBe(0);
    limits.settle("thread");
    expect(limits.snapshot("thread")).toBeNull();
  });
});
