import { describe, expect, it } from "vitest";

import type { UsageRow } from "../usage-ledger.ts";
import { notBilledShare } from "./usage.ts";

const row = (instanceId: string, costUsd: number | null): UsageRow => ({
  at: "2026-09-15T08:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId, driverKind: "claudeAgent", model: "m", input: 10, output: 5, costUsd, trigger: { kind: "owner" },
});

describe("the part of a period's dollars nobody is billed", () => {
  it("adds up only priced turns on engines signed in with a subscription, asking about each engine once", () => {
    const asked: string[] = [];
    const onPlan = (instanceId: string) => { asked.push(instanceId); return instanceId === "claude"; };
    const rows = [row("claude", 0.5), row("claude", 0.25), row("claude", null), row("claude", 0), row("openai", 2), row("openai", 1)];
    expect(notBilledShare(rows, onPlan)).toEqual({ usd: 0.75, turns: 2 });
    expect(asked).toEqual(["claude", "openai"]);
    expect(notBilledShare([], onPlan)).toEqual({ usd: 0, turns: 0 });
  });
});
